import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudStore } from "../src/cloud-storage.js";
import { createAnswerDocument, type AnswerDocument, type ParagraphFormatInput } from "../src/domain.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(projectRoot, "templates");
const templateId = "police_information_essay";
const invalidCases: Array<{ name: string; format: ParagraphFormatInput }> = [
  { name: "indent equals the full 42-column width", format: { leftIndent: 42 } },
  { name: "combined indents consume the full width", format: { leftIndent: 20, rightIndent: 20, firstLineIndent: 2 } },
  { name: "one available column cannot hold a CJK character", format: { leftIndent: 41 } },
];
const layoutError = /縮排|可用寬度/;
const originalText = "自有中文原文，應保留𠮷與換行。";

function answer(title = "自有排版測試"): AnswerDocument {
  return createAnswerDocument({ templateId, title, sections: [{ id: "body", text: originalText }] });
}

function withFormat(document: AnswerDocument, format: ParagraphFormatInput): AnswerDocument {
  return { ...document, sections: document.sections.map(section => ({ ...section, paragraphFormat: format })) };
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
function text(result: ToolResult): string {
  return (result.content as Array<{ text?: string }>).map(item => item.text ?? "").join("\n");
}
function structured<T>(result: ToolResult): T {
  assert.notEqual(result.isError, true, text(result));
  return result.structuredContent as T;
}
function assertToolError(result: ToolResult, pattern: RegExp): void {
  assert.equal(result.isError, true, text(result));
  assert.match(text(result), pattern);
}

async function filesUnder(directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function visit(current: string) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) result[path.relative(directory, filename)] = (await fs.readFile(filename)).toString("base64");
    }
  }
  await visit(directory);
  return result;
}

