import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudStore } from "../src/cloud-storage.js";
import { createReadinessCheck } from "../src/readiness.js";
import { initializeRuntimeFont, validateRuntimeFont } from "../src/runtime-font.js";
import { ORIGINAL_PAPER_FONT_SHA256, validatedOriginalPaperFont } from "../src/original-paper.js";
import { FileStore } from "../src/storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

test("readiness checks both templates, caches only healthy storage briefly and rejects failed dependencies", async () => {
  const firestore = new MemoryFirestore(), storage = new MemoryStorage();
  const store = new CloudStore({ firestore: firestore.client(), storage: storage.client(), environment: "staging",
    ownerKey: "a".repeat(64), artifactBucket: "synthetic-artifacts" });
  let now = 1000;
  let checks = 0;
  const actualCheck = store.checkReadiness.bind(store);
  store.checkReadiness = async () => { checks++; await actualCheck(); };
  const ready = createReadinessCheck(store, { now: () => now, ttlMs: 100, fontPath: () => undefined });
  await Promise.all([ready(), ready()]);
  assert.equal(checks, 1);
  firestore.failRead = true;
  await ready();
  now += 100;
  await assert.rejects(ready(), /dependency failure/);
  await assert.rejects(ready(), /dependency failure/);
  assert.equal(checks, 3, "failed checks do not populate a healthy cache");
  firestore.failRead = false;
  storage.failRead = true;
  await assert.rejects(ready(), /storage read failure/);
  storage.failRead = false;
  await ready();
  assert.equal(checks, 5);
});

