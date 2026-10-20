import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudStore } from "../src/cloud-storage.js";
import { createAnswerDocument, type AnswerDocument } from "../src/domain.js";
import { withTemporaryExport } from "../src/exporters.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore, isStoreNotFound, type EssayStore } from "../src/storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(projectRoot, "templates");
const ownerKey = "a".repeat(64);
const answer = (title: string) => createAnswerDocument({
  templateId: "police_information_essay", title, sections: [{ id: "body", text: "Synthetic body" }],
});
async function edit(store: EssayStore, doc: AnswerDocument, text: string): Promise<AnswerDocument> {
  const current = await store.getAnswer(doc.id);
  const next = { ...current, sections: [{ ...current.sections[0], text }], version: current.version + 1 };
  await store.saveAnswer(next, { expectedVersion: current.version });
  return store.getAnswer(doc.id);
}
async function exportText(store: EssayStore, doc: AnswerDocument) {
  return withTemporaryExport("same.txt", async (outputPath, temporaryDir) => {
    await fs.writeFile(outputPath, "synthetic bytes for " + doc.id);
    return store.createExportHandle(outputPath, { answerId: doc.id, answerVersion: doc.version, format: "txt", temporaryDir });
  });
}
function cloud() {
  const firestore = new MemoryFirestore();
  const storage = new MemoryStorage();
  const store = (owner = ownerKey, readOnly = false) => new CloudStore({
    firestore: firestore.client(), storage: storage.client(), environment: "staging", ownerKey: owner,
    artifactBucket: "synthetic-artifacts", templateDir, readOnly,
  });
  return { firestore, storage, store };
}
async function connect(store: EssayStore, readOnly = false) {
  const server = createEssayMcpServer(store, { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "delete-answer-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test("cloud delete_answer removes the answer, every revision, its manifests and objects in one step", async () => {
  const s = cloud();
  const target = answer("delete me");
  const keep = answer("keep me");
  const foreign = answer("other owner");
  await s.store().saveAnswer(target);
  await s.store().saveAnswer(keep);
  await s.store("b".repeat(64)).saveAnswer(foreign);
  const edited = await edit(s.store(), await edit(s.store(), target, "second"), "third");
  await exportText(s.store(), edited);
  await exportText(s.store(), edited);
  const kept = await exportText(s.store(), keep);
  const documentsBefore = [...s.firestore.documents.keys()];
  const objectsBefore = s.storage.objects.size;

  await assert.rejects(s.store().deleteAnswer(target.id, { expectedVersion: 2 }), /Version conflict: expected 2, current version is 3/);
  await assert.rejects(s.store(ownerKey, true).deleteAnswer(target.id, { expectedVersion: 3 }), /Read credential/);
  await assert.rejects(s.store("b".repeat(64)).deleteAnswer(target.id, { expectedVersion: 3 }), isStoreNotFound);
  assert.deepEqual([...s.firestore.documents.keys()], documentsBefore);
  assert.equal(s.storage.objects.size, objectsBefore);

  const deleted = await s.store().deleteAnswer(target.id, { expectedVersion: 3 });
  assert.equal(deleted.answer.title, "delete me");
  assert.equal(deleted.revisions, 3);
  assert.equal(deleted.exports, 2);
  const remaining = [...s.firestore.documents.entries()];
  assert.ok(!remaining.some(([key]) => key.includes(target.id)), "no answer or revision documents remain");
  assert.ok(!remaining.some(([, item]) => item.value.answerId === target.id), "no manifests remain");
  assert.equal(s.storage.objects.size, objectsBefore - 2);
  await assert.rejects(s.store().getAnswer(target.id), isStoreNotFound);
  await assert.rejects(s.store().deleteAnswer(target.id, { expectedVersion: 3 }), isStoreNotFound);

  assert.equal((await s.store().getAnswer(keep.id)).title, "keep me");
  assert.equal((await s.store().readExport(kept.handle)).answerId, keep.id);
  assert.equal((await s.store("b".repeat(64)).getAnswer(foreign.id)).title, "other owner");
});

test("cloud delete_answer still succeeds when an object delete fails; the bucket lifecycle covers the orphan", async () => {
  const s = cloud();
  const doc = answer("object delete fails");
  await s.store().saveAnswer(doc);
  await exportText(s.store(), doc);
  s.storage.failDelete = true;
  const deleted = await s.store().deleteAnswer(doc.id, { expectedVersion: 1 });
  assert.equal(deleted.exports, 1);
  await assert.rejects(s.store().getAnswer(doc.id), isStoreNotFound);
  // The orphaned object is left for the bucket lifecycle rule.
  assert.equal(s.storage.objects.size, 1);
});

test("file delete_answer enforces the version and removes only that answer's artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-delete-"));
  const store = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  try {
    const target = answer("delete me");
    const keep = answer("keep me");
    await store.saveAnswer(target);
    await store.saveAnswer(keep);
    const edited = await edit(store, target, "second");
    await exportText(store, edited);
    const kept = await exportText(store, keep);

    await assert.rejects(store.deleteAnswer(target.id, { expectedVersion: 1 }), /Version conflict: expected 1, current version is 2/);
    assert.equal((await store.getAnswer(target.id)).version, 2);

    const deleted = await store.deleteAnswer(target.id, { expectedVersion: 2 });
    assert.deepEqual({ title: deleted.answer.title, revisions: deleted.revisions, exports: deleted.exports },
      { title: "delete me", revisions: 0, exports: 1 });
    await assert.rejects(store.getAnswer(target.id), isStoreNotFound);
    await assert.rejects(store.deleteAnswer(target.id, { expectedVersion: 2 }), isStoreNotFound);
    assert.deepEqual((await store.listAnswers()).map(item => item.id), [keep.id]);
    assert.equal((await store.readExport(kept.handle)).answerId, keep.id);
    assert.deepEqual((await fs.readdir(store.artifactDir)).sort(), [kept.handle + ".json", kept.handle + ".txt"].sort());
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("delete_answer tool reports counts, requires expectedVersion and is absent for readers", async () => {
  const s = cloud();
  const doc = answer("tool delete");
  await s.store().saveAnswer(doc);
  const owner = await connect(s.store());
  const reader = await connect(s.store(), true);
  try {
    assert.ok(!(await reader.listTools()).tools.some(tool => tool.name === "delete_answer"));
    const missingVersion = await owner.callTool({ name: "delete_answer", arguments: { answerId: doc.id } });
    assert.equal(missingVersion.isError, true);
    const stale = await owner.callTool({ name: "delete_answer", arguments: { answerId: doc.id, expectedVersion: 9 } });
    assert.equal(stale.isError, true);
    assert.equal((await s.store().getAnswer(doc.id)).version, 1);

    const result = await owner.callTool({ name: "delete_answer", arguments: { answerId: doc.id, expectedVersion: 1 } });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      answerId: doc.id, title: "tool delete", version: 1, deletedRevisions: 1, deletedExports: 0,
    });
    const again = await owner.callTool({ name: "delete_answer", arguments: { answerId: doc.id, expectedVersion: 1 } });
    assert.equal(again.isError, true);
    assert.match(JSON.stringify(again.content), /找不到答案/);
    assert.equal((await owner.callTool({ name: "read_answer", arguments: { answerId: doc.id } })).isError, true);
  } finally {
    await Promise.all([owner.close(), reader.close()]);
  }
});
