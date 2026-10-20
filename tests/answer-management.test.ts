import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { answerFileName, describeAnswerList, sortAnswers } from "../src/answer-info.js";
import { createAnswerDocument, type AnswerDocument } from "../src/domain.js";
import { createHttpHandler } from "../src/index.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

const templateDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "templates");
const sample = (title = "資訊系統可行性評估") => createAnswerDocument({ templateId: "police_information_essay", title,
  sections: [{ id: "intro", heading: "一、前言", text: "政府建置資訊系統應以業務需求為本。" }] });
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");

async function withStore<T>(run: (store: FileStore, root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-manage-"));
  try { return await run(new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") }), root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function connect(store: FileStore, downloadBaseUrl?: string) {
  const server = createEssayMcpServer(store, { downloadBaseUrl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "answer-management-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  // Listing the tools makes the client check every structuredContent against its outputSchema.
  await client.listTools();
  return client;
}

test("readable file names, exam grouping and question order", () => {
  assert.equal(answerFileName({ title: "MIS／IS：比較*", exam: "114年警察特考", questionNo: 2 }, "docx"), "114年警察特考_第2題_MIS／IS：比較_.docx");
  assert.equal(answerFileName({ title: "a/b\\c", exam: undefined, questionNo: undefined }, "pdf"), "a_b_c.pdf");
  assert.equal(answerFileName({ title: "x".repeat(200), exam: undefined, questionNo: undefined }, "txt"), `${"x".repeat(80)}.txt`);
  assert.equal(answerFileName({ title: "CON", exam: undefined, questionNo: undefined }, "pdf"), "CON_.pdf");
  assert.equal(answerFileName({ title: "com1", exam: undefined, questionNo: undefined }, "pdf"), "com1_.pdf");
  assert.equal(answerFileName({ title: "Console", exam: undefined, questionNo: undefined }, "pdf"), "Console.pdf");
  assert.equal(answerFileName({ title: "CON.notes", exam: undefined, questionNo: undefined }, "pdf"), "CON_.notes.pdf");
  assert.equal(answerFileName({ title: "nul", exam: undefined, questionNo: undefined }, "txt"), "nul_.txt");
  assert.equal(answerFileName({ title: "COM¹.x", exam: undefined, questionNo: undefined }, "pdf"), "COM¹_.x.pdf");
  const answers = [
    { id: "ans_c", title: "未分類", version: 1, exam: undefined, questionNo: undefined },
    { id: "ans_b", title: "第二題", version: 3, exam: "114年警察特考", questionNo: 2 },
    { id: "ans_a", title: "第一題", version: 1, exam: "114年警察特考", questionNo: 1 },
  ];
  assert.deepEqual(sortAnswers(answers).map((answer) => answer.id), ["ans_a", "ans_b", "ans_c"]);
  assert.deepEqual(describeAnswerList(answers), [
    "【114年警察特考】", "・第1題 「第一題」（ans_a，第 1 版）", "・第2題 「第二題」（ans_b，第 3 版）", "【未分類】", "・「未分類」（ans_c，第 1 版）"]);
});

test("update_answer_info files an answer under an exam, and duplicate_answer copies it without touching the original", async () => {
  await withStore(async (store) => {
    const answer = sample();
    await store.saveAnswer(answer);
    await store.saveAnswer({ ...sample("另一題"), exam: "113年警察特考", questionNo: 1 } as AnswerDocument);
    const client = await connect(store);
    try {
      let result = await client.callTool({ name: "update_answer_info", arguments: { answerId: answer.id, expectedVersion: 1,
        exam: "114年警察特考", questionNo: 1, title: "MIS 與可行性評估" } });
      assert.equal(result.isError, undefined, text(result));
      assert.match(text(result), /考試：未設定→「114年警察特考」/);
      assert.match(text(result), /題號：未設定→第 1 題/);
      result = await client.callTool({ name: "update_answer_info", arguments: { answerId: answer.id, expectedVersion: 2, exam: "114年警察特考" } });
      assert.equal(result.isError, true);
      assert.match(text(result), /沒有需要儲存的變更/);

      result = await client.callTool({ name: "list_answers", arguments: {} });
      assert.match(text(result), /【113年警察特考】\n・第1題 「另一題」.*\n【114年警察特考】\n・第1題 「MIS 與可行性評估」/);

      await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 2, targets: [{ sectionId: "intro", lines: 3 }] } });
      result = await client.callTool({ name: "duplicate_answer", arguments: { answerId: answer.id } });
      assert.equal(result.isError, undefined, text(result));
      const copy = (result.structuredContent as { answer: AnswerDocument }).answer;
      assert.notEqual(copy.id, answer.id);
      assert.equal(copy.version, 1);
      assert.equal(copy.title, "MIS 與可行性評估（副本）");
      const saved = await store.getAnswer(copy.id);
      assert.deepEqual([saved.exam, saved.questionNo, saved.lineTargets], ["114年警察特考", 1, { intro: 3 }]);
      assert.deepEqual(JSON.parse(JSON.stringify(saved.sections)), JSON.parse(JSON.stringify((await store.getAnswer(answer.id)).sections)));
      assert.equal((await store.getAnswer(answer.id)).version, 3);

      result = await client.callTool({ name: "update_answer_info", arguments: { answerId: answer.id, expectedVersion: 3, exam: null, questionNo: null } });
      assert.equal(result.isError, undefined, text(result));
      const cleared = await store.getAnswer(answer.id);
      assert.deepEqual([cleared.exam, cleared.questionNo], [undefined, undefined]);
      result = await client.callTool({ name: "list_revisions", arguments: { answerId: answer.id } });
      const revisions = (result.structuredContent as { revisions: Array<{ version: number; changes: string[] }> }).revisions;
      assert.deepEqual(revisions.find((revision) => revision.version === 2)!.changes,
        ["標題：「資訊系統可行性評估」→「MIS 與可行性評估」", "考試：未設定→「114年警察特考」", "題號：未設定→第 1 題"]);
    } finally { await client.close(); }
  });
});

test("export_answer names the files after the exam and question, from one version, and refuses an overflowing answer", async () => {
  await withStore(async (store) => {
    const answer = { ...sample(), exam: "114年警察特考", questionNo: 3 } as AnswerDocument;
    await store.saveAnswer(answer);
    const client = await connect(store, "https://example.test");
    try {
      const listed = (await client.listTools()).tools.find((tool) => tool.name === "export_answer")!;
      assert.deepEqual((listed.inputSchema.properties as Record<string, { default?: unknown }>).formats.default, ["docx", "pdf"]);
      const result = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["txt"] } });
      assert.equal(result.isError, undefined, text(result));
      const files = (result.structuredContent as { files: Array<{ fileName: string; downloadUrl: string; exportUri: string }> }).files;
      assert.equal(files[0].fileName, "114年警察特考_第3題_資訊系統可行性評估.txt");
      assert.match(files[0].downloadUrl, /^https:\/\/example\.test\/downloads\/[0-9a-f-]{36}\/114%E5%B9%B4/);
      assert.match(text(result), /下載「114年警察特考_第3題_資訊系統可行性評估\.txt」（24 小時內有效）：https:\/\/example\.test\/downloads\//);
      assert.ok((result.content as Array<{ type: string; name?: string }>).some((item) => item.type === "resource_link" && item.name === files[0].fileName));

      const docx = await client.callTool({ name: "export_text", arguments: { answerId: answer.id } });
      assert.equal((docx.structuredContent as { fileName: string }).fileName, "114年警察特考_第3題_資訊系統可行性評估.txt");

      const long = { ...sample("太長"), sections: [{ id: "body", text: "很長的段落。".repeat(400) }] };
      const tooLong = createAnswerDocument({ templateId: "police_information_essay", title: long.title, sections: long.sections });
      await store.saveAnswer(tooLong);
      const refused = await client.callTool({ name: "export_answer", arguments: { answerId: tooLong.id, formats: ["txt"] } });
      assert.equal(refused.isError, true);
      assert.match(text(refused), /超出版面 \d+ 行/);
    } finally { await client.close(); }
  });
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function rpc(base: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const body = await response.text();
  return JSON.parse(body.split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result;
}

test("the download link serves the export as an attachment with its readable name", async () => {
  await withStore(async (store) => {
    const answer = { ...sample("O'Brien (草稿)"), exam: "114年警察特考", questionNo: 1 } as AnswerDocument;
    await store.saveAnswer(answer);
    const server = createServer();
    const base = await listen(server);
    server.on("request", createHttpHandler(store, { MCP_ALLOW_ANONYMOUS_LOOPBACK: "true", ESSAY_PUBLIC_BASE_URL: base }));
    try {
      const exported = await rpc(base, "export_answer", { answerId: answer.id, formats: ["txt"] });
      const file = exported.structuredContent.files[0];
      const download = await fetch(file.downloadUrl);
      assert.equal(download.status, 200);
      const disposition = download.headers.get("content-disposition") ?? "";
      assert.ok(disposition.startsWith('attachment; filename="') && disposition.endsWith(`.txt"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`), disposition);
      assert.ok(disposition.includes("%27Brien%20%28") && !/filename\*=[^;]*['()]/.test(disposition.replace("UTF-8''", "")), disposition);
      assert.equal(download.headers.get("cache-control"), "private, no-store");
      assert.match(await download.text(), /政府建置資訊系統應以業務需求為本/);
      const head = await fetch(file.downloadUrl, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal((await fetch(`${base}/downloads/00000000-0000-4000-8000-000000000000/x.txt`)).status, 404);
      assert.equal((await fetch(file.downloadUrl, { headers: { origin: "https://evil.example" } })).status, 403);
      // A tampered name falls back to the stored one instead of being echoed into the header.
      const tampered = await fetch(file.downloadUrl.replace(/\/[^/]+$/, "/%22evil%22.html"));
      assert.match(tampered.headers.get("content-disposition") ?? "", /^attachment; filename="[A-Za-z0-9_.-]+\.txt"; filename\*=UTF-8''[A-Za-z0-9_.%-]+\.txt$/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  // Without a public URL no link is offered and the route does not exist.
  await withStore(async (store) => {
    const answer = sample();
    await store.saveAnswer(answer);
    const client = await connect(store);
    try {
      const result = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["txt"] } });
      assert.equal((result.structuredContent as { files: Array<{ downloadUrl?: string }> }).files[0].downloadUrl, undefined);
      assert.doesNotMatch(text(result), /下載「/);
    } finally { await client.close(); }
  });
  assert.throws(() => createHttpHandler(new FileStore({ templateDir }), { MCP_ALLOW_ANONYMOUS_LOOPBACK: "true", ESSAY_PUBLIC_BASE_URL: "http://example.test" }),
    /ESSAY_PUBLIC_BASE_URL/);
});

test("export_answer keeps the files already made when one format fails, and passes on font warnings", async () => {
  await withStore(async (_store, root) => {
    class FailingPdfStore extends FileStore {
      override async createExportHandle(...args: Parameters<FileStore["createExportHandle"]>) {
        if (args[1].format === "pdf") throw new Error("儲存 PDF 失敗（測試）");
        return super.createExportHandle(...args);
      }
    }
    const store = new FailingPdfStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
    const answer = sample();
    await store.saveAnswer(answer);
    const client = await connect(store);
    try {
      const result = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["txt", "pdf"] } });
      assert.equal(result.isError, undefined, text(result));
      const content = result.structuredContent as { files: Array<{ format: string }>; failed: Array<{ format: string; error: string }> };
      assert.deepEqual(content.files.map((file) => file.format), ["txt"]);
      assert.deepEqual(content.failed, [{ format: "pdf", error: "儲存 PDF 失敗（測試）" }]);
      assert.match(text(result), /pdf 沒有輸出：儲存 PDF 失敗（測試）/);
      const none = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["pdf"] } });
      assert.equal(none.isError, true);
      assert.match(text(none), /pdf：儲存 PDF 失敗（測試）/);
    } finally { await client.close(); }
  });
  await withStore(async (store) => {
    // An italic paragraph without an italic font (or no CJK font at all) makes the PDF exporter warn.
    const previous = process.env.ESSAY_MCP_PDF_ITALIC_FONT;
    delete process.env.ESSAY_MCP_PDF_ITALIC_FONT;
    const answer = createAnswerDocument({ templateId: "police_information_essay", title: "Italic",
      sections: [{ id: "a", paragraphs: [{ text: "Italic text.", format: { italic: true } }] }] });
    await store.saveAnswer(answer);
    const client = await connect(store);
    try {
      const result = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["pdf"] } });
      assert.equal(result.isError, undefined, text(result));
      const file = (result.structuredContent as { files: Array<{ fontWarning?: string }> }).files[0];
      assert.ok(file.fontWarning, JSON.stringify(file));
      assert.ok(text(result).includes(file.fontWarning!));
    } finally {
      await client.close();
      if (previous !== undefined) process.env.ESSAY_MCP_PDF_ITALIC_FONT = previous;
    }
  });
});
