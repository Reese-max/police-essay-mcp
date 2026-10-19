import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Firestore } from "@google-cloud/firestore";
import { CloudStore } from "../src/cloud-storage.js";
import { createAnswerDocument } from "../src/domain.js";
import { MemoryStorage } from "./fakes/cloud-clients.js";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const skip = emulator ? false : "Firestore emulator 未驗證：未設定 FIRESTORE_EMULATOR_HOST；不會連雲端。";
if (!emulator) console.log(skip);

test("real Firestore emulator: create, CAS, independent locks, revisions, ordering and 1 MiB limit", { skip, timeout: 60_000 }, async () => {
  assert.match(emulator!, /^(?:localhost|127\.0\.0\.1|\[::1\]):[0-9]+$/, "emulator tests only connect to loopback");
  const firestore = new Firestore({ projectId: "demo-police-essay", databaseId: "(default)" });
  const ownerKey = randomUUID().replaceAll("-", "").repeat(2);
  const user = "essayEnvironments/staging/users/" + ownerKey;
  const store = new CloudStore({ firestore, storage: new MemoryStorage().client(), environment: "staging", ownerKey, artifactBucket: "emulator-artifacts" });
  const make = (title: string, updatedAt: string) => ({ ...createAnswerDocument({ templateId: "police_information_essay", title, sections: [{ id: "body", text: "emulator" }] }), updatedAt });
  const a = make("A", "2026-01-01T00:00:00.000Z"), b = make("B", "2026-01-02T00:00:00.000Z");
  try {
    await Promise.all([store.saveAnswer(a), store.saveAnswer(b)]);
    await assert.rejects(store.saveAnswer(a), /已存在/);
    const results = await Promise.allSettled([
      store.saveAnswer({ ...a, title: "writer-a" }, { expectedVersion: 1 }),
      store.saveAnswer({ ...a, title: "writer-b" }, { expectedVersion: 1 }),
    ]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.match(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason), /Version conflict/);
    assert.equal((await store.getAnswer(a.id)).version, 2);
    const revisions = await firestore.collection(user + "/answers/" + a.id + "/revisions").orderBy("version").get();
    assert.deepEqual(revisions.docs.map(d => d.data().version), [1, 2]);
    assert.ok(revisions.docs.every(d => d.data().committedAt?.toMillis() > 0));
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const locked = firestore.runTransaction(async tx => {
      const ref = firestore.doc(user + "/answers/" + a.id);
      await tx.get(ref); enter(); await hold;
      tx.update(ref, { title: "held transaction" });
    });
    try {
      await Promise.race([entered, locked.then(() => { throw new Error("Lock transaction completed before release"); })]);
      let timeout: NodeJS.Timeout | undefined;
      try {
        await Promise.race([store.saveAnswer({ ...b, title: "independent" }, { expectedVersion: 1 }), new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Different answer was blocked by the held transaction")), 5000);
        })]);
      } finally { if (timeout) clearTimeout(timeout); }
      assert.equal((await store.getAnswer(b.id)).version, 2);
    } finally { release(); await locked; }
    const indexes = JSON.parse(await readFile("infra/firestore.indexes.json", "utf8"));
    assert.ok(!indexes.fieldOverrides.some((f: { collectionGroup: string; fieldPath: string; indexes: unknown[] }) => f.collectionGroup === "answers" && f.fieldPath === "updatedAt" && f.indexes.length === 0));
    assert.deepEqual((await store.listAnswers()).map(d => d.id), [b.id, a.id]);
    // Bypass the adapter's stricter 700 KiB guard to exercise the server's own document ceiling.
    await assert.rejects(firestore.doc(user + "/answers/oversize").create({ body: "x".repeat(1024 * 1024 + 1) }),
      /maximum|exceed|size|large|1048576|1.?MiB|1048487/i);
  } finally {
    await firestore.recursiveDelete(firestore.doc(user));
    await firestore.terminate();
  }
});
