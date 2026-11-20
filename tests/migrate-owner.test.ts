import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudStore } from "../src/cloud-storage.js";
import { createEssayMcpServer } from "../src/server.js";
import { principalOwnerKey } from "../src/oauth.js";
import { migrateOwner } from "../scripts/migrate-owner.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

async function session(store: CloudStore) {
  const server = createEssayMcpServer(store), client = new Client({ name: "migrate-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

test("migrate-owner copies answers, revisions and exams to the signed-in owner without touching the source", async () => {
  const firestore = new MemoryFirestore(), storage = new MemoryStorage();
  const from = "0".repeat(64), to = principalOwnerKey("https://auth.example", "user_01");
  const store = new CloudStore({ firestore: firestore.client(), storage: storage.client(), environment: "staging", ownerKey: from, artifactBucket: "synthetic-artifacts" });
  const old = await session(store);
  const created = await old.client.callTool({ name: "create_answer", arguments: { templateId: "police_information_essay", title: "舊答案", sections: [{ id: "s1", text: "甲。" }] } });
  const answerId = (created.structuredContent as { answer: { id: string } }).answer.id;
  await old.client.callTool({ name: "replace_text", arguments: { answerId, expectedVersion: 1, sectionId: "s1", newText: "乙。" } });
  await old.client.callTool({ name: "start_exam", arguments: { title: "舊考試", questions: [{ questionNo: 1 }] } });
  await old.close();

  const dry = await migrateOwner(firestore.client(), { environment: "staging", from, to });
  assert.equal(dry.applied, false);
  assert.deepEqual(dry.documents, { answers: 1, revisions: 2, exams: 1 });
  const target = store.forPrincipal(to, false);
  const before = await session(target);
  assert.ok(!JSON.stringify((await before.client.callTool({ name: "list_answers", arguments: {} })).structuredContent).includes("舊答案"), "dry run writes nothing");
  await before.close();

  await migrateOwner(firestore.client(), { environment: "staging", from, to, apply: true });
  const after = await session(target);
  assert.ok(JSON.stringify((await after.client.callTool({ name: "list_answers", arguments: {} })).structuredContent).includes("舊答案"));
  const read = await after.client.callTool({ name: "read_answer", arguments: { answerId } });
  assert.equal(read.isError, undefined); assert.match(JSON.stringify(read.structuredContent), /乙。/);
  const revisions = await after.client.callTool({ name: "list_revisions", arguments: { answerId } });
  assert.equal(revisions.isError, undefined); assert.match(JSON.stringify(revisions.structuredContent), /"version":1/);
  assert.equal((await after.client.callTool({ name: "replace_text", arguments: { answerId, expectedVersion: 2, sectionId: "s1", newText: "丙。" } })).isError, undefined);
  await after.close();

  const source = await session(store);
  assert.match(JSON.stringify((await source.client.callTool({ name: "read_answer", arguments: { answerId } })).structuredContent), /乙。/, "source untouched");
  await source.close();
  await assert.rejects(migrateOwner(firestore.client(), { environment: "staging", from, to, apply: true }), /already has answers/);
  await assert.rejects(migrateOwner(firestore.client(), { environment: "staging", from, to: from }), /same/);
});
