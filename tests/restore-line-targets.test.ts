import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnswerDocument, type AnswerDocument } from "../src/domain.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(projectRoot, "templates");

test("restore_revision restores lineTargets from the revision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-restore-line-targets-"));
  const store = new FileStore({ templateDir, answerDir: path.join(root, "a"), exportDir: path.join(root, "e") });
  const server = createEssayMcpServer(store);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "repro", version: "1" });
  await server.connect(s); await client.connect(c);

  const answer = createAnswerDocument({ templateId: "police_information_essay", title: "t", sections: [
    { id: "intro", heading: "一、前言", text: "前言。" }, { id: "body", heading: "二、本文", text: "本文。" }] });
  await store.saveAnswer(answer);

  // Set line targets at version 2
  let result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 1, targets: [{ sectionId: "intro", lines: 3 }, { sectionId: "body", lines: 8 }] } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  let current = await store.getAnswer(answer.id);
  console.log("After set_line_targets (v2):", JSON.stringify(current.lineTargets), "version:", current.version);
  assert.deepEqual(current.lineTargets, { intro: 3, body: 8 });
  assert.equal(current.version, 2);

  // Restore to version 1 (no line targets) - should clear lineTargets
  result = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version: 1, expectedVersion: 2 } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  current = await store.getAnswer(answer.id);
  console.log("After restore_revision to v1 (v3):", JSON.stringify(current.lineTargets), "version:", current.version);
  assert.ok(current.lineTargets === undefined || (current.lineTargets && Object.keys(current.lineTargets).length === 0));
  assert.equal(current.version, 3);

  // Set different line targets at version 4
  result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 3, targets: [{ sectionId: "intro", lines: 5 }, { sectionId: "body", lines: 10 }] } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  current = await store.getAnswer(answer.id);
  console.log("After set_line_targets again (v4):", JSON.stringify(current.lineTargets), "version:", current.version);
  assert.deepEqual(current.lineTargets, { intro: 5, body: 10 });
  assert.equal(current.version, 4);

  // Clear line targets at version 5
  result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 4, targets: [{ sectionId: "intro", lines: null }, { sectionId: "body", lines: null }] } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  current = await store.getAnswer(answer.id);
  console.log("After clearing line_targets (v5):", JSON.stringify(current.lineTargets), "version:", current.version);
  assert.ok(current.lineTargets === undefined || (current.lineTargets && Object.keys(current.lineTargets).length === 0));
  assert.equal(current.version, 5);

  // Check revision 2 has line targets
  const revision2 = await store.getRevision(answer.id, 2);
  console.log("Revision 2 lineTargets:", JSON.stringify(revision2.lineTargets));
  assert.deepEqual(revision2.lineTargets, { intro: 3, body: 8 });

  // Restore to version 2 (has line targets) - should restore lineTargets
  result = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version: 2, expectedVersion: 5 } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  current = await store.getAnswer(answer.id);
  console.log("After restore_revision to v2 (v6):", JSON.stringify(current.lineTargets), "version:", current.version);
  assert.deepEqual(current.lineTargets, { intro: 3, body: 8 }, "lineTargets should be restored when restoring to a version with targets");
  assert.equal(current.version, 6);

  // Restore to version 4 (has different line targets) - should restore those lineTargets
  result = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version: 4, expectedVersion: 6 } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  current = await store.getAnswer(answer.id);
  console.log("After restore_revision to v4 (v7):", JSON.stringify(current.lineTargets), "version:", current.version);
  assert.deepEqual(current.lineTargets, { intro: 5, body: 10 }, "lineTargets should be restored when restoring to a version with different targets");
  assert.equal(current.version, 7);

  await client.close();
  await fs.rm(root, { recursive: true, force: true });
});
