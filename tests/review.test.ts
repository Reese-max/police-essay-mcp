import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnswerDocument, answerDocumentSchema, MAX_ANSWER_BYTES, type AnswerDocument } from "../src/domain.js";
import { reviewPlanSchema, type ReviewPlan } from "../src/review-schema.js";
import { reviewAnswer, reviewFingerprint } from "../src/review.js";
import { decodeAnswer, encodeAnswer } from "../src/answer-codec.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import { CloudStore } from "../src/cloud-storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";
import { layoutSections } from "../src/layout.js";

const templates = path.resolve("templates");
const template = JSON.parse(await fs.readFile(path.join(templates, "police_information_essay.json"), "utf8"));
const evidence = { status: "checked", method: "human", reviewer: "synthetic-reviewer",
  note: "Compared this synthetic definition and example with the fixture source.", checkedAt: "2026-01-01T00:00:00.000Z" } as const;
const sample = () => ({ ...createAnswerDocument({ templateId: template.id, title: "Anonymous review fixture", question: "Define A and compare B.",
  sections: [{ id: "a", heading: "Definition", text: "A definition and a concrete example." }, { id: "b", heading: "Comparison", text: "B uses a different comparison dimension." }] }),
  lineTargets: { a: 2, b: 2 } });
const plan = (): ReviewPlan => ({ requirements: [
  { id: "r1", prompt: "Define A with an example", sectionIds: ["a"], sourceIds: ["s1"], points: 2, review: evidence },
  { id: "r2", prompt: "Compare B on the requested dimension", sectionIds: ["b"], sourceIds: ["s1"], points: 3, review: evidence },
], sources: [{ id: "s1", locator: "fixture://synthetic-reference#definitions", role: "required", review: evidence }],
  scoring: { total: 5, mode: "additive" }, scopeReview: evidence, visualReview: evidence,
  scan: { expectedPages: 1, pages: [{ page: 1, status: "content" }] } });
function reviewed(answer: AnswerDocument = sample(), reviewPlan = plan()): AnswerDocument {
  return { ...answer, review: { plan: reviewPlanSchema.parse(reviewPlan), reviewedVersion: answer.version, fingerprint: reviewFingerprint(answer, template) } };
}
const report = (answer: AnswerDocument) => reviewAnswer(answer, template, layoutSections(template, answer.sections, answer.layoutOptions));
const codes = (answer: AnswerDocument) => report(answer).issues.map(i => i.code);

test("legacy answers remain unknown; mappings and recorded reviews never imply server semantic/source verification", () => {
  assert.equal(report(sample()).status, "not_checked");
  assert.equal(report(sample()).structuralStatus, "not_checked");
  const result = report(reviewed());
  assert.equal(result.status, "review_recorded"); assert.equal(result.freshness, "current");
  assert.equal(result.structuralStatus, "no_structural_issues");
  assert.equal(result.semantic, "not_checked"); assert.equal(result.sourceVerification, "not_checked");
  assert.ok(result.requirements.every(r => r.semantic === "not_checked" && r.reportedReview === "recorded"));
});

test("keywords, headings and nonempty unrelated text cannot pass content review", () => {
  const input = plan(); delete input.requirements[0].review; delete input.scopeReview;
  const answer = sample(); answer.sections[0].text = "Define A with an example"; delete answer.sections[0].paragraphs;
  const result = report(reviewed(answer, input));
  assert.equal(result.requirements[0].coverage, "mapped");
  assert.equal(result.requirements[0].semantic, "not_checked");
  assert.ok(result.issues.some(i => i.code === "CONTENT_REVIEW_PENDING" && i.requirementId === "r1"));
  assert.ok(result.issues.some(i => i.code === "SCOPE_REVIEW_PENDING"));
  assert.equal(result.status, "pending");
});

test("required unmapped, deleted and heading-only sections are uncovered; optional unmapped is visible", () => {
  const p = plan(); p.requirements[0].sectionIds = []; p.requirements[1].sectionIds = ["gone"];
  p.requirements.push({ id: "optional", prompt: "Optional note", required: false, sectionIds: [] });
  const result = report(reviewed(sample(), p));
  assert.equal(result.issues.filter(i => i.code === "REQUIRED_UNCOVERED").length, 2);
  assert.equal(result.structuralStatus, "issues_found");
  const blank = sample(); blank.sections[0].text = "  \n"; delete blank.sections[0].paragraphs;
  assert.equal(report(reviewed(blank)).requirements[0].coverage, "empty");
  const legacy = sample(); legacy.sections[0].paragraphs = [{ text: " " }];
  assert.equal(report(reviewed(legacy)).requirements[0].coverage, "empty", "canonical text cannot mask a blank rendered paragraph in older data");
});

