import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FileStore } from "../src/storage.js";
import { createHttpHandler } from "../src/index.js";
import type { ReviewPlan } from "../src/review-schema.js";
import type { reviewAnswer } from "../src/review.js";

// Real anonymous loopback HTTP MCP; isolated files, anonymous synthetic content, no external API calls.
const root = path.resolve(process.argv[2] ?? "output/review-smoke");
await fs.mkdir(root, { recursive: true });
const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
const listener = createServer(createHttpHandler(store, { HOST: "127.0.0.1", PORT: "8787", MCP_ALLOW_ANONYMOUS_LOOPBACK: "true" }));
listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const address = listener.address(); assert.ok(address && typeof address !== "string");
const client = new Client({ name: "anonymous-synthetic-review-smoke", version: "1" });
type Report = ReturnType<typeof reviewAnswer>;
const call = async <T>(name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result.content)); return result.structuredContent as T;
};
const counts = [3, 3, 2, 3];
const inputs = counts.map((count, q) => ({ templateId: "police_information_essay", questionNo: q + 1,
  title: `匿名合成測試第${q + 1}題`, question: `本題包含${count}個獨立合成小問，僅用於驗證程式。`,
  sections: Array.from({ length: count }, (_, i) => ({ id: `part-${i + 1}`, heading: `小問${i + 1}`,
    text: `第${q + 1}題第${i + 1}小問的合成測試文字。` })),
  lineTargets: Array.from({ length: count }, (_, i) => ({ sectionId: `part-${i + 1}`, lines: 2 })),
}));
const makePlan = (index: number): ReviewPlan => ({ requirements: inputs[index].sections.map((s, i) => ({ id: `r${i + 1}`,
  prompt: `回答第${i + 1}個合成小問`, sectionIds: [s.id], sourceIds: ["reference"], points: 1 })),
  sources: [{ id: "reference", locator: "fixture://anonymous-reference#1", role: "required" }], scoring: { total: counts[index], mode: "additive" } });
const manifest: Record<string, unknown> = { synthetic: true, transport: "StreamableHTTP", anonymousLoopback: true, questions: 4, subquestions: 11,
  paper165: "not_checked: approved MOE font unavailable; explicit general template used", visual: "not_checked" };
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));
  const schema = await client.readResource({ uri: "essay://schemas/review-plan" });
  assert.equal(JSON.parse((schema.contents[0] as { text: string }).text).type, "object");
  const { examId } = await call<{ examId: string }>("start_exam", { title: "匿名合成驗收流程", questions: inputs.map(q => ({ questionNo: q.questionNo, question: q.question })) });
  const created = await call<{ answers: Array<{ answerId: string; version: number }> }>("create_answers", { examId, answers: inputs });
  const answerIds = created.answers.map(a => a.answerId); manifest.created = created;
  const legacy = await call<Report>("review_answer", { answerId: answerIds[0] }); assert.equal(legacy.status, "not_checked"); manifest.noManifest = legacy;
  const plans = counts.map((_, i) => makePlan(i));
  // A normal mapped case still has pending content/source/visual review. Record only the fixture scope comparison.
  const evidence = { status: "checked", method: "model", reviewer: "synthetic-fixture-harness",
    note: "Compared all declared subquestions with the original synthetic input fixture; none omitted from this manifest.", checkedAt: new Date().toISOString() } as const;
  plans[0].scopeReview = evidence;
  plans[1].requirements[1].sectionIds = []; // Omitted answer.
  plans[3].requirements.forEach((r, i) => r.points = [2, 3, 2][i]); plans[3].scoring!.total = 5;
  plans[3].scan = { expectedPages: 3, pages: [{ page: 1, status: "content" }, { page: 2, status: "blank" }] };
  const reports: Report[] = [];
  for (let i = 0; i < 4; i++) reports.push(await call<Report>("set_answer_review", { answerId: answerIds[i], expectedVersion: 1, plan: plans[i] }));
  assert.equal(reports[0].structuralStatus, "no_structural_issues"); assert.equal(reports[0].status, "pending"); assert.equal(reports[0].semantic, "not_checked");
  assert.ok(reports[1].issues.some(i => i.code === "REQUIRED_UNCOVERED"));
  assert.ok(reports[2].issues.some(i => i.code === "SOURCE_REVIEW_PENDING"));
  assert.ok(reports[3].issues.some(i => i.code === "SCORING_CONFLICT"));
  assert.deepEqual(reports[3].issues.filter(i => i.code === "SCAN_PAGE_PENDING").map(i => i.page), [2, 3]);
  manifest.initialReports = reports;
  for (const args of [{ expectedVersion: 1, plan: plans[0] }, { expectedVersion: 2, plan: { ...plans[0], autoApprove: true } }]) {
    const rejected = await client.callTool({ name: "set_answer_review", arguments: { answerId: answerIds[0], ...args } }); assert.equal(rejected.isError, true);
  }
  assert.equal((await store.getAnswer(answerIds[0])).version, 2);
  await call("replace_text", { answerId: answerIds[0], expectedVersion: 2, sectionId: "part-1", newText: "修訂後的匿名合成測試文字。" });
  const stale = await call<Report>("review_answer", { answerId: answerIds[0], expectedVersion: 3 }); assert.equal(stale.freshness, "stale");
  manifest.afterUpdate = stale;
  // Clear the old attestations rather than pretending they apply after the edit.
  await call("set_answer_review", { answerId: answerIds[0], expectedVersion: 3, plan: makePlan(0) });
  await call("render_exam_overview", { examId });
  const bundle = await call<{ files: Array<{ format: string; pages: number; exportUri: string; fontWarning?: string }> }>("export_exam_bundle", { examId });
  manifest.exports = [];
  for (const file of bundle.files) {
    const artifact = await store.readExport(file.exportUri.split("/").at(-1)!);
    const filename = `anonymous-review-exam.${file.format}`; await fs.writeFile(path.join(root, filename), artifact.data);
    (manifest.exports as unknown[]).push({ filename, pages: file.pages, bytes: artifact.data.length, sha256: createHash("sha256").update(artifact.data).digest("hex"), fontWarning: file.fontWarning ?? null });
  }
  const progress = await call<{ nextStep: { action: string }; delivery: { status: string; checks: Record<string, string> } }>("get_exam_progress", { examId });
  assert.equal(progress.nextStep.action, "done"); assert.equal(progress.delivery.status, "awaiting_review");
  assert.deepEqual(progress.delivery.checks, { layoutCapacity: "passed", content: "not_checked", source: "not_checked", visual: "not_checked" });
  manifest.progress = progress;
  await fs.writeFile(path.join(root, "evidence.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`REVIEW_HTTP_SMOKE_OK questions=4 subquestions=11 exports=${bundle.files.map(f => f.format).join(",")} output=${root}`);
} finally {
  await client.close(); listener.closeAllConnections(); await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
}
