import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CloudStore } from "../src/cloud-storage.js";
import { createReadinessCheck } from "../src/readiness.js";
import { initializeRuntimeFont } from "../src/runtime-font.js";
import { ORIGINAL_PAPER_FONT_SHA256 } from "../src/original-paper.js";
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
    await assert.rejects(createReadinessCheck(new FileStore({ templateDir: directory }), { fontPath: () => undefined })(), /ENOENT/);
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
