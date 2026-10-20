import assert from "node:assert/strict";
import { test } from "node:test";
import { fork } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CloudStore, createRuntimeStore, MAX_ARTIFACT_BYTES, StoreUnavailableError } from "../src/cloud-storage.js";
import { createAnswerDocument, type AnswerDocument } from "../src/domain.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore, isStoreNotFound, EXPORT_ARTIFACT_TTL_MS } from "../src/storage.js";
import { withTemporaryExport } from "../src/exporters.js";
import { MemoryFirestore, MemoryStorage, type Read, type Write } from "./fakes/cloud-clients.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerKey = "a".repeat(64);
const answer = (title = "Synthetic answer") => createAnswerDocument({
  templateId: "police_information_essay", title, sections: [{ id: "body", text: "Synthetic body" }],
});
function setup() {
  const firestore = new MemoryFirestore();
  const storage = new MemoryStorage();
  let now = 1_700_000_000_000;
  const store = (owner = ownerKey, readOnly = false) => new CloudStore({
    firestore: firestore.client(), storage: storage.client(), environment: "staging", ownerKey: owner,
    artifactBucket: "synthetic-artifacts", templateDir: path.join(projectRoot, "templates"),
    now: () => now, readOnly,
  });
  return { firestore, storage, store, temporaryPaths: [] as string[], advance: (milliseconds: number) => { now += milliseconds; } };
}
async function connect(store: CloudStore | FileStore, readOnly = false) {
  const server = createEssayMcpServer(store, { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "cloud-unit-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
async function artifact(s: ReturnType<typeof setup>, doc: AnswerDocument, text = "synthetic bytes") {
  return withTemporaryExport("same.txt", async (outputPath, temporaryDir) => {
    s.temporaryPaths.push(outputPath);
    await fs.writeFile(outputPath, text);
    return s.store().createExportHandle(outputPath, { answerId: doc.id, answerVersion: doc.version, format: "txt", temporaryDir });
  });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("cloud rejects duplicate creates, including racing independent adapters", async () => {
  const s = setup();
  const doc = answer();
  const results = await Promise.allSettled([s.store().saveAnswer(doc), s.store().saveAnswer(doc)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /已存在/);
  assert.equal((await s.store().getAnswer(doc.id)).version, 1);
  assert.equal(s.firestore.documents.size, 2, "answer plus atomic revision");
});

test("cloud stale writers retry the transaction without adopting the new expectedVersion", async () => {
  const s = setup();
  const doc = answer();
  await s.store().saveAnswer(doc);
  const bothRead = gate();
  let reads = 0;
  s.firestore.onTransactionRead = async () => {
    if (++reads <= 2) {
      if (reads === 2) bothRead.release();
      await bothRead.promise;
    }
  };
  const results = await Promise.allSettled(["A", "B"].map(title =>
    s.store().saveAnswer({ ...doc, title, version: 900, createdAt: "2000-01-01T00:00:00.000Z" }, { expectedVersion: 1 })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.match(String((results.find(result => result.status === "rejected") as PromiseRejectedResult).reason), /Version conflict: expected 1, current version is 2/);
  assert.equal(s.firestore.retries, 1);
  const current = await s.store().getAnswer(doc.id);
  assert.equal(current.version, 2);
  assert.equal(current.createdAt, doc.createdAt);
  assert.equal([...s.firestore.documents.keys()].filter(key => key.includes("/revisions/")).length, 2);
});

test("two independent processes commit only one stale write to the shared fake authority", { timeout: 20000 }, async () => {
  const s = setup();
  const doc = answer();
  await s.store().saveAnswer(doc);
  const bothRead = gate();
  let reads = 0;
  const children = [0, 1].map(() => fork(path.join(projectRoot, "tests/fakes/cas-worker.ts"), [], {
    cwd: projectRoot, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  const exits = children.map(child => once(child, "exit"));
  try {
    const results = await Promise.all(children.map((child, index) => new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      child.on("error", reject);
      child.on("message", async (message: { ready?: boolean; done?: boolean; ok: boolean; error?: string; id: number; op: string; args: unknown }) => {
        if (message.ready) { child.send({ answer: { ...doc, title: "process-" + index, version: 2 }, ownerKey }); return; }
        if (message.done) { resolve(message); return; }
        try {
          let value: unknown;
          if (message.op === "read") {
            value = await s.firestore.read(message.args as string);
            if (++reads <= 2) {
              if (reads === 2) bothRead.release();
              await bothRead.promise;
            }
          } else {
            const { reads, writes } = message.args as { reads: Read[]; writes: Write[] };
            value = await s.firestore.commit(reads, writes);
          }
          child.send({ id: message.id, value });
        } catch (error) { child.send({ id: message.id, error: (error as Error).message }); }
      });
      child.on("exit", code => { if (code !== 0) reject(new Error("Worker exited " + code)); });
    })));
    assert.equal(results.filter(result => result.ok).length, 1);
    assert.match(results.find(result => !result.ok)!.error!, /Version conflict: expected 1, current version is 2/);
    assert.equal((await s.store().getAnswer(doc.id)).version, 2);
    assert.equal([...s.firestore.documents.keys()].filter(key => key.includes("/revisions/")).length, 2);
    await Promise.all(exits);
  } finally {
    bothRead.release();
    for (const child of children) if (child.exitCode === null) child.kill();
  }
});

test("a paused answer transaction does not block a different answer", { timeout: 5000 }, async () => {
  const s = setup();
  const a = answer("A"), b = answer("B");
  await Promise.all([s.store().saveAnswer(a), s.store().saveAnswer(b)]);
  const entered = gate(), hold = gate();
  s.firestore.onTransactionRead = async read => {
    if (read.path.endsWith(a.id)) { entered.release(); await hold.promise; }
  };
  const pending = s.store().saveAnswer({ ...a, version: 2 }, { expectedVersion: 1 });
  try {
    await entered.promise;
    await s.store().saveAnswer({ ...b, version: 2 }, { expectedVersion: 1 });
    assert.equal((await s.store().getAnswer(b.id)).version, 2);
  } finally { hold.release(); await pending; }
});

test("166 invalid formatting and duplicate section IDs fail before any persistence", async () => {
  const s = setup();
  const invalid = createAnswerDocument({ templateId: "police_information_essay_166", title: "invalid",
    sections: [{ id: "body", text: "invalid", paragraphFormat: { bold: true } }] });
  await assert.rejects(s.store().saveAnswer(invalid), /ESSAY_MCP_PAPER_FONT|關閉粗體/);
  const duplicate = answer();
  duplicate.sections.push({ ...duplicate.sections[0] });
  await assert.rejects(s.store().saveAnswer(duplicate), /Duplicate section/);
  assert.equal(s.firestore.documents.size, 0);
  assert.equal(s.storage.uploads, 0);
});

test("owner isolation and reader artifact denial happen before any GCS download", async () => {
  const s = setup();
  const doc = answer();
  await s.store().saveAnswer(doc);
  const exported = await artifact(s, doc);
  const other = s.store("b".repeat(64));
  await assert.rejects(other.getAnswer(doc.id), isStoreNotFound);
  assert.deepEqual(await other.listAnswers(), []);
  await assert.rejects(other.saveAnswer({ ...doc, version: 2 }, { expectedVersion: 1 }), /Version conflict/);
  await assert.rejects(other.readExport(exported.handle), isStoreNotFound);
  await assert.rejects(s.store(ownerKey, true).readExport(exported.handle), isStoreNotFound);
  await assert.rejects(s.store(ownerKey, true).saveAnswer(doc), /Read credential/);
  assert.equal(s.storage.downloads, 0);
  const reader = await connect(s.store(), true);
  try {
    assert.equal((await reader.listTools()).tools.length, 9);
    await assert.rejects(reader.readResource({ uri: "essay://exports/" + exported.handle }));
    assert.equal((await reader.callTool({ name: "export_text", arguments: { answerId: doc.id } })).isError, true);
    assert.equal(s.storage.downloads, 0);
  } finally { await reader.close(); }
});

test("GCS immutable uploads, pinned generation, hash, size and 24-hour boundary are enforced", async () => {
  const s = setup();
  const doc = answer();
  await s.store().saveAnswer(doc);
  const exported = await artifact(s, doc, "correct bytes");
  const store = s.store();
  assert.equal((await store.readExport(exported.handle)).data.toString(), "correct bytes");
  const [key, object] = [...s.storage.objects][0];
  const objectName = key.slice("synthetic-artifacts/".length);
  await assert.rejects(s.storage.bucket("synthetic-artifacts").file(objectName).save(Buffer.from("overwrite"),
    { preconditionOpts: { ifGenerationMatch: 0 } }), /precondition/);
  s.storage.objects.set(key, { ...object, data: Buffer.from("corrupt bytes") });
  await assert.rejects(store.readExport(exported.handle), isStoreNotFound);
  s.storage.objects.set(key, { ...object, generation: "999" });
  await assert.rejects(store.readExport(exported.handle), isStoreNotFound);
  s.storage.objects.set(key, object);
  s.advance(EXPORT_ARTIFACT_TTL_MS - 1);
  await store.readExport(exported.handle);
  s.advance(1);
  const downloads = s.storage.downloads;
  await assert.rejects(store.readExport(exported.handle), isStoreNotFound);
  assert.equal(s.storage.downloads, downloads, "expiry is checked before downloading");
});

test("upload, manifest, compensation and metadata failures never publish a handle", async () => {
  for (const failure of ["upload", "manifest", "delete", "metadata"] as const) {
    const s = setup();
    const doc = answer();
    await s.store().saveAnswer(doc);
    s.storage.failUpload = failure === "upload";
    s.firestore.failManifest = failure === "manifest" || failure === "delete";
    s.storage.failDelete = failure === "delete";
    s.storage.failMetadata = failure === "metadata";
    const logs: unknown[][] = [];
    const previous = console.error;
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      await assert.rejects(artifact(s, doc), /儲存暫時故障/);
      for (const temporary of s.temporaryPaths) await assert.rejects(fs.stat(path.dirname(temporary)), /ENOENT/);
      assert.equal([...s.firestore.documents.keys()].filter(key => key.includes("/artifacts/")).length, 0);
      assert.equal(s.storage.objects.size, failure === "delete" || failure === "metadata" ? 1 : 0);
      assert.equal(s.storage.deletions, failure === "manifest" || failure === "delete" ? 1 : 0);
      const classifications = logs.map(args => {
        assert.equal(args.length, 1);
        const log = JSON.parse(String(args[0]));
        assert.deepEqual(Object.keys(log).sort(), ["classification", "requestId"]);
        assert.match(log.requestId, /^[a-f0-9-]{36}$/);
        return log.classification;
      });
      if (failure === "delete") assert.deepEqual(classifications, ["artifact_compensation_failed", "storage_unavailable"]);
      if (failure === "metadata") assert.deepEqual(classifications, ["artifact_generation_unknown", "storage_unavailable"]);
    } finally { console.error = previous; }
  }
});

test("document and artifact size limits reject explicitly before writes or uploads", async () => {
  const s = setup();
  const oversized = createAnswerDocument({ templateId: "police_information_essay", title: "oversized",
    sections: Array.from({ length: 8 }, (_, i) => ({ id: "part-" + i, text: "字".repeat(50000) })) });
  await assert.rejects(s.store().saveAnswer(oversized), /700 KiB/);
  assert.equal(s.firestore.documents.size, 0);
  const doc = answer();
  await s.store().saveAnswer(doc);
  await assert.rejects(withTemporaryExport("large.txt", async (outputPath, temporaryDir) => {
    await fs.writeFile(outputPath, Buffer.alloc(MAX_ARTIFACT_BYTES + 1));
    return s.store().createExportHandle(outputPath, { answerId: doc.id, answerVersion: 1, format: "txt", temporaryDir });
  }), /16 MiB/);
  assert.equal(s.storage.uploads, 0);
});

test("all previews, render and reflow preserve persisted cloud content, revisions and version", async () => {
  const s = setup();
  const doc = answer();
  await s.store().saveAnswer(doc);
  const client = await connect(s.store());
  try {
    const before = JSON.stringify([...s.firestore.documents]);
    for (const [name, extra] of [
      ["write_answer", { sections: [{ id: "body", text: "proposed" }] }],
      ["replace_text", { sectionId: "body", newText: "proposed" }],
      ["format_section", { sectionId: "body", paragraphFormat: { firstLineIndent: 2 } }],
      ["insert_text", { section: { id: "new", text: "proposed" } }],
      ["delete_text", { sectionId: "body" }],
    ] as const) {
      const result = await client.callTool({ name: "preview_change", arguments: { answerId: doc.id, expectedVersion: 1, operation: name, ...extra } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      assert.equal((result.structuredContent as { applied: boolean }).applied, false);
    }
    for (const name of ["render_answer_sheet", "reflow_answer", "check_layout"]) {
      assert.equal((await client.callTool({ name, arguments: { answerId: doc.id } })).isError, undefined);
    }
    assert.equal(JSON.stringify([...s.firestore.documents]), before);
    assert.deepEqual(await s.store().getAnswer(doc.id), JSON.parse(JSON.stringify(doc)));
  } finally { await client.close(); }
});

test("cloud and file expose the same tool contracts: owner 24, reader 9", async () => {
  const s = setup();
  for (const readOnly of [false, true]) {
    const file = await connect(new FileStore(), readOnly);
    const cloud = await connect(s.store(), readOnly);
    try {
      const baseline = await file.listTools();
      assert.equal(baseline.tools.length, readOnly ? 9 : 24);
      assert.deepEqual(await cloud.listTools(), baseline);
      assert.deepEqual(await cloud.listResources(), await file.listResources());
      assert.deepEqual(await cloud.listResourceTemplates(), await file.listResourceTemplates());
      assert.deepEqual(await cloud.listPrompts(), await file.listPrompts());
    } finally { await Promise.all([file.close(), cloud.close()]); }
  }
});

test("same-name parallel exports retain individual bytes and clean successful and failed temp directories", async () => {
  const s = setup();
  const docs = [answer("A"), answer("B")];
  docs.forEach((doc, i) => { doc.sections[0].text = "SYNTHETIC_EXPORT_" + i; doc.sections[0].paragraphs![0].text = doc.sections[0].text; });
  await Promise.all(docs.map(doc => s.store().saveAnswer(doc)));
  const client = await connect(s.store());
  try {
    const outputs = await Promise.all(docs.map(doc => client.callTool({
      name: "export_text", arguments: { answerId: doc.id, filename: "shared" },
    })));
    for (let i = 0; i < outputs.length; i++) {
      assert.equal(outputs[i].isError, undefined);
      const result = outputs[i].structuredContent as { path: string; exportUri: string };
      await assert.rejects(fs.stat(path.dirname(result.path)), /ENOENT/);
      const resource = await client.readResource({ uri: result.exportUri });
      const text = Buffer.from((resource.contents[0] as { blob: string }).blob, "base64").toString();
      assert.ok(text.includes("SYNTHETIC_EXPORT_" + i));
      assert.ok(!text.includes("SYNTHETIC_EXPORT_" + (1 - i)));
    }
    let failedPath = "";
    await assert.rejects(withTemporaryExport("shared.txt", async outputPath => {
      failedPath = outputPath;
      await fs.writeFile(outputPath, "partial");
      throw new Error("synthetic render failure");
    }), /render failure/);
    await assert.rejects(fs.stat(path.dirname(failedPath)), /ENOENT/);
    s.firestore.failManifest = true;
    assert.equal((await client.callTool({ name: "export_text", arguments: { answerId: docs[0].id, filename: "shared" } })).isError, true);
  } finally { await client.close(); }
});

test("cloud startup fails closed on missing settings; default and stdio always use file", () => {
  assert.ok(createRuntimeStore({}) instanceof FileStore);
  assert.ok(createRuntimeStore({ MCP_TRANSPORT: "stdio", STORAGE_BACKEND: "cloud" }) instanceof FileStore);
  assert.throws(() => createRuntimeStore({ STORAGE_BACKEND: "invalid" }), /STORAGE_BACKEND/);
  assert.throws(() => createRuntimeStore({ STORAGE_BACKEND: "cloud" }), /GOOGLE_CLOUD_PROJECT/);
  const env = { STORAGE_BACKEND: "cloud", GOOGLE_CLOUD_PROJECT: "synthetic", ESSAY_FIRESTORE_DATABASE: "(default)",
    ESSAY_ENVIRONMENT: "staging", ESSAY_OWNER_KEY: ownerKey, ESSAY_ARTIFACT_BUCKET: "synthetic-artifacts" };
  for (const name of Object.keys(env).filter(name => name !== "STORAGE_BACKEND")) {
    assert.throws(() => createRuntimeStore({ ...env, [name]: "" }), new RegExp(name));
  }
  assert.throws(() => createRuntimeStore({ ...env, ESSAY_ENVIRONMENT: "production" }), /OAuth principals/);
});


test("cloud backend errors are classified, never disclose Firestore paths or owner keys, and GCS 5xx is not NotFound", async () => {
  const s = setup(), doc = answer();
  await s.store().saveAnswer(doc);
  const exported = await artifact(s, doc);
  const logs: unknown[][] = [], originalLog = console.error;
  console.error = (...args: unknown[]) => { logs.push(args); };
  const raw = Object.assign(new Error("secret-path/users/" + ownerKey + "/answers/" + doc.id), { code: 503 });
  const read = s.firestore.read.bind(s.firestore);
  try {
    s.firestore.read = async () => { throw raw; };
    for (const operation of [() => s.store().getAnswer(doc.id), () => s.store().readExport(exported.handle),
      () => s.store().saveAnswer({ ...doc, version: 2 }, { expectedVersion: 1 })]) {
      await assert.rejects(operation(), (error: unknown) => error instanceof StoreUnavailableError && error.message === "儲存暫時故障");
    }
    const client = await connect(s.store());
    try {
      const result = await client.callTool({ name: "read_answer", arguments: { answerId: doc.id } });
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result), /儲存暫時故障/);
      assert.ok(!JSON.stringify(result).includes(ownerKey));
      assert.ok(!JSON.stringify(result).includes("secret-path"));
    } finally { await client.close(); }
    s.firestore.read = read;
    s.firestore.failRead = true;
    await assert.rejects(s.store().listAnswers(), StoreUnavailableError);
    s.firestore.failRead = false;
    const bucket = s.storage.bucket.bind(s.storage);
    for (const stage of ["getMetadata", "download"] as const) {
      s.storage.bucket = name => {
        const original = bucket(name);
        return { ...original, file: (name, options) => ({ ...original.file(name, options), [stage]: async () => { throw raw; } }) };
      };
      await assert.rejects(s.store().readExport(exported.handle), (error: unknown) => error instanceof StoreUnavailableError && !isStoreNotFound(error));
    }
    s.storage.bucket = bucket;
    s.storage.objects.clear();
    await assert.rejects(s.store().readExport(exported.handle), isStoreNotFound);
    for (const args of logs) {
      assert.equal(args.length, 1);
      const log = JSON.parse(String(args[0]));
      assert.deepEqual(Object.keys(log).sort(), ["classification", "requestId"]);
      assert.match(log.requestId, /^[a-f0-9-]{36}$/);
      assert.equal(log.classification, "storage_unavailable");
    }
  } finally { console.error = originalLog; }
});

test("GCS lost save response plus 412 is idempotent only for matching pinned bytes; mismatches compensate", async () => {
  for (const collision of ["same", "different", "different-size"] as const) {
    const s = setup(), doc = answer();
    await s.store().saveAnswer(doc);
    s.storage.saveResponseLost = collision;
    if (collision === "same") {
      const result = await artifact(s, doc, "expected bytes");
      assert.equal((await s.store().readExport(result.handle)).data.toString(), "expected bytes");
      assert.equal(s.storage.objects.size, 1); assert.equal(s.storage.deletions, 0);
    } else {
      await assert.rejects(artifact(s, doc, "expected bytes"), StoreUnavailableError);
      assert.equal(s.storage.objects.size, 0); assert.equal(s.storage.deletions, 1);
      assert.equal([...s.firestore.documents.keys()].filter(p => p.includes("/artifacts/")).length, 0);
    }
  }
});