async function withFileStore(run: (store: FileStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-format-recovery-"));
  const store = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  try {
    await store.ensureDirectories();
    await run(store, root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function withClient(store: FileStore, run: (client: Client) => Promise<void>) {
  const server = createEssayMcpServer(store);
  const client = new Client({ name: "owned-format-recovery", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function cloudStore() {
  const firestore = new MemoryFirestore();
  const store = new CloudStore({
    firestore: firestore.client(), storage: new MemoryStorage().client(),
    environment: "staging", ownerKey: "d".repeat(64), artifactBucket: "owned-format-fixture", templateDir,
  });
  return { store, firestore };
}

for (const { name, format } of invalidCases) {
  test(`default-template create rejects ${name} without persisting a phantom answer`, async () => {
    await withFileStore(async (store, root) => withClient(store, async client => {
      const before = await filesUnder(root);
      const created = await client.callTool({ name: "create_answer", arguments: {
        title: "自有無效新建", templateId,
        sections: [{ id: "body", text: originalText, paragraphFormat: format }],
      } });
      assertToolError(created, layoutError);
      assert.deepEqual(await filesUnder(root), before, "failed creation must write neither answer nor revision");
      assert.deepEqual(await store.listAnswers(), []);
    }));
  });

  test(`default-template format rejects ${name} before changing bytes, version or history`, async () => {
    await withFileStore(async (store, root) => {
      const original = answer();
      await store.saveAnswer(original);
      await withClient(store, async client => {
        const before = await filesUnder(root);
        const changed = await client.callTool({ name: "format_section", arguments: {
          answerId: original.id, sectionId: "body", paragraphFormat: format, expectedVersion: 1,
        } });
        assertToolError(changed, layoutError);
        assert.deepEqual(await filesUnder(root), before, "rejected formatting must preserve all existing bytes");
        assert.equal((await store.getAnswer(original.id)).version, 1);
        const reopened = structured<{ answer: AnswerDocument; layout: { fits: boolean } }>(
          await client.callTool({ name: "read_answer", arguments: { answerId: original.id } }));
        assert.equal(reopened.answer.sections[0].text, originalText);
        assert.equal(reopened.layout.fits, true);
        const exported = await client.callTool({ name: "export_text", arguments: { answerId: original.id } });
        assert.notEqual(exported.isError, true, text(exported));
      });
    });
  });

  test(`CloudStore rejects ${name} before creating or updating answer/revision documents`, async () => {
    const { store, firestore } = cloudStore();
    const original = answer("自有記憶體雲端測試");
    await assert.rejects(store.saveAnswer(withFormat(original, format)), layoutError);
    assert.equal(firestore.documents.size, 0, "invalid creation must not enter persistence");
    await store.saveAnswer(original);
    const before = JSON.stringify([...firestore.documents]);
    await assert.rejects(store.saveAnswer({ ...withFormat(original, format), version: 2 }, { expectedVersion: 1 }), layoutError);
    assert.equal(JSON.stringify([...firestore.documents]), before, "invalid update must not alter answer or revisions");
    assert.equal((await store.getAnswer(original.id)).version, 1);
  });
}

test("valid 45-line overflow remains saved and readable in FileStore and the memory-backed CloudStore", async () => {
  const overflow = createAnswerDocument({ templateId, title: "自有45行", sections: [
    { id: "body", text: Array.from({ length: 45 }, (_, index) => `自有第${index + 1}行`).join("\n") },
  ] });
  await withFileStore(async store => {
    await store.saveAnswer(overflow);
    await withClient(store, async client => {
      const report = structured<{ answer: AnswerDocument; layout: { fits: boolean; totalLines: number; overflowLines: number; compressionHints: unknown[] } }>(
        await client.callTool({ name: "read_answer", arguments: { answerId: overflow.id } }));
      assert.equal(report.answer.version, 1);
      assert.equal(report.layout.totalLines, 45);
      assert.equal(report.layout.overflowLines, 1);
      assert.equal(report.layout.fits, false);
      assert.ok(report.layout.compressionHints.length > 0);
    });
  });
  const { store, firestore } = cloudStore();
  await store.saveAnswer(overflow);
  assert.equal((await store.getAnswer(overflow.id)).sections[0].text, overflow.sections[0].text);
  assert.equal(firestore.documents.size, 2, "overflow saves both current answer and revision");
});

async function seedLegacyPoison(store: FileStore, currentVersion: 2 | 3 = 2) {
  const good = { ...answer("自有歷史原標題"), lineTargets: { body: 7 } };
  const unrelated = answer("自有不相關答案");
  await store.saveAnswer(good);
  await store.saveAnswer(unrelated);
  // Model an existing schema-valid version written by the old save-before-layout path.
  // Seed storage directly: the repaired save method must reject this candidate.
  const poisoned: AnswerDocument = {
    ...withFormat(good, { leftIndent: 42 }), version: 2,
    title: "目前標題須保留", question: "目前題目須保留", exam: "自有考試", questionNo: 3,
    lineTargets: { body: 9 },
  };
  const current: AnswerDocument = currentVersion === 2 ? poisoned : { ...poisoned, version: 3, sections: good.sections };
  const write = (filename: string, document: AnswerDocument) => fs.writeFile(filename, `${JSON.stringify(document, null, 2)}\n`);
  const badRevision = path.join(store.revisionDir, good.id, "2.json");
  await write(badRevision, poisoned);
  if (currentVersion === 3) await write(path.join(store.revisionDir, good.id, "3.json"), current);
  await write(path.join(store.answerDir, good.id + ".json"), current);
  return { good, poisoned, current, unrelated, badRevision };
}

for (const currentVersion of [2, 3] as const) {
  test(`list_revisions survives an invalid ${currentVersion === 2 ? "current" : "previous"} layout and identifies valid recovery choices`, async () => {
    await withFileStore(async (store, root) => {
      const legacy = await seedLegacyPoison(store, currentVersion);
      const before = await filesUnder(root);
      await withClient(store, async client => {
        const result = await client.callTool({ name: "list_revisions", arguments: { answerId: legacy.good.id } });
        const history = structured<{ currentVersion: number; revisions: Array<{
          version: number; changes: string[]; layoutError?: string; totalLines?: number; fits?: boolean;
        }> }>(result);
        assert.equal(history.currentVersion, currentVersion);
        assert.deepEqual(history.revisions.map(revision => revision.version), currentVersion === 2 ? [2, 1] : [3, 2, 1]);
        const bad = history.revisions.find(revision => revision.version === 2)!;
        assert.equal(typeof bad.layoutError, "string");
        assert.ok(bad.layoutError!.length > 0);
        assert.equal("totalLines" in bad, false, "unknown line count must not be fabricated");
        assert.equal("fits" in bad, false, "an invalid layout is not a fit/overflow result");
        const valid = history.revisions.find(revision => revision.version === 1)!;
        assert.equal(valid.fits, true);
        assert.ok(valid.totalLines! > 0);
        assert.doesNotMatch(text(result), /undefined|NaN/);
      });
      assert.deepEqual(await filesUnder(root), before, "listing recovery history must not rewrite any answer or revision");
    });
  });
}

test("normal restore recovers a legacy poisoned current answer as N+1 while retaining bad history and unrelated bytes", async () => {
  await withFileStore(async store => {
    const legacy = await seedLegacyPoison(store);
    const historical = await store.getRevision(legacy.good.id, 1);
    const badBytes = await fs.readFile(legacy.badRevision);
    const unrelatedPath = path.join(store.answerDir, legacy.unrelated.id + ".json");
    const unrelatedBytes = await fs.readFile(unrelatedPath);
    await withClient(store, async client => {
      const restored = structured<{ answer: AnswerDocument; layout: { fits: boolean }; changes: string[] }>(
        await client.callTool({ name: "restore_revision", arguments: { responseDetail: "full", answerId: legacy.good.id, version: 1, expectedVersion: 2 } }));
      assert.equal(restored.answer.version, 3);
      assert.deepEqual(restored.answer.sections, historical.sections);
      assert.deepEqual(restored.answer.lineTargets, historical.lineTargets);
      assert.equal(restored.answer.title, legacy.current.title);
      assert.equal(restored.answer.question, legacy.current.question);
      assert.equal(restored.answer.exam, legacy.current.exam);
      assert.equal(restored.answer.questionNo, legacy.current.questionNo);
      assert.equal(restored.layout.fits, true);
      assert.ok(restored.changes.length > 0);
      const reopened = structured<{ answer: AnswerDocument; layout: { fits: boolean } }>(
        await client.callTool({ name: "read_answer", arguments: { answerId: legacy.good.id } }));
      assert.equal(reopened.answer.version, 3);
      assert.equal(reopened.layout.fits, true);
      assert.notEqual((await client.callTool({ name: "check_layout", arguments: { answerId: legacy.good.id } })).isError, true);
    });
    assert.deepEqual(await fs.readFile(legacy.badRevision), badBytes, "recovery must preserve historical evidence");
    assert.deepEqual(await fs.readFile(unrelatedPath), unrelatedBytes, "recovery must not affect another answer");
    const saved = await store.getRevision(legacy.good.id, 3);
    assert.deepEqual(saved.sections, historical.sections);
    assert.deepEqual(saved.lineTargets, historical.lineTargets);
  });
});

test("invalid historical targets and stale restore attempts fail without committing another version", async () => {
  await withFileStore(async (store, root) => {
    const legacy = await seedLegacyPoison(store, 3);
    const before = await filesUnder(root);
    await withClient(store, async client => {
      const invalid = await client.callTool({ name: "restore_revision", arguments: { answerId: legacy.good.id, version: 2, expectedVersion: 3 } });
      assertToolError(invalid, layoutError);
      assert.deepEqual(await filesUnder(root), before, "invalid target must not create revision 4");
      const stale = await client.callTool({ name: "restore_revision", arguments: { answerId: legacy.good.id, version: 1, expectedVersion: 2 } });
      assertToolError(stale, /Version conflict/);
      assert.deepEqual(await filesUnder(root), before, "stale restore must not commit");
      const reopened = structured<{ answer: AnswerDocument }>(
        await client.callTool({ name: "read_answer", arguments: { answerId: legacy.good.id } }));
      assert.equal(reopened.answer.version, 3);
    });
  });
});