test("additive conflicts, missing components and ambiguous overlap remain distinct; decimals use tolerance", () => {
  const p = plan(); p.scoring!.total = 4;
  assert.equal(report(reviewed(sample(), p)).scoring.status, "conflict");
  p.scoring!.mode = "unknown"; assert.equal(report(reviewed(sample(), p)).scoring.status, "pending");
  p.scoring!.mode = "overlapping"; assert.equal(report(reviewed(sample(), p)).scoring.status, "pending");
  p.scoring!.mode = "additive"; delete p.requirements[1].points;
  assert.equal(report(reviewed(sample(), p)).scoring.status, "pending");
  p.requirements[0].points = 0.1; p.requirements[1].points = 0.2; p.scoring!.total = 0.3;
  assert.equal(report(reviewed(sample(), p)).scoring.status, "consistent");
});

test("source locators and supplemental references cannot silently replace missing required source review", () => {
  const p = plan(); delete p.sources![0].review;
  p.sources!.push({ id: "extra", locator: "fixture://supplement", role: "supplemental", review: evidence });
  const result = report(reviewed(sample(), p));
  assert.ok(result.issues.some(i => i.code === "SOURCE_REVIEW_PENDING" && i.sourceId === "s1"));
  assert.equal(result.sources[0].verification, "not_checked");
  p.sources![0].role = "supplemental"; // It still supports required claims.
  assert.ok(codes(reviewed(sample(), p)).includes("SOURCE_REVIEW_PENDING"));
  p.sources![0].review = { ...evidence, status: "rejected" };
  assert.equal(report(reviewed(sample(), p)).sources[0].reportedReview, "rejected");
  delete p.requirements[0].sourceIds;
  assert.ok(codes(reviewed(sample(), p)).includes("SOURCE_LINK_MISSING"));
});

test("blank, unreadable, explicitly missing and absent scan pages are pending; no scan remains not_checked", () => {
  const p = plan(); p.scan = { expectedPages: 5, pages: [{ page: 1, status: "content" }, { page: 2, status: "blank" },
    { page: 3, status: "unreadable" }, { page: 4, status: "missing" }] };
  const result = report(reviewed(sample(), p));
  assert.deepEqual(result.issues.filter(i => i.code === "SCAN_PAGE_PENDING").map(i => i.page), [2, 3, 4, 5]);
  assert.equal(result.scan.status, "pending");
  delete p.scan; assert.equal(report(reviewed(sample(), p)).scan.status, "not_checked");
});

test("edits, version changes, identity and template changes invalidate every reported review", () => {
  const answer = reviewed();
  for (const changed of [{ ...answer, version: 2 }, { ...answer, id: "ans_copy" }, { ...answer, question: "Changed question" },
    { ...answer, sections: answer.sections.map(s => ({ ...s, text: "New unrelated text", paragraphs: undefined })) }]) {
    const result = report(changed);
    assert.equal(result.freshness, "stale"); assert.equal(result.sources[0].reportedReview, "stale");
    assert.equal(result.visualReview, "stale"); assert.equal(result.scopeReview, "stale"); assert.ok(result.issues.some(i => i.code === "REVIEW_STALE"));
  }
  const changedTemplate = { ...template, fontSizePt: template.fontSizePt + 1 };
  assert.equal(reviewAnswer(answer, changedTemplate, layoutSections(changedTemplate, answer.sections)).freshness, "stale");
});

test("line allocation is reported from actual layout, without inventing an optimal score ratio", () => {
  const answer = sample(); answer.lineTargets = { a: 1, b: 3 };
  assert.equal(report(reviewed(answer)).allocation.status, "needs_review");
  assert.ok(codes(reviewed(answer)).includes("ALLOCATION_REVIEW"));
  delete (answer as AnswerDocument).lineTargets;
  assert.equal(report(reviewed(answer)).allocation.status, "not_checked");
});

test("a shared section cannot silently count as independent coverage for several subquestions", () => {
  const p = plan(); p.requirements[1].sectionIds = ["a"];
  const result = report(reviewed(sample(), p));
  assert.ok(result.issues.some(i => i.code === "SHARED_SECTION_MAPPING"));
  assert.equal(result.status, "pending");
});

test("strict manifests reject duplicate ids, unknown sources/pages, invalid evidence and extra keys", () => {
  const p = plan();
  for (const invalid of [ { ...p, requirements: [...p.requirements, p.requirements[0]] },
    { ...p, sources: [...p.sources!, p.sources![0]] },
    { ...p, requirements: [{ ...p.requirements[0], sourceIds: ["unknown"] }] },
    { ...p, requirements: [{ ...p.requirements[0], sectionIds: ["a", "a"] }] },
    { ...p, scan: { expectedPages: 1, pages: [{ page: 2, status: "content" }] } },
    { ...p, scan: { expectedPages: 2, pages: [{ page: 1, status: "content" }, { page: 1, status: "content" }] } },
    { ...p, scopeReview: { ...evidence, note: " " } }, { ...p, autoPass: true } ])
    assert.equal(reviewPlanSchema.safeParse(invalid).success, false);
});