test("readiness refuses missing second template, missing configured font and bounded dependency timeout", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "essay-readiness-"));
  try {
    await fs.copyFile(path.join(process.cwd(), "templates/police_information_essay.json"), path.join(directory, "police_information_essay.json"));
    await assert.rejects(createReadinessCheck(new FileStore({ templateDir: directory }), { fontPath: () => undefined })(), /找不到模板/);
    await fs.copyFile(path.join(process.cwd(), "templates/police_information_essay_166.json"), path.join(directory, "police_information_essay_166.json"));
    const store = new FileStore({ templateDir: directory });
    await assert.rejects(createReadinessCheck(store, { fontPath: () => path.join(directory, "missing.ttf") })(), /ENOENT/);
    await fs.writeFile(path.join(directory, "wrong.ttf"), "synthetic invalid font");
    await assert.rejects(createReadinessCheck(store, { fontPath: () => path.join(directory, "wrong.ttf") })(), /SHA-256 mismatch/);
    const dependency = Object.assign(store, { checkReadiness: async () => new Promise<void>(() => {}) });
    await assert.rejects(createReadinessCheck(dependency, { timeoutMs: 25, fontPath: () => undefined })(), /timed out/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test("runtime font requires pinned approved hash and generation, and fails closed on missing, replaced or corrupt objects", async () => {
  const storage = new MemoryStorage();
  const validConfig = { PAPER_FONT_GCS_URI: "gs://synthetic-fonts/moe.ttf", PAPER_FONT_GENERATION: "1",
    PAPER_FONT_SHA256: ORIGINAL_PAPER_FONT_SHA256 };
  await initializeRuntimeFont(storage.client(), {});
  for (const env of [
    { PAPER_FONT_GENERATION: "1" },
    { ...validConfig, PAPER_FONT_GCS_URI: "https://invalid/" },
    { ...validConfig, PAPER_FONT_GENERATION: "" },
    { ...validConfig, PAPER_FONT_GENERATION: "0" },
    { ...validConfig, PAPER_FONT_SHA256: "" },
    { ...validConfig, PAPER_FONT_SHA256: "0".repeat(64) },
  ]) await assert.rejects(initializeRuntimeFont(storage.client(), env), /required|approved SHA-256/);
  assert.equal(storage.downloads, 0);
  await assert.rejects(initializeRuntimeFont(storage.client(), validConfig), /not found/);
  storage.objects.set("synthetic-fonts/moe.ttf", { generation: "2", data: Buffer.from("wrong generation") });
  await assert.rejects(initializeRuntimeFont(storage.client(), validConfig), /not found|generation/);
  storage.objects.set("synthetic-fonts/moe.ttf", { generation: "1", data: Buffer.from("wrong family and hash") });
  const previous = process.env.ESSAY_MCP_PAPER_FONT;
  await assert.rejects(initializeRuntimeFont(storage.client(), validConfig), /SHA-256 mismatch/);
  assert.equal(process.env.ESSAY_MCP_PAPER_FONT, previous);
});


test("REQUIRE_PAPER_FONT fails startup/readiness and fonts cannot share the artifact lifecycle bucket", async () => {
  await assert.rejects(initializeRuntimeFont(undefined, { REQUIRE_PAPER_FONT: "true" }), /font is missing/);
  const store = new FileStore();
  await assert.rejects(createReadinessCheck(store, { requirePaperFont: true, fontPath: () => undefined })(), /font is missing/);
  await createReadinessCheck(store, { requirePaperFont: false, fontPath: () => undefined })();
  const storage = new MemoryStorage();
  await assert.rejects(initializeRuntimeFont(storage.client(), { PAPER_FONT_GCS_URI: "gs://shared/moe.ttf", PAPER_FONT_GENERATION: "1",
    PAPER_FONT_SHA256: ORIGINAL_PAPER_FONT_SHA256, ESSAY_ARTIFACT_BUCKET: "shared" }), /dedicated bucket/);
  assert.equal(storage.downloads, 0);
});

// A tiny SFNT name table lets fontkit execute the actual family branch independently of hashing.
function syntheticFont(family: string): Buffer {
  const name = Buffer.alloc(18 + family.length * 2);
  name.writeUInt16BE(1, 2); name.writeUInt16BE(18, 4);
  [3, 1, 0x409, 1, family.length * 2, 0].forEach((v, i) => name.writeUInt16BE(v, 6 + i * 2));
  [...family].forEach((c, i) => name.writeUInt16BE(c.charCodeAt(0), 18 + i * 2));
  const header = Buffer.alloc(28); header.writeUInt32BE(0x00010000); header.writeUInt16BE(1, 4);
  header.write("name", 12); header.writeUInt32BE(28, 20); header.writeUInt32BE(name.length, 24);
  return Buffer.concat([header, name]);
}

function mockApprovedSyntheticHash(t: TestContext): () => number {
  const actualHash = crypto.createHash;
  let fontHashes = 0;
  t.mock.method(crypto, "createHash", (...args: Parameters<typeof crypto.createHash>) => {
    const hash = actualHash(...args), update = hash.update.bind(hash), digest = hash.digest.bind(hash);
    let isFont = false;
    hash.update = ((data: Parameters<typeof hash.update>[0], ...rest: unknown[]) => {
      if (Buffer.isBuffer(data) && data.readUInt32BE(0) === 0x00010000) { isFont = true; fontHashes++; }
      return update(data, rest[0] as BufferEncoding);
    }) as typeof hash.update;
    hash.digest = ((encoding?: string) => isFont && encoding === "hex" ? ORIGINAL_PAPER_FONT_SHA256 : digest(encoding as "hex")) as typeof hash.digest;
    return hash;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return () => fontHashes;
}
test("successful font SHA cache invalidates on path, mtime and size", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "essay-font-cache-"));
  const previous = process.env.ESSAY_MCP_PAPER_FONT;
  const hashes = mockApprovedSyntheticHash(t);
  try {
    const file = path.join(directory, "approved.ttf");
    await fs.writeFile(file, syntheticFont("TW-MOE-Std-Kai"));
    process.env.ESSAY_MCP_PAPER_FONT = file;
    const store = new FileStore(), template = await store.getTemplate("police_information_essay_166");
    let templateReads = 0, now = 1000;
    const getTemplate = store.getTemplate.bind(store);
    store.getTemplate = async id => { templateReads++; return getTemplate(id); };
    const ready = createReadinessCheck(store, { now: () => now, ttlMs: 100 });
    await Promise.all([ready(), ready()]); await ready();
    assert.equal(hashes(), 1); assert.equal(templateReads, 2);
    now += 100; await ready(); assert.equal(templateReads, 4); assert.equal(hashes(), 1);
    await fs.utimes(file, new Date(), new Date(Date.now() + 1000));
    await validateRuntimeFont(template); assert.equal(hashes(), 2);
    await fs.appendFile(file, Buffer.alloc(4));
    await validateRuntimeFont(template); assert.equal(hashes(), 3);
    const other = path.join(directory, "other.ttf"); await fs.copyFile(file, other);
    process.env.ESSAY_MCP_PAPER_FONT = other;
    await validateRuntimeFont(template); assert.equal(hashes(), 4);

  } finally {
    if (previous === undefined) delete process.env.ESSAY_MCP_PAPER_FONT; else process.env.ESSAY_MCP_PAPER_FONT = previous;
    t.mock.restoreAll(); syncBuiltinESMExports();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("readiness timeouts do not stack unfinished backend probes", async () => {
  let resolve!: () => void, probes = 0;
  const dependency = Object.assign(new FileStore(), { checkReadiness: async () => { probes++; await new Promise<void>(r => { resolve = r; }); } });
  const ready = createReadinessCheck(dependency, { timeoutMs: 5, fontPath: () => undefined });
  await assert.rejects(ready(), /timed out/); await assert.rejects(ready(), /timed out/);
  assert.equal(probes, 1); resolve(); await ready(); assert.equal(probes, 1);
});


test("wrong-family font independently fails after the SHA-256 gate succeeds", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "essay-wrong-family-"));
  const hashes = mockApprovedSyntheticHash(t);
  try {
    const wrong = path.join(directory, "wrong-family.ttf");
    await fs.writeFile(wrong, syntheticFont("Wrong-Family"));
    assert.throws(() => validatedOriginalPaperFont(wrong), /TW-MOE-Std-Kai/);
    assert.equal(hashes(), 1, "real fontkit family validation runs after successful mocked hash");
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
