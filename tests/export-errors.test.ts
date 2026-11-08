import assert from "node:assert/strict";
import { test } from "node:test";
import { isRetryableExportError, publicExportMessage } from "../src/export-errors.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { withTemporaryExport } from "../src/exporters.js";
import { createAnswerDocument } from "../src/domain.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";
import { CloudStore, StoreUnavailableError } from "../src/cloud-storage.js";

test("export retry classifier allows only transient Node, HTTP and preserved cloud causes", () => {
  for (const code of ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "EBUSY", "EMFILE", "ENFILE", "EPIPE"])
    assert.equal(isRetryableExportError(Object.assign(new Error("transport"), { code })), true, code);
  for (const status of [408, 429, 500, 502, 503, 504]) {
    for (const error of [{ status }, { statusCode: status }, { code: String(status) }, { response: { status } }]) {
      assert.equal(isRetryableExportError(error), true, JSON.stringify(error));
      assert.equal(isRetryableExportError(new StoreUnavailableError(error)), true, JSON.stringify(error));
    }
  }
  for (const status of [501, 505, 599]) for (const error of [{ status }, { statusCode: status }, { code: String(status) }, { response: { status } }])
    assert.equal(isRetryableExportError(error), false, JSON.stringify(error));
  for (const status of ["unavailable", "ETIMEDOUT"]) for (const code of [503, "429", 501])
    assert.equal(isRetryableExportError({ status, code }), code !== 501, `${status} ${code}`);
  for (const code of [4, 8, 13, 14]) assert.equal(isRetryableExportError(new StoreUnavailableError({ code })), true, `Firestore ${code}`);
  for (const error of [null, undefined, "timeout", new Error("unknown"), new Error("unsupported font"), new Error("invalid content"),
    new Error("renderer failure"), { code: "ENOENT" }, { code: "EACCES" }, { status: 400 }, { status: 401 }, { status: 403 },
    { status: 404 }, { status: 409 }, { status: 412 }, { code: 7 }, new StoreUnavailableError(), new StoreUnavailableError({ code: 7 })])
    assert.equal(isRetryableExportError(error), false, String(error));
  const cycle = { cause: {} }; cycle.cause = cycle;
  assert.equal(isRetryableExportError(cycle), false);
});

test("public export messages redact absolute paths and omit stack frames", () => {
  const message = String.raw`Cannot read 'C:\Private Files\font.ttf', /var/private/font.ttf and file:///C:/private/font.ttf`
    + "\n    at internalRenderer (C:\\private\\renderer.js:12:4)";
  assert.equal(publicExportMessage(message), "Cannot read '<path>', <path> and <path>");
  assert.equal(publicExportMessage("font:/var/private/font.ttf"), "font:<path>");
});


test("CloudStore preserves retry classification across Firestore reads, manifest writes and GCS uploads", async () => {
  for (const source of ["read", "manifest", "upload"]) for (const code of [403, 503, 14, "ETIMEDOUT", undefined]) {
    const firestore = new MemoryFirestore(), storage = new MemoryStorage();
    const error = Object.assign(new Error("private backend detail"), { code });
    if (source === "upload") {
      const bucket = storage.bucket.bind(storage);
      storage.bucket = name => {
        const base = bucket(name);
        return { ...base, file: (...args: Parameters<typeof base.file>) => ({ ...base.file(...args), save: async () => { throw error; } }) };
      };
    }
    const store = new CloudStore({ firestore: firestore.client(), storage: storage.client(), environment: "staging",
      ownerKey: "a".repeat(64), artifactBucket: "synthetic-artifacts", templateDir: path.resolve("templates") });
    const answer = createAnswerDocument({ templateId: "police_information_essay", title: "retry cause", sections: [{ text: "body" }] });
    await store.saveAnswer(answer);
    if (source === "read") firestore.read = async () => { throw error; };
    if (source === "manifest") firestore.commit = async () => { throw error; };
    await assert.rejects(source === "read" ? store.getAnswer(answer.id) : withTemporaryExport("retry.txt", async (file, temporaryDir) => {
      await fs.writeFile(file, "body");
      return store.createExportHandle(file, { answerId: answer.id, answerVersion: 1, format: "txt", temporaryDir });
    }), caught => {
      assert.ok(caught instanceof StoreUnavailableError);
      assert.equal(caught.message, "儲存暫時故障");
      assert.equal(isRetryableExportError(caught), code === 503 || code === 14 || code === "ETIMEDOUT", `${source} ${code}`);
      return true;
    });
  }
});