test("new review envelope stays old-readable and opaque metadata survives writeback and clearing", () => {
  const answer = reviewed(); const raw = { ...encodeAnswer(answer), futureMetadata: { retained: true } };
  const oldReader = answerDocumentSchema.omit({ review: true });
  assert.equal(oldReader.parse(raw).id, answer.id); assert.equal(Object.hasOwn(oldReader.parse(raw), "review"), false);
  assert.deepEqual(decodeAnswer(raw), answer);
  const changed = encodeAnswer({ ...answer, title: "Updated", version: 2 }, raw);
  assert.deepEqual(changed.futureMetadata, { retained: true }); assert.equal(report(decodeAnswer(changed)).freshness, "stale");
  const cleared = encodeAnswer({ ...answer, review: undefined }, raw);
  assert.equal(decodeAnswer(cleared).review, undefined); assert.deepEqual(cleared.futureMetadata, raw.futureMetadata);
});

const releasedCodec = path.resolve(process.env.REVIEW_RELEASED_SOURCE ?? "../released-main", "src/answer-codec.ts");
test("actual released main codec reads new answers and preserves opaque review on old-writer edits", {
  skip: !existsSync(releasedCodec) && "set REVIEW_RELEASED_SOURCE to the a3792bb release checkout",
}, async () => {
  const old = await import(pathToFileURL(releasedCodec).href);
  const answer = reviewed(); const raw = { ...encodeAnswer(answer), futureMetadata: { retained: true } };
  const legacyAnswer = old.decodeAnswer(raw);
  assert.equal(legacyAnswer.review, undefined);
  assert.equal(legacyAnswer.templateId, "police_information_essay");
  const rewritten = old.encodeAnswer({ ...legacyAnswer, version: 2, title: "Old-writer update" }, raw);
  assert.deepEqual(rewritten.review, raw.review); assert.deepEqual(rewritten.futureMetadata, raw.futureMetadata);
  assert.equal(report(decodeAnswer(rewritten)).freshness, "stale");
  assert.deepEqual(decodeAnswer(rewritten).sections, answer.sections);
});

