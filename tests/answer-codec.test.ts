import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { answerDocumentSchema, createAnswerDocument } from "../src/domain.js";
import { encodeAnswer, decodeAnswer } from "../src/answer-codec.js";
import { FileStore } from "../src/storage.js";
import { CloudStore } from "../src/cloud-storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

// The exact nested options shape in 349bdfa; the enclosing old object strips new keys.
const legacy = answerDocumentSchema.extend({ layoutOptions: z.strictObject({
  wholeLatinWords: z.boolean().optional(), keepHeadingWithNext: z.boolean().optional(),
}).optional() });
const sample = (flag?: boolean) => ({ ...createAnswerDocument({ templateId: "police_information_essay", title: "isolated compatibility fixture", sections: [{ id: "body", text: "資料完整性驗證。" }] }),
  ...(flag === undefined ? {} : { layoutOptions: { wholeLatinWords: true, avoidPunctuationOnlyLines: flag } }) });

test("reproduces old reader failure, then preserves true/false/absent flags through an old-readable envelope", () => {
  assert.throws(() => legacy.parse(sample(true)), /avoidPunctuationOnlyLines/);
  for (const flag of [true, false, undefined]) {
    const answer = sample(flag), before = structuredClone(answer), encoded = encodeAnswer(answer);
    assert.equal(legacy.parse(encoded).id, answer.id);
    assert.deepEqual(decodeAnswer(encoded), answer);
    assert.deepEqual(answer, before);
    assert.deepEqual(decodeAnswer(answer), answer, "already-persisted nested flags remain readable without migration");
  }
  const answer = sample(true);
  assert.throws(() => decodeAnswer({ ...answer, layoutExtensions: { avoidPunctuationOnlyLines: false } }), /Conflicting/);
  assert.throws(() => decodeAnswer({ ...answer, layoutExtensions: { avoidPunctuationOnlyLines: "true" } }));
  assert.deepEqual(decodeAnswer({ ...encodeAnswer(answer), layoutExtensions: { avoidPunctuationOnlyLines: true, futureOption: true } }), answer);
});

test("FileStore answer, list and revisions keep runtime flags while every persisted generation is old-readable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "answer-codec-"));
  const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  try {
    const first = sample(true); await store.saveAnswer(first);
    await store.saveAnswer({ ...first, version: 2, layoutOptions: { avoidPunctuationOnlyLines: false } }, { expectedVersion: 1 });
    assert.equal((await store.getAnswer(first.id)).layoutOptions?.avoidPunctuationOnlyLines, false);
    assert.equal((await store.listAnswers())[0].layoutOptions?.avoidPunctuationOnlyLines, false);
    assert.equal((await store.getRevision(first.id, 1)).layoutOptions?.avoidPunctuationOnlyLines, true);
    const files = [path.join(store.answerDir, first.id + ".json"), path.join(store.revisionDir, first.id, "1.json"), path.join(store.revisionDir, first.id, "2.json")];
    for (const file of files) legacy.parse(JSON.parse(await fs.readFile(file, "utf8")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("CloudStore transaction, list and revisions persist the compatible envelope and retain flags", async () => {
  const firestore = new MemoryFirestore(), storage = new MemoryStorage();
  const store = new CloudStore({ firestore: firestore.client(), storage: storage.client(), environment: "staging", ownerKey: "a".repeat(64), artifactBucket: "isolated-test", templateDir: path.resolve("templates") });
  const first = sample(true); await store.saveAnswer(first);
  await store.saveAnswer({ ...first, layoutOptions: { avoidPunctuationOnlyLines: false } }, { expectedVersion: 1 });
  assert.equal((await store.getAnswer(first.id)).layoutOptions?.avoidPunctuationOnlyLines, false);
  assert.equal((await store.getRevision(first.id, 1)).layoutOptions?.avoidPunctuationOnlyLines, true);
  assert.equal((await store.listAnswers())[0].layoutOptions?.avoidPunctuationOnlyLines, false);
  const saved = [...firestore.documents.values()].map(item => item.value).filter(value => value.id === first.id);
  assert.equal(saved.length, 3);
  for (const value of saved) legacy.parse(value);
});