async function withClient(run: (client: Client, store: FileStore) => Promise<void>, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-review-"));
  const store = new FileStore({ templateDir: templates, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store, options); const client = new Client({ name: "review-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  try { await run(client, store); } finally { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const data = <T>(result: Awaited<ReturnType<Client["callTool"]>>) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent as T;
};

test("real MCP create → review save → update → stale review → export preserves sections, version and old export contract", async () => withClient(async (client, store) => {
  const created = data<{ answer: { id: string } }>(await client.callTool({ name: "create_answer", arguments: {
    templateId: template.id, title: "Anonymous end-to-end", question: sample().question, sections: sample().sections, lineTargets: [{ sectionId: "a", lines: 2 }, { sectionId: "b", lines: 2 }],
  } }));
  const answerId = created.answer.id;
  const saved = data<ReturnType<typeof report>>(await client.callTool({ name: "set_answer_review", arguments: { answerId, expectedVersion: 1, plan: plan() } }));
  assert.equal(saved.version, 2); assert.equal(saved.status, "review_recorded");
  assert.deepEqual((await store.getRevision(answerId, 2)).review?.plan, plan());
  const staleWrite = await client.callTool({ name: "set_answer_review", arguments: { answerId, expectedVersion: 1, plan: plan() } });
  assert.equal(staleWrite.isError, true); assert.equal((await store.getAnswer(answerId)).version, 2);
  const updated = await client.callTool({ name: "replace_text", arguments: { answerId, expectedVersion: 2, sectionId: "a", newText: "Changed definition with a concrete example." } });
  assert.equal(updated.isError, undefined);
  const stale = data<ReturnType<typeof report>>(await client.callTool({ name: "review_answer", arguments: { answerId, expectedVersion: 3 } }));
  assert.equal(stale.freshness, "stale");
  assert.equal((await client.callTool({ name: "review_answer", arguments: { answerId, expectedVersion: 2 } })).isError, true);
  const exported = data<{ files: Array<{ format: string }> }>(await client.callTool({ name: "export_answer", arguments: { answerId, expectedVersion: 3, formats: ["pdf", "docx"] } }));
  assert.deepEqual(exported.files.map(f => f.format), ["pdf", "docx"]);
  assert.equal((await store.getAnswer(answerId)).version, 3);
  const copy = data<{ answer: { id: string } }>(await client.callTool({ name: "duplicate_answer", arguments: { answerId } }));
  assert.equal((await store.getAnswer(copy.answer.id)).review, undefined);
  await client.callTool({ name: "restore_revision", arguments: { answerId, expectedVersion: 3, version: 1 } });
  assert.equal((await store.getAnswer(answerId)).version, 4);
  assert.equal(data<ReturnType<typeof report>>(await client.callTool({ name: "review_answer", arguments: { answerId } })).freshness, "stale");
  const clear = data<ReturnType<typeof report>>(await client.callTool({ name: "set_answer_review", arguments: { answerId, expectedVersion: 4, plan: null } }));
  assert.equal(clear.version, 5); assert.equal(clear.freshness, "not_checked");
  assert.equal((await store.getAnswer(answerId)).sections[0].text, sample().sections[0].text);
}));

test("real MCP rejects malformed manifests and dangling section references without writing", async () => withClient(async (client, store) => {
  const answer = sample(); await store.saveAnswer(answer);
  for (const input of [{ ...plan(), requirements: [{ id: "r", prompt: "Missing", sectionIds: ["absent"] }] }, { ...plan(), unexpected: true }]) {
    const result = await client.callTool({ name: "set_answer_review", arguments: { answerId: answer.id, expectedVersion: 1, plan: input } });
    assert.equal(result.isError, true); assert.equal((await store.getAnswer(answer.id)).version, 1);
  }
  const resource = await client.readResource({ uri: "essay://schemas/review-plan" });
  assert.deepEqual(JSON.parse((resource.contents[0] as { text: string }).text).required, ["requirements"]);
}));

test("concurrent review writes use CAS, and an oversized manifest writes no answer or revision", async () => withClient(async (client, store) => {
  const answer = sample(); await store.saveAnswer(answer);
  const args = { answerId: answer.id, expectedVersion: 1, plan: plan() };
  const results = await Promise.all([1, 2].map(() => client.callTool({ name: "set_answer_review", arguments: args })));
  assert.equal(results.filter(r => r.isError).length, 1); assert.equal((await store.getAnswer(answer.id)).version, 2);
  const huge: ReviewPlan = { requirements: Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, prompt: "x".repeat(1000), sectionIds: ["a"], sourceIds: ["s0"], review: { ...evidence, note: "x".repeat(2000) } })),
    sources: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, locator: "x".repeat(2000), role: "required", review: { ...evidence, note: "x".repeat(2000) } })) };
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) > MAX_ANSWER_BYTES);
  const rejected = await client.callTool({ name: "set_answer_review", arguments: { answerId: answer.id, expectedVersion: 2, plan: huge } });
  assert.equal(rejected.isError, true); assert.match(JSON.stringify(rejected.content), /700 KiB/);
  assert.equal((await store.getAnswer(answer.id)).version, 2); await assert.rejects(store.getRevision(answer.id, 3));
}));

test("read-only and independent OAuth scopes expose structural review but cannot save evidence", async () => {
  for (const options of [{ readOnly: true }, { scopes: ["essay.read"] }, { scopes: ["essay.read", "essay.export"] }])
    await withClient(async (client, store) => {
      const answer = sample(); await store.saveAnswer(answer);
      const names = (await client.listTools()).tools.map(t => t.name);
      assert.ok(names.includes("review_answer")); assert.ok(!names.includes("set_answer_review"));
      assert.equal((await client.callTool({ name: "set_answer_review", arguments: { answerId: answer.id, expectedVersion: 1, plan: plan() } })).isError, true);
      assert.equal((await store.getAnswer(answer.id)).version, 1);
      assert.equal(data<ReturnType<typeof report>>(await client.callTool({ name: "review_answer", arguments: { answerId: answer.id } })).status, "not_checked");
    }, options);
});

test("cloud adapter persists review evidence and revisions under existing owner isolation (fake clients)", async () => {
  const firestore = new MemoryFirestore(); const storage = new MemoryStorage();
  const cloud = (ownerKey = "a".repeat(64)) => new CloudStore({ firestore: firestore.client(), storage: storage.client(),
    environment: "staging", ownerKey, artifactBucket: "synthetic-artifacts", templateDir: templates });
  const answer = sample(); await cloud().saveAnswer(answer);
  const second = reviewed({ ...answer, version: 2 }); await cloud().saveAnswer(second, { expectedVersion: 1 });
  assert.equal(report(await cloud().getAnswer(answer.id)).freshness, "current");
  assert.deepEqual((await cloud().getRevision(answer.id, 2)).review, second.review);
  await assert.rejects(cloud("b".repeat(64)).getAnswer(answer.id));
  await cloud().saveAnswer({ ...second, version: 3, question: "Updated" }, { expectedVersion: 2 });
  assert.equal(report(await cloud().getAnswer(answer.id)).freshness, "stale");
});
