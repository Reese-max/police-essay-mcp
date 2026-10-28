import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnswerDocument, type AnswerDocument, type AnswerSnapshot } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { layoutWarnings, type LayoutWarning, type SectionLines } from "../src/planning.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore, isStoreNotFound } from "../src/storage.js";
import { exportPdf, exportPdfBundle } from "../src/exporters.js";
import { POLICE_ESSAY_WIDGET_HTML } from "../src/widget.js";

const templateDir = path.resolve("templates");
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text?: string }>).map(item => item.text ?? "").join("\n");
function data<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  assert.equal(result.isError, undefined, text(result));
  return result.structuredContent as T;
}
async function withClient(run: (client: Client, store: FileStore) => Promise<void>, options: Parameters<typeof createEssayMcpServer>[1] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-exam-workflow-"));
  const store = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store, options);
  const client = new Client({ name: "exam-workflow-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); await client.listTools();
  try { await run(client, store); }
  finally { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const sample = (title: string, lines = 2) => createAnswerDocument({ templateId: "police_information_essay", title,
  sections: [{ id: "body", text: Array.from({ length: lines }, (_, index) => `第${index + 1}行論述。`).join("\n") }] });
const artifactNames = async (store: FileStore) => fs.readdir(store.artifactDir).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [] as string[];
  throw error;
});

test("create stores exam/question/targets in revision 1 and invalid targets save nothing", async () => withClient(async (client, store) => {
  const args = { title: "第一題", exam: "114年警察特考", questionNo: 1, sections: [{ id: "intro", heading: "前言", text: "論述。" }],
    lineTargets: [{ sectionId: "intro", lines: 3 }] };
  const created = await client.callTool({ name: "create_answer", arguments: args });
  const id = data<{ answer: { id: string; version: number } }>(created).answer.id;
  assert.match(text(created), /114年警察特考.*第 1 題/);
  assert.match(text(created), /各節：.*目標 3/);
  const read = data<AnswerSnapshot>(await client.callTool({ name: "read_answer", arguments: { answerId: id } }));
  assert.equal(read.answer.version, 1);
  assert.equal(read.answer.exam, args.exam); assert.equal(read.answer.questionNo, 1);
  assert.deepEqual(read.answer.lineTargets, { intro: 3 });
  assert.deepEqual((await store.getRevision(id, 1)).lineTargets, { intro: 3 });
  const check = data<{ sections: SectionLines[] }>(await client.callTool({ name: "check_layout", arguments: { answerId: id } }));
  assert.equal(check.sections[0].targetLines, 3);
  const count = (await store.listAnswers()).length;
  for (const lineTargets of [[{ sectionId: "missing", lines: 3 }], [{ sectionId: "intro", lines: 3 }, { sectionId: "intro", lines: 4 }]]) {
    const invalid = await client.callTool({ name: "create_answer", arguments: { ...args, lineTargets } });
    assert.equal(invalid.isError, true);
    assert.match(text(invalid), lineTargets.length === 1 ? /找不到 sectionId.*lineTargets.*sections.*id/ : /重複的 lineTargets sectionId/);
    assert.equal((await store.listAnswers()).length, count);
    assert.equal(data<{ answers: unknown[] }>(await client.callTool({ name: "list_answers", arguments: {} })).answers.length, count);
  }
}));

test("default writes are at least five times smaller; full writes preserve complete snapshots", async () => withClient(async (client, store) => {
  for (const name of ["edit_text", "replace_text", "write_answer"] as const) {
    const answer = sample(name, 40); await store.saveAnswer(answer);
    const args = name === "edit_text" ? { edits: [{ find: "第1行", replace: "首行" }] }
      : name === "replace_text" ? { sectionId: "body", newText: answer.sections[0].text }
      : { sections: answer.sections };
    const summary = data<{ answer: Record<string, unknown>; layout: Record<string, unknown>; detail: string; sections: SectionLines[]; section?: Record<string, unknown> }>(
      await client.callTool({ name, arguments: { answerId: answer.id, expectedVersion: 1, ...args } }));
    assert.equal(summary.detail, "summary");
    assert.equal(Object.hasOwn(summary.answer, "sections"), false);
    assert.equal(Object.hasOwn(summary.answer, "question"), false);
    assert.equal(Object.hasOwn(summary.answer, "lineTargets"), false);
    assert.equal(Object.hasOwn(summary.layout, "lines"), false);
    assert.equal(Object.hasOwn(summary.layout, "compressionHints"), false);
    assert.equal(summary.sections[0].lines, 40);
    assert.ok(Array.isArray(summary.layout.pageUsage));
    if (summary.section) {
      assert.ok(Object.keys(summary.section).every(key => ["id", "heading", "order"].includes(key)));
      assert.equal(summary.section.id, "body");
    }
    const fullArgs = name === "edit_text" ? { edits: [{ find: "首行", replace: "第1行" }] } : args;
    const full = data<AnswerSnapshot>(await client.callTool({ name, arguments: { answerId: answer.id, expectedVersion: 2, ...fullArgs, responseDetail: "full" } }));
    assert.equal(full.answer.sections.length, 1); assert.equal(full.layout.lines.length, 40);
    assert.equal(Object.hasOwn(full, "detail"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) * 5 <= Buffer.byteLength(JSON.stringify(full)), name);
  }
}));

test("widget requests full snapshots on both write paths", () => {
  assert.match(POLICE_ESSAY_WIDGET_HTML, /callTool\(name, \{ \.\.\.args, responseDetail: "full" \}\)/);
  assert.match(POLICE_ESSAY_WIDGET_HTML, /callTool\("replace_text", \{ \.\.\.edit.args, responseDetail: "full" \}\)/);
});

test("stale export_answer never creates a handle", async () => withClient(async (client, store) => {
  const answer = sample("釘選版本"); await store.saveAnswer(answer);
  const before = await artifactNames(store);
  const result = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, expectedVersion: 2, formats: ["txt"] } });
  assert.equal(result.isError, true); assert.match(text(result), /^VERSION_CONFLICT/);
  assert.match(text(result), /目前版本 1，預期 2.*read_answer\/check_layout/);
  assert.deepEqual(await artifactNames(store), before);
}));

type Bundle = { files: Array<{ format: string; fileName: string; exportUri: string; pages: number; downloadUrl?: string; fontWarning?: string }>;
  answers: Array<{ answerId: string; version: number; pages: number; startPage: number; endPage: number; warnings: LayoutWarning[] }>; totalPages: number };
const readArtifact = (store: FileStore, uri: string) => store.readExport(uri.split("/").at(-1)!);
const pdfPageCount = (data: Buffer) => (data.toString("latin1").match(/\/Type \/Page\b/g) ?? []).length;
const pdfString = (value: string) => Buffer.from("\ufeff" + value, "utf16le").swap16().toString("latin1")
  .replace(/[\n\r\t\b\f()\\]/g, character => ({ "\n": "\\n", "\r": "\\r", "\t": "\\t", "\b": "\\b", "\f": "\\f", "(": "\\(", ")": "\\)", "\\": "\\\\" }[character]!));

test("exam bundle preserves single PDF pages, bookmarks, TXT separators and manifest order", async () => withClient(async (client, store) => {
  const first = { ...sample("甲題", 24), exam: "114年警察特考", questionNo: 4 };
  const second = sample("乙題");
  await store.saveAnswer(first); await store.saveAnswer(second);
  const singles = [];
  for (const answer of [first, second]) {
    const single = data<{ files: Bundle["files"] }>(await client.callTool({ name: "export_answer", arguments: {
      answerId: answer.id, expectedVersion: 1, formats: ["pdf", "txt"] } }));
    singles.push(await Promise.all(single.files.map(file => readArtifact(store, file.exportUri))));
  }
  const bundled = await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [first, second].map(answer => ({ answerId: answer.id, expectedVersion: 1 })), formats: ["pdf", "txt"] } });
  const result = data<Bundle>(bundled);
  assert.equal(result.files.length, 2); assert.equal(result.totalPages, 4);
  assert.deepEqual(result.answers.map(answer => [answer.answerId, answer.version, answer.pages, answer.startPage, answer.endPage]),
    [[first.id, 1, 2, 1, 2], [second.id, 1, 2, 3, 4]]);
  assert.ok(result.answers.every(answer => Array.isArray(answer.warnings)));
  assert.equal(result.files[0].fileName, "114年警察特考_合輯.pdf");
  assert.match(result.files[0].downloadUrl!, /https:\/\/example.test\/downloads\//);
  const pdf = await readArtifact(store, result.files[0].exportUri);
  const txt = await readArtifact(store, result.files[1].exportUri);
  assert.equal(pdfPageCount(pdf.data), singles.reduce((sum, files) => sum + pdfPageCount(files[0].data), 0));
  const raw = pdf.data.toString("latin1").toLowerCase();
  for (const bookmark of ["第4題 甲題", "第2題 乙題"]) assert.ok(raw.includes(pdfString(bookmark).toLowerCase()), bookmark);
  assert.equal((raw.match(/\/title /g) ?? []).length, 2);
  assert.equal(txt.data.toString("utf8"), singles.map(files => files[1].data.toString("utf8").slice(0, -1)).join("\n\f\n") + "\n");
  assert.equal(pdf.answerId, first.id); assert.equal(pdf.answerVersion, 1);
  assert.equal((bundled.content as Array<{ type: string }>).filter(item => item.type === "resource_link").length, 2);
  const reversed = data<Bundle>(await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [{ answerId: second.id, expectedVersion: 1 }, { answerId: first.id, expectedVersion: 1 }], formats: ["txt"], title: "自訂合輯" } }));
  assert.deepEqual(reversed.answers.map(answer => answer.answerId), [second.id, first.id]);
  assert.equal(reversed.files[0].fileName, "自訂合輯.txt");
}, { downloadBaseUrl: "https://example.test" }));

test("exam validation collects all failures and renders nothing; overflow is explicitly opt-in", async () => withClient(async (client, store) => {
  const good = sample("正常"); const overflow = sample("超頁", 45);
  await store.saveAnswer(good); await store.saveAnswer(overflow);
  let handles = 0;
  const createHandle = store.createExportHandle.bind(store);
  store.createExportHandle = async (...args) => { handles++; return createHandle(...args); };
  const pin = (answer: AnswerDocument, version = 1) => ({ answerId: answer.id, expectedVersion: version });
  const stale = await client.callTool({ name: "export_exam_bundle", arguments: { answers: [pin(good), pin(overflow, 2)] } });
  assert.equal(stale.isError, true); assert.match(text(stale), new RegExp(`^VERSION_CONFLICT ${overflow.id}`));
  assert.equal(text(stale).split("\n").length, 1);
  assert.doesNotMatch(text(stale), /LAYOUT_OVERFLOW/);
  assert.equal(text(stale).includes(good.id), false); assert.equal(handles, 0);
  const all = await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [pin(good, 2), pin(overflow), { answerId: "ans_missing", expectedVersion: 1 }] } });
  assert.equal(all.isError, true);
  assert.match(text(all), /VERSION_CONFLICT/); assert.match(text(all), /LAYOUT_OVERFLOW.*超出 1 行/); assert.match(text(all), /ANSWER_NOT_FOUND/);
  assert.equal(text(all).split("\n").length, 3); assert.equal(handles, 0);
  assert.deepEqual(await artifactNames(store), []);
  const duplicate = await client.callTool({ name: "export_exam_bundle", arguments: { answers: [pin(good), pin(good)] } });
  assert.equal(duplicate.isError, true); assert.match(text(duplicate), /不可重複/); assert.equal(handles, 0);
  const allowed = data<Bundle>(await client.callTool({ name: "export_exam_bundle", arguments: { answers: [pin(overflow)], formats: ["txt"], allowOverflow: true } }));
  assert.equal(allowed.totalPages, 3); assert.equal(handles, 1);
}));

test("bundle aggregates template, snapshot and 166 preflight errors with other answers", async () => withClient(async (client, store) => {
  const missingTemplate = { ...sample("模板缺失"), templateId: "missing_template" };
  const invalidLayout = sample("縮排無效");
  invalidLayout.sections[0].paragraphs = [{ text: "論述", format: { leftIndent: 100 } }];
  const paper = { ...sample("原稿紙設定"), templateId: "police_information_essay_166", sections: [] };
  const stale = sample("版本不同", 45);
  const loaded = new Map([missingTemplate, invalidLayout, paper, stale].map(answer => [answer.id, answer]));
  // Simulate stored data that fails during snapshot construction, before any rendering.
  store.getAnswer = async id => { const answer = loaded.get(id); assert.ok(answer); return answer; };
  const getTemplate = store.getTemplate.bind(store);
  store.getTemplate = async id => {
    const template = await getTemplate(id);
    // Empty sections need no wrapping font; outputPageCount must reject this invalid 166 geometry.
    return id === paper.templateId ? { ...template, fontSizePt: 18 } : template;
  };
  let handles = 0;
  store.createExportHandle = async () => { handles++; throw new Error("unexpected handle"); };
  const result = await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [...loaded.values()].map(answer => ({ answerId: answer.id, expectedVersion: answer === stale ? 2 : 1 })), allowOverflow: true,
  } });
  assert.equal(result.isError, true);
  const failures = text(result).split("\n");
  assert.equal(failures.length, 4);
  for (const answer of [missingTemplate, invalidLayout, paper]) assert.ok(failures.some(line => line.startsWith(`LAYOUT_INVALID ${answer.id}：`)), text(result));
  assert.match(failures[1], /縮排/);
  assert.match(failures[2], /頁數、行數、字級/);
  assert.match(failures[3], new RegExp(`^VERSION_CONFLICT ${stale.id}`));
  assert.equal(handles, 0);
}));

test("a second-format rendering failure creates no handles", async () => withClient(async (client, store) => {
  const answer = sample("格式失敗"); await store.saveAnswer(answer);
  const resolve = store.resolveExportPath.bind(store);
  let formats = 0, handles = 0;
  store.resolveExportPath = (name, format) => {
    formats++;
    if (format === "txt") throw new Error("模擬第二格式失敗");
    return resolve(name, format);
  };
  store.createExportHandle = async () => { handles++; throw new Error("unexpected handle"); };
  const result = await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["pdf", "txt"],
  } });
  assert.equal(result.isError, true); assert.match(text(result), /模擬第二格式失敗/);
  assert.equal(formats, 2); assert.equal(handles, 0);
  assert.deepEqual(await artifactNames(store), []);
}));

test("bundle preserves PDF font warnings in its file and text results", async () => withClient(async (client, store) => {
  const answer = sample("Font warning"); await store.saveAnswer(answer);
  const invalidFont = path.join(store.answerDir, "invalid-font.ttf");
  await fs.writeFile(invalidFont, "not a font");
  const previous = process.env.ESSAY_MCP_PDF_FONT;
  process.env.ESSAY_MCP_PDF_FONT = invalidFont;
  try {
    const result = await client.callTool({ name: "export_exam_bundle", arguments: {
      answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["pdf", "txt"],
    } });
    const files = data<Bundle>(result).files;
    assert.match(files[0].fontWarning!, /Helvetica/);
    assert.ok(text(result).includes(`${files[0].fileName}：${files[0].fontWarning}`));
    assert.equal(Object.hasOwn(files[1], "fontWarning"), false);
  } finally {
    if (previous === undefined) delete process.env.ESSAY_MCP_PDF_FONT;
    else process.env.ESSAY_MCP_PDF_FONT = previous;
  }
}));

test("bundle requires export scope and is absent on read-only servers", async () => {
  for (const [options, present] of [[{ readOnly: true }, false], [{ scopes: ["essay.read", "essay.write"] }, false],
    [{ scopes: ["essay.read", "essay.export"] }, true]] as const) {
    await withClient(async client => {
      assert.equal((await client.listTools()).tools.some(tool => tool.name === "export_exam_bundle"), present);
    }, "scopes" in options ? { scopes: [...options.scopes] } : { readOnly: options.readOnly });
  }
});

test("quality warnings detect orphan headings and split Latin words without modifying the layout", async () => withClient(async (client, store) => {
  const template = await store.getTemplate("police_information_essay");
  const answer = createAnswerDocument({ templateId: template.id, title: "品質警告", sections: [
    { id: "padding", text: Array.from({ length: 21 }, () => "論述。").join("\n") },
    { id: "orphan", heading: "標題", text: "正文。" },
    { id: "latin", text: "A".repeat(template.columns + 2) },
  ] });
  const report = layoutSections(template, answer.sections);
  const before = JSON.stringify(report);
  const warnings = layoutWarnings(report);
  assert.equal(JSON.stringify(report), before);
  assert.deepEqual(warnings.map(({ code, sectionId, page, line }) => ({ code, sectionId, page, line })), [
    { code: "ORPHAN_HEADING", sectionId: "orphan", page: 1, line: 22 },
    { code: "SPLIT_LATIN_WORD", sectionId: "latin", page: 2, line: 2 },
  ]);
  assert.ok(warnings.every(warning => /不阻擋匯出.*建議/.test(warning.message)));
  assert.deepEqual(layoutWarnings(layoutSections(template, sample("正常").sections)), []);
  // Different paragraphs and intervening spaces must not be reported as broken words.
  const separate = createAnswerDocument({ templateId: template.id, title: "英文", sections: [{ text: "Hello\nWorld" }] });
  assert.deepEqual(layoutWarnings(layoutSections(template, separate.sections)), []);
  for (const firstWordLength of [template.columns - 1, template.columns]) {
    const spaced = createAnswerDocument({ templateId: template.id, title: "英文空格", sections: [{ text: "A".repeat(firstWordLength) + " World" }] });
    const wrapped = layoutSections(template, spaced.sections);
    assert.equal(wrapped.lines.length, 2);
    assert.equal(wrapped.lines[0].paragraphIndex, wrapped.lines[1].paragraphIndex);
    if (firstWordLength < template.columns) assert.match(wrapped.lines[0].text, / $/);
    else assert.match(wrapped.lines[1].text, /^ /);
    assert.deepEqual(layoutWarnings(wrapped), []);
  }
  await store.saveAnswer(answer);
  const check = await client.callTool({ name: "check_layout", arguments: { answerId: answer.id } });
  assert.deepEqual(data<{ warnings: LayoutWarning[] }>(check).warnings, warnings);
  assert.match(text(check), /ORPHAN_HEADING/); assert.match(text(check), /SPLIT_LATIN_WORD/);
  const bundled = await client.callTool({ name: "export_exam_bundle", arguments: { answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["txt"] } });
  const bundle = data<Bundle>(bundled);
  assert.deepEqual(bundle.answers[0].warnings, warnings);
  for (const warning of warnings) assert.ok(text(bundled).includes(`\n  ${warning.code} 第 ${warning.page} 頁第 ${warning.line} 行：${warning.message}`));
}));

test("166 bundle shares its single PDF font and two-page policy", { skip: !process.env.ESSAY_MCP_PAPER_FONT }, async () => withClient(async (client, store) => {
  const answer = createAnswerDocument({ templateId: "police_information_essay_166", title: "原稿紙", sections: [{ text: "原稿紙內容。" }] });
  await store.saveAnswer(answer);
  const single = data<{ files: Bundle["files"] }>(await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["pdf"] } }));
  const bundle = data<Bundle>(await client.callTool({ name: "export_exam_bundle", arguments: { answers: [{ answerId: answer.id, expectedVersion: 1 }] } }));
  const standalone = await readArtifact(store, single.files[0].exportUri);
  const combined = await readArtifact(store, bundle.files[0].exportUri);
  assert.equal(pdfPageCount(combined.data), 2);
  const fontNames = (buffer: Buffer) => buffer.toString("latin1").match(/\/BaseFont\s*\/[^\s/]+/g)?.map(name => name.replace(/\/[A-Z]{6}\+/, "/"));
  assert.deepEqual(fontNames(combined.data), fontNames(standalone.data));
  const before = await artifactNames(store);
  const invalid = await client.callTool({ name: "export_exam_bundle", arguments: { answers: [{ answerId: answer.id, expectedVersion: 1 }], allowOverflow: true } });
  assert.equal(invalid.isError, true); assert.match(text(invalid), /兩頁44行/);
  assert.deepEqual(await artifactNames(store), before);
}));

test("idempotent create preserves raw canonical request, replays current state and never copies its hash", async () => withClient(async (client, store) => {
  const args = { title: "可重試", idempotencyKey: "retry_key_01", exam: "測試", questionNo: 4,
    question: "題目", lineTargets: [{ sectionId: "body", lines: 4 }], sections: [{ id: "body", text: "第一段\r\n第二段", paragraphFormat: { leftIndent: 2 } }] };
  const created = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: args }));
  const id = "ans_idem-" + createHash("sha256").update(args.idempotencyKey).digest("hex").slice(0, 40);
  assert.equal(created.answer.id, id);
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  const { idempotencyKey: _key, ...request } = args;
  const expectedHash = createHash("sha256").update(canonical({ templateId: "police_information_essay", ...request })).digest("hex");
  assert.equal((await store.getAnswer(id)).createRequestHash, expectedHash);
  let saves = 0;
  const save = store.saveAnswer.bind(store);
  store.saveAnswer = async (...args) => { saves++; return save(...args); };
  const reordered = { ...args, sections: [{ paragraphFormat: { leftIndent: 2 }, text: args.sections[0].text, id: "body" }] };
  const replay = await client.callTool({ name: "create_answer", arguments: reordered });
  const repeated = data<AnswerSnapshot & { replayed: boolean }>(replay);
  assert.equal(repeated.replayed, true); assert.equal(repeated.answer.id, id); assert.equal(repeated.answer.version, 1);
  assert.match(text(replay), new RegExp(`^重送：此 idempotencyKey 已建立 ${id}（目前第 1 版），未重複建立。`));
  assert.equal(data<{ answers: unknown[] }>(await client.callTool({ name: "list_answers", arguments: {} })).answers.length, 1);
  assert.equal((await store.listRevisions(id, { limit: 10 })).length, 1); assert.equal(saves, 0);
  const before = await store.getAnswer(id);
  for (const changes of [{ title: "不同請求" }, { sections: [{ ...args.sections[0], required: false }] }]) {
    const reused = await client.callTool({ name: "create_answer", arguments: { ...args, ...changes } });
    assert.equal(reused.isError, true); assert.match(text(reused), /^IDEMPOTENCY_KEY_REUSED/);
    assert.deepEqual(await store.getAnswer(id), before); assert.equal(saves, 0);
  }
  await save({ ...before, title: "修改後", version: 2 }, { expectedVersion: 1 });
  const latest = data<AnswerSnapshot & { replayed: boolean }>(await client.callTool({ name: "create_answer", arguments: { ...args, responseDetail: "full" } }));
  assert.equal(latest.replayed, true); assert.equal(latest.answer.version, 2); assert.equal(latest.answer.title, "修改後");
  assert.equal(latest.answer.sections[0].text, "第一段\n第二段"); assert.equal(Object.hasOwn(latest.answer, "createRequestHash"), false); assert.equal((await store.getAnswer(id)).createRequestHash, expectedHash); assert.equal(saves, 0);
  const copy = data<AnswerSnapshot>(await client.callTool({ name: "duplicate_answer", arguments: { answerId: id, responseDetail: "full" } }));
  assert.equal(Object.hasOwn(copy.answer, "createRequestHash"), false);
  assert.equal(Object.hasOwn(await store.getAnswer(copy.answer.id), "createRequestHash"), false);
}));

test("create handles a missed preflight race and rejects a legacy id without a request hash", async () => withClient(async (client, store) => {
  const args = { title: "競態", idempotencyKey: "race_key_01", sections: [{ text: "正文" }] };
  const first = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: args }));
  const get = store.getAnswer.bind(store); let missed = false, saves = 0;
  store.getAnswer = async id => {
    if (!missed && id === first.answer.id) { missed = true; throw Object.assign(new Error("missing once"), { code: "ENOENT" }); }
    return get(id);
  };
  const save = store.saveAnswer.bind(store);
  store.saveAnswer = async (...args) => { saves++; return save(...args); };
  const raced = data<AnswerSnapshot & { replayed: boolean }>(await client.callTool({ name: "create_answer", arguments: args }));
  assert.equal(missed, true); assert.equal(saves, 1); assert.equal(raced.replayed, true);
  assert.equal(raced.answer.id, first.answer.id); assert.equal(raced.answer.version, 1); assert.equal((await store.listAnswers()).length, 1);
  const legacy = { ...sample("舊資料"), id: "ans_idem-" + createHash("sha256").update("legacy_key").digest("hex").slice(0, 40) };
  await save(legacy);
  const reused = await client.callTool({ name: "create_answer", arguments: { title: legacy.title, idempotencyKey: "legacy_key" } });
  assert.equal(reused.isError, true); assert.match(text(reused), /^IDEMPOTENCY_KEY_REUSED/);
  assert.deepEqual(await get(legacy.id), JSON.parse(JSON.stringify(legacy)));
}));

type Batch = { answers: Array<{ index: number; answerId: string; title: string; exam?: string; questionNo?: number;
  version: number; fits: boolean; totalLines: number; capacity: number; overflowLines: number; replayed?: boolean }> };
const batchRequests = () => [1, 2, 3].map(index => ({ title: `題目${index}`, exam: "測試考試", questionNo: index,
  idempotencyKey: `batch_key_${index}`, sections: [{ id: "body", text: `答案${index}` }] }));

test("batch creates ordered summaries and replays every item without saving again", async () => withClient(async (client, store) => {
  const answers = batchRequests();
  const result = await client.callTool({ name: "create_answers", arguments: { answers } });
  const first = data<Batch>(result).answers;
  assert.equal(first.length, 3); assert.equal(result._meta, undefined);
  assert.deepEqual(first.map(item => [item.index, item.title, item.questionNo, item.version]), [[1, "題目1", 1, 1], [2, "題目2", 2, 1], [3, "題目3", 3, 1]]);
  assert.ok(first.every(item => item.fits && item.exam === "測試考試" && item.totalLines === 1 && item.capacity === 44 && item.overflowLines === 0));
  assert.equal(text(result).split("\n").length, 3);
  let saves = 0; store.saveAnswer = async () => { saves++; throw new Error("unexpected save"); };
  const replayed = data<Batch>(await client.callTool({ name: "create_answers", arguments: { answers } })).answers;
  assert.deepEqual(replayed.map(item => item.answerId), first.map(item => item.answerId));
  assert.ok(replayed.every(item => item.replayed && item.version === 1));
  assert.equal(saves, 0); assert.equal((await store.listAnswers()).length, 3);
}));

test("batch validation lists only failed item indices and never saves any item", async () => withClient(async (client, store) => {
  const answers = [batchRequests()[0],
    { title: "錯誤目標", sections: [{ id: "body", text: "文" }], lineTargets: [{ sectionId: "missing", lines: 3 }] },
    { title: "未知模板", templateId: "missing_template" }, { title: "錯誤欄位", sections: [{ text: 42 }] },
    { title: "無法排版", sections: [{ text: "文", paragraphFormat: { leftIndent: 100 } }] },
    { title: "重複區塊", sections: [{ id: "same", text: "甲" }, { id: "same", text: "乙" }] },
    { title: "非 strict", extra: true }];
  const invalid = await client.callTool({ name: "create_answers", arguments: { answers } });
  assert.equal(invalid.isError, true);
  const lines = text(invalid).split("\n");
  assert.deepEqual(lines.map(line => line.match(/^第 (\d+) 項 ([A-Z_]+)：/)?.slice(1)),
    [["2", "INVALID_INPUT"], ["3", "TEMPLATE_NOT_FOUND"], ["4", "INVALID_INPUT"], ["5", "LAYOUT_INVALID"], ["6", "INVALID_INPUT"], ["7", "INVALID_INPUT"]]);
  assert.match(lines[2], /sections.0.text/); assert.equal((await store.listAnswers()).length, 0);
  const duplicate = await client.callTool({ name: "create_answers", arguments: { answers: [batchRequests()[0], batchRequests()[0]] } });
  assert.equal(duplicate.isError, true); assert.match(text(duplicate), /^第 2 項 INVALID_INPUT：.*idempotencyKey/);
  assert.equal((await store.listAnswers()).length, 0);
  const created = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: batchRequests()[0] }));
  const reuse = await client.callTool({ name: "create_answers", arguments: { answers: [batchRequests()[1], { ...batchRequests()[0], title: "改請求" }] } });
  assert.equal(reuse.isError, true); assert.match(text(reuse), /^第 2 項 IDEMPOTENCY_KEY_REUSED/);
  assert.deepEqual((await store.listAnswers()).map(item => item.id), [created.answer.id]);
}));

test("mid-batch save failure reports the committed answer and safe retry completes the batch", async () => withClient(async (client, store) => {
  const answers = batchRequests(); const save = store.saveAnswer.bind(store); let saves = 0;
  store.saveAnswer = async (...args) => { if (++saves === 2) throw new Error("模擬 I/O 失敗"); return save(...args); };
  const failed = await client.callTool({ name: "create_answers", arguments: { answers } });
  assert.equal(failed.isError, true);
  const committed = await store.listAnswers(); assert.equal(committed.length, 1);
  assert.ok(text(failed).includes(`第 1 項 ${committed[0].id}`));
  assert.match(text(failed), /第 2 項建立失敗：模擬 I\/O 失敗/); assert.match(text(failed), /相同 idempotencyKeys 重試同一批次可避免重複/);
  store.saveAnswer = save;
  const retry = data<Batch>(await client.callTool({ name: "create_answers", arguments: { answers } }));
  assert.deepEqual(retry.answers.map(item => Boolean(item.replayed)), [true, false, false]);
  assert.equal((await store.listAnswers()).length, 3);
}));

test("batch needs write scope; data reads have no widget but explicit canvas tools keep it", async () => {
  for (const options of [{ readOnly: true }, { scopes: ["essay.read", "essay.export"] }, { scopes: ["essay.read", "essay.write"] }, {}]) {
    await withClient(async client => {
      const tools = (await client.listTools()).tools;
      assert.equal(tools.some(tool => tool.name === "create_answers"), !('readOnly' in options) && !("scopes" in options && !(options.scopes ?? []).includes("essay.write")));
      const read = tools.find(tool => tool.name === "read_answer")!;
      assert.equal((read._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, undefined);
      assert.equal(read._meta?.["openai/outputTemplate"], undefined);
      for (const name of ["render_answer_sheet", "load_exam_paper", ...tools.some(tool => tool.name === "create_answer") ? ["create_answer"] : []]) {
        assert.ok((tools.find(tool => tool.name === name)?._meta?.ui as { resourceUri?: string })?.resourceUri, name);
      }
      const batch = tools.find(tool => tool.name === "create_answers");
      if (batch) {
        assert.equal(batch._meta?.ui, undefined);
        const item = ((batch.inputSchema.properties!.answers as { items: Record<string, unknown> }).items);
        assert.equal(item.additionalProperties, false);
        const section = ((item.properties as Record<string, unknown>).sections as { items: Record<string, unknown> }).items;
        assert.deepEqual(section.additionalProperties, {});
      }
    }, options);
  }
});

test("paragraph TXT rebuilds numbered headings and wrapped paragraphs exactly, with bundle labels", async () => withClient(async (client, store) => {
  const heading = "很長的標題".repeat(10), paragraph = "正文含空白 A B 與標點，".repeat(16);
  const doc = createAnswerDocument({ templateId: "police_information_essay", title: "甲題", sections: [
    { id: "one", heading: "五、" + heading, headingStyle: { numbered: true }, paragraphs: [{ text: paragraph }, { text: "次段 原有空白" }],
      paragraphFormat: { leftIndent: 2, firstLineIndent: 4, alignment: "justify", spaceBeforeLines: 1, spaceAfterLines: 1 } },
    { id: "two", heading: "次節", headingStyle: { numbered: true, numbering: "arabic", separator: "." }, text: "結論。" },
  ] });
  const first = { ...doc, questionNo: 4 }; const second = sample("乙題", 1);
  await store.saveAnswer(first); await store.saveAnswer(second);
  const expected = `壹、${heading}\n${paragraph}\n次段 原有空白\n\n2.次節\n結論。\n`;
  const single = data<{ files: Bundle["files"] }>(await client.callTool({ name: "export_answer", arguments: { answerId: first.id, formats: ["txt"], textMode: "paragraphs" } }));
  assert.equal(single.files[0].fileName, "第4題_甲題_段落.txt"); assert.equal(single.files[0].pages, 2);
  assert.equal((await readArtifact(store, single.files[0].exportUri)).data.toString("utf8"), expected);
  const bundled = data<Bundle>(await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [first, second].map(answer => ({ answerId: answer.id, expectedVersion: 1 })), formats: ["txt"], textMode: "paragraphs" } }));
  assert.equal(bundled.files[0].fileName, "申論合輯_段落.txt"); assert.equal(bundled.files[0].pages, 4);
  const content = (await readArtifact(store, bundled.files[0].exportUri)).data.toString("utf8");
  assert.equal(content, `第4題 甲題\n\n${expected}\n第2題 乙題\n\n${second.sections[0].text}\n`); assert.equal(content.includes("\f"), false);
  const paper = data<{ files: Bundle["files"] }>(await client.callTool({ name: "export_answer", arguments: { answerId: first.id, formats: ["txt"], textMode: "paper" } }));
  assert.ok((await readArtifact(store, paper.files[0].exportUri)).data.toString("utf8").includes("\f"));
  const overflow = sample("超頁", 45); await store.saveAnswer(overflow); const before = await artifactNames(store);
  const refused = await client.callTool({ name: "export_answer", arguments: { answerId: overflow.id, formats: ["txt"], textMode: "paragraphs" } });
  assert.equal(refused.isError, true); assert.deepEqual(await artifactNames(store), before);
  const allowed = data<{ files: Bundle["files"] }>(await client.callTool({ name: "export_answer", arguments: { answerId: overflow.id, formats: ["txt"], textMode: "paragraphs", allowOverflow: true } }));
  assert.equal(allowed.files[0].pages, 3);
}));

test("file bundles follow every member, preserve unrelated artifacts and read legacy manifests", async () => withClient(async (client, store) => {
  const [a, b, c] = ["甲", "乙", "丙"].map(title => sample(title));
  for (const answer of [a, b, c]) await store.saveAnswer(answer);
  const result = data<Bundle>(await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [a, b].map(answer => ({ answerId: answer.id, expectedVersion: 1 })), formats: ["txt"] } }));
  const handle = result.files[0].exportUri.split("/").at(-1)!;
  const manifest = JSON.parse(await fs.readFile(path.join(store.artifactDir, handle + ".json"), "utf8"));
  assert.deepEqual(manifest.relatedAnswerIds, [a.id, b.id]);
  const unrelated = data<{ deletedExports: number }>(await client.callTool({ name: "delete_answer", arguments: { answerId: c.id, expectedVersion: 1 } }));
  assert.equal(unrelated.deletedExports, 0); await store.readExport(handle);
  const removed = data<{ deletedExports: number }>(await client.callTool({ name: "delete_answer", arguments: { answerId: b.id, expectedVersion: 1 } }));
  assert.equal(removed.deletedExports, 1); await assert.rejects(store.readExport(handle), isStoreNotFound);
  assert.deepEqual(await artifactNames(store), []);
  const legacy = data<{ files: Bundle["files"] }>(await client.callTool({ name: "export_answer", arguments: { answerId: a.id, formats: ["txt"] } }));
  const legacyHandle = legacy.files[0].exportUri.split("/").at(-1)!;
  const old = JSON.parse(await fs.readFile(path.join(store.artifactDir, legacyHandle + ".json"), "utf8"));
  assert.equal(Object.hasOwn(old, "relatedAnswerIds"), false); await store.readExport(legacyHandle);
  await store.deleteExport(legacyHandle); await store.deleteExport(legacyHandle); assert.deepEqual(await artifactNames(store), []);
}));

test("file bundle rolls back an earlier handle on second-format handle failure and names rollback orphans", async () => withClient(async (client, store) => {
  const answer = sample("回收"); await store.saveAnswer(answer);
  const createHandle = store.createExportHandle.bind(store); const remove = store.deleteExport.bind(store);
  for (const rollbackFails of [false, true]) {
    let calls = 0, orphan = "";
    store.createExportHandle = async (...args) => {
      if (++calls === 2) throw new Error("第二 handle 失敗");
      const result = await createHandle(...args); orphan = result.handle; return result;
    };
    store.deleteExport = rollbackFails ? async () => { throw new Error("回收 I/O 失敗"); } : remove;
    const result = await client.callTool({ name: "export_exam_bundle", arguments: {
      answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["pdf", "txt"] } });
    assert.equal(result.isError, true); assert.match(text(result), /合輯 txt.*第二 handle 失敗/);
    if (rollbackFails) { assert.ok(text(result).includes(orphan)); await remove(orphan); }
    assert.deepEqual(await artifactNames(store), []);
  }
}));

type ExamOverview = AnswerSnapshot & { warningCount: number; activeAnswerId: string; examAnswers: Array<{ answerId: string; title: string; exam?: string;
  questionNo?: number; version: number; totalLines: number; capacity: number; fits: boolean; warnings: number }> };

test("exam overview returns the selected full snapshot and ordered authoritative question stats", async () => withClient(async (client, store) => {
  const first = { ...sample("第一份", 45), exam: "114年警察特考", questionNo: 4 };
  const second = createAnswerDocument({ templateId: first.templateId, title: "第二份", sections: [{ text: "A".repeat(100) }] });
  await store.saveAnswer(first); await store.saveAnswer(second);
  const answerIds = [second.id, first.id];
  const result = await client.callTool({ name: "render_exam_overview", arguments: { answerIds } });
  const overview = data<ExamOverview>(result);
  const single = await client.callTool({ name: "render_answer_sheet", arguments: { answerId: second.id } });
  assert.deepEqual({ answer: overview.answer, layout: overview.layout, warningCount: overview.warningCount }, data<AnswerSnapshot>(single));
  assert.equal(overview.warningCount, 2);
  assert.deepEqual(result._meta, single._meta);
  assert.equal(overview.activeAnswerId, second.id);
  const expected = [];
  for (const answer of [second, first]) {
    const current = data<AnswerSnapshot>(await client.callTool({ name: "read_answer", arguments: { answerId: answer.id } }));
    expected.push({ answerId: answer.id, title: answer.title, ...(answer.exam === undefined ? {} : { exam: answer.exam }),
      ...(answer.questionNo === undefined ? {} : { questionNo: answer.questionNo }), version: 1,
      totalLines: current.layout.totalLines, capacity: current.layout.capacity, fits: current.layout.fits, warnings: layoutWarnings(current.layout).length });
  }
  assert.deepEqual(overview.examAnswers, expected);
  assert.equal(overview.examAnswers[0].warnings, 2);
  assert.match(text(result), /第1題 第二份：3\/44 行，符合，警告 2/);
  assert.match(text(result), /第4題 第一份：45\/44 行，超出 1 行，警告 0/);
  assert.match(text(result), /畫板.*分頁切換/);
  const selected = data<ExamOverview>(await client.callTool({ name: "render_exam_overview", arguments: { answerIds, activeAnswerId: first.id } }));
  assert.equal(selected.activeAnswerId, first.id);
  assert.deepEqual({ answer: selected.answer, layout: selected.layout, warningCount: selected.warningCount }, data<AnswerSnapshot>(await client.callTool({ name: "render_answer_sheet", arguments: { answerId: first.id } })));
  assert.equal(selected.warningCount, 0);
  assert.deepEqual(selected.examAnswers, expected);
}));

test("exam overview validates layouts even with missing IDs and rejects invalid selection, sizes and duplicates", async () => withClient(async (client, store) => {
  const good = sample("有效"); await store.saveAnswer(good);
  const getTemplate = store.getTemplate.bind(store); let templates = 0;
  store.getTemplate = async id => { templates++; return getTemplate(id); };
  const invalid = await client.callTool({ name: "render_exam_overview", arguments: { answerIds: ["ans_missingA", good.id, "ans_missingB"] } });
  assert.equal(invalid.isError, true);
  assert.equal(text(invalid), "ANSWER_NOT_FOUND ans_missingA\nANSWER_NOT_FOUND ans_missingB");
  assert.equal(templates, 1);
  for (const args of [{ answerIds: [good.id, good.id] }, { answerIds: [good.id], activeAnswerId: "ans_other" },
    { answerIds: [] }, { answerIds: Array.from({ length: 21 }, (_, index) => `ans_${index}`) }, { answerIds: ["../invalid"] }]) {
    assert.equal((await client.callTool({ name: "render_exam_overview", arguments: args })).isError, true);
  }
  assert.equal(templates, 1);
}));

test("exam overview aggregates layout failures with answer IDs and missing answers", async () => withClient(async (client, store) => {
  const good = sample("有效"), broken = sample("無法排版"), other = sample("另一份無法排版");
  for (const answer of [good, broken, other]) await store.saveAnswer(answer);
  const getAnswer = store.getAnswer.bind(store);
  store.getAnswer = async id => {
    const answer = await getAnswer(id);
    return id === broken.id || id === other.id ? { ...answer, sections: answer.sections.map(section => ({ ...section,
      paragraphFormat: { ...section.paragraphFormat, leftIndent: 100 } })) } : answer;
  };
  const getTemplate = store.getTemplate.bind(store);
  let templates = 0;
  store.getTemplate = async id => { templates++; return getTemplate(id); };
  const result = await client.callTool({ name: "render_exam_overview", arguments: {
    answerIds: ["ans_missingA", broken.id, good.id, other.id, "ans_missingB"], activeAnswerId: good.id,
  } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  const errors = text(result).split("\n");
  assert.equal(errors.length, 4);
  assert.deepEqual(errors.slice(0, 2), ["ANSWER_NOT_FOUND ans_missingA", "ANSWER_NOT_FOUND ans_missingB"]);
  assert.ok(errors[2].startsWith(`LAYOUT_INVALID ${broken.id}：`));
  assert.ok(errors[3].startsWith(`LAYOUT_INVALID ${other.id}：`));
  assert.match(errors[2], /縮排|indent/i);
  assert.equal(templates, 3);
  assert.equal((await store.listAnswers()).length, 3);
}));

test("exam overview masks paths and stacks in aggregated layout failures", async () => withClient(async (client, store) => {
  const answer = sample("private layout failure"); await store.saveAnswer(answer);
  store.getTemplate = async () => { throw new Error(String.raw`missing C:\private\font.ttf and /srv/private/font.ttf and file:///private/renderer.js`
    + "\n    at secretRenderer (C:\\private\\renderer.js:10:2)"); };
  const result = await client.callTool({ name: "render_exam_overview", arguments: { answerIds: [answer.id] } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent, undefined);
  assert.equal(text(result), `LAYOUT_INVALID ${answer.id}：missing <path> and <path> and <path>`);
}));

test("both full render tools expose the same readOnly in structuredContent and metadata under every scope", async () => {
  for (const options of [{}, { readOnly: true }, { scopes: ["essay.read"] }, { scopes: ["essay.read", "essay.export"] },
    { scopes: ["essay.read", "essay.write"] }, { readOnly: true, scopes: ["essay.read", "essay.write"] }]) {
    await withClient(async (client, store) => {
      const answer = sample("render permissions"); await store.saveAnswer(answer);
      for (const name of ["render_answer_sheet", "render_exam_overview"]) {
        const args = name === "render_answer_sheet" ? { answerId: answer.id } : { answerIds: [answer.id] };
        const result = await client.callTool({ name, arguments: { ...args, responseDetail: "full" } });
        const full = data<AnswerSnapshot & { readOnly: boolean }>(result);
        assert.equal(full.readOnly, Boolean(options.readOnly || (options.scopes && !options.scopes.includes("essay.write"))));
        assert.equal(full.readOnly, result._meta?.readOnly);
      }
    }, options);
  }
});

test("render tools return the current layout warning count after a write", async () => withClient(async (client, store) => {
  const template = await store.getTemplate("police_information_essay");
  const answer = createAnswerDocument({ templateId: template.id, title: "品質警告", sections: [{ id: "body", text: "A".repeat(template.columns + 2) }] });
  await store.saveAnswer(answer);
  const renders = () => Promise.all([
    client.callTool({ name: "render_answer_sheet", arguments: { answerId: answer.id } }),
    client.callTool({ name: "render_exam_overview", arguments: { answerIds: [answer.id] } }),
  ]);
  for (const result of await renders()) {
    const summary = data<{ warningCount: number }>(result);
    const current = { ...(result._meta?.snapshot as AnswerSnapshot), warningCount: summary.warningCount };
    assert.equal(current.warningCount, 1);
    assert.equal(current.warningCount, layoutWarnings(current.layout, await store.getTemplate(answer.templateId)).length);
    assert.equal(Object.hasOwn(current, "warnings"), false);
  }
  data(await client.callTool({ name: "replace_text", arguments: { answerId: answer.id, sectionId: "body", newText: "完整中文論述。", expectedVersion: 1, responseDetail: "full" } }));
  for (const result of await renders()) {
    const summary = data<{ warningCount: number }>(result);
    const current = { ...(result._meta?.snapshot as AnswerSnapshot), warningCount: summary.warningCount };
    assert.equal(current.answer.version, 2);
    assert.equal(current.warningCount, 0);
    assert.deepEqual(layoutWarnings(current.layout), []);
  }
}));

test("exam overview is a widget-enabled read tool for read-only and reader scopes", async () => {
  for (const options of [{ readOnly: true }, { scopes: ["essay.read"] }, { scopes: ["essay.read", "essay.write"] }]) {
    await withClient(async (client, store) => {
      const answer = sample("唯讀"); await store.saveAnswer(answer);
      const tools = (await client.listTools()).tools;
      const overview = tools.find(tool => tool.name === "render_exam_overview")!;
      const render = tools.find(tool => tool.name === "render_answer_sheet")!;
      assert.ok(overview); assert.deepEqual(overview._meta, render._meta);
      assert.match(overview.description!, /use once instead of render_answer_sheet per question/);
      assert.equal(overview.annotations?.readOnlyHint, true);
      if (options.scopes) assert.deepEqual(overview._meta?.securitySchemes, [{ type: "oauth2", scopes: ["essay.read"] }]);
      const result = await client.callTool({ name: "render_exam_overview", arguments: { answerIds: [answer.id] } });
      assert.equal(result.isError, undefined, text(result));
      assert.equal(result._meta?.readOnly, !options.scopes?.includes("essay.write"));
    }, options);
  }
});

test("166 overview carries exactly the active answer's paper preview metadata", { skip: !process.env.ESSAY_MCP_PAPER_FONT }, async () => withClient(async (client, store) => {
  const plain = sample("一般");
  const paper = createAnswerDocument({ templateId: "police_information_essay_166", title: "原稿紙", sections: [{ text: "正文" }] });
  await store.saveAnswer(plain); await store.saveAnswer(paper);
  const overview = await client.callTool({ name: "render_exam_overview", arguments: { answerIds: [plain.id, paper.id], activeAnswerId: paper.id } });
  assert.equal(overview.isError, undefined, text(overview));
  const single = await client.callTool({ name: "render_answer_sheet", arguments: { answerId: paper.id } });
  assert.deepEqual(overview._meta, single._meta);
  assert.equal((overview._meta?.paperSvgPages as string[]).length, 2);
}));

test("bundle rechecks every member after all handles exist and rolls back deletion races", async () => withClient(async (client, store) => {
  const first = sample("第一題"), second = sample("刪除競態");
  await store.saveAnswer(first); await store.saveAnswer(second);
  const createHandle = store.createExportHandle.bind(store), getAnswer = store.getAnswer.bind(store);
  const handles: string[] = [], rechecked: string[] = [];
  store.createExportHandle = async (...args) => {
    if (!handles.length) await store.deleteAnswer(second.id, { expectedVersion: 1 });
    const artifact = await createHandle(...args); handles.push(artifact.handle); return artifact;
  };
  store.getAnswer = async id => { if (handles.length === 2) rechecked.push(id); return getAnswer(id); };
  const result = await client.callTool({ name: "export_exam_bundle", arguments: {
    answers: [first, second].map(answer => ({ answerId: answer.id, expectedVersion: 1 })), formats: ["txt", "pdf"],
  } });
  assert.equal(result.isError, true); assert.equal(text(result), `ANSWER_NOT_FOUND ${second.id}：匯出期間已刪除`);
  assert.equal(handles.length, 2); assert.deepEqual(rechecked, [first.id, second.id]);
  assert.deepEqual(await artifactNames(store), []);
  for (const handle of handles) await assert.rejects(store.readExport(handle), isStoreNotFound);
}));

test("batch replay template and layout failures retain item numbers and save no new answers", async () => withClient(async (client, store) => {
  const args = batchRequests()[0];
  const created = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: { ...args, responseDetail: "full" } })).answer;
  const existing = await store.getAnswer(created.id);
  const getAnswer = store.getAnswer.bind(store);
  for (const [code, broken] of [
    ["TEMPLATE_NOT_FOUND", { ...existing, templateId: "missing_replay_template" }],
    ["LAYOUT_INVALID", { ...existing, sections: existing.sections.map(section => ({ ...section, paragraphFormat: { ...section.paragraphFormat, leftIndent: 100 } })) }],
  ] as const) {
    store.getAnswer = async id => id === existing.id ? broken : getAnswer(id);
    const result = await client.callTool({ name: "create_answers", arguments: { answers: [batchRequests()[1], args] } });
    assert.equal(result.isError, true); assert.match(text(result), new RegExp(`^第 2 項 ${code}：`));
    assert.ok(text(result).includes(`此 idempotencyKey 的既有答案 ${existing.id}：`));
    assert.equal((await store.listAnswers()).length, 1);
  }
}));

test("replay propagates transient template errors unchanged for single and batch creates", async () => withClient(async (client, store) => {
  const args = batchRequests()[0];
  const existing = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: args })).answer;
  const getAnswer = store.getAnswer.bind(store), getTemplate = store.getTemplate.bind(store);
  store.getAnswer = async id => id === existing.id ? { ...await getAnswer(id), templateId: "transient_replay_template" } : getAnswer(id);
  let replayReads = 0, saves = 0;
  store.getTemplate = async id => {
    if (id === "transient_replay_template") { replayReads++; throw Object.assign(new Error("暫時性模板儲存錯誤"), { code: "ETIMEDOUT" }); }
    return getTemplate(id);
  };
  store.saveAnswer = async () => { saves++; throw new Error("unexpected save"); };
  for (const request of [
    { name: "create_answer", arguments: args },
    { name: "create_answers", arguments: { answers: [batchRequests()[1], args] } },
  ]) {
    const result = await client.callTool(request);
    assert.equal(result.isError, true);
    assert.equal(text(result), "暫時性模板儲存錯誤");
    assert.doesNotMatch(text(result), /TEMPLATE_NOT_FOUND/);
    assert.equal(result.structuredContent, undefined);
  }
  assert.equal(replayReads, 2); assert.equal(saves, 0);
  assert.equal((await store.listAnswers()).length, 1);
}));

test("idempotency reuse gives recovery actions and root validation names the input", async () => withClient(async (client, store) => {
  const args = batchRequests()[0];
  const existing = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: args })).answer;
  const reused = await client.callTool({ name: "create_answer", arguments: { ...args, title: "另一份" } });
  assert.equal(reused.isError, true);
  assert.ok(text(reused).includes(`要建立另一份答案請換新的 idempotencyKey；要取回原答案請用 read_answer ${existing.id}。`));
  for (const request of [null, { title: "未知欄位", extra: true }]) {
    const invalid = await client.callTool({ name: "create_answers", arguments: { answers: [request] } });
    assert.equal(invalid.isError, true); assert.match(text(invalid), /^第 1 項 INVALID_INPUT：輸入：/);
    assert.doesNotMatch(text(invalid), /：：/);
  }
  assert.equal((await store.listAnswers()).length, 1);
  const tools = (await client.listTools()).tools;
  assert.match(tools.find(tool => tool.name === "delete_answer")!.description!, /export files and exam bundles containing it/);
  for (const [name, expected] of [["create_answer", "Whole-word Latin wrapping and keeping headings with their first body line; new answers default to on."],
    ["update_answer_info", "Partial update; false turns an option off."]] as const) {
    assert.equal((tools.find(tool => tool.name === name)!.inputSchema.properties!.layoutOptions as { description: string }).description, expected);
  }
}));


type ExportErrorEntry = { code: string; answerId?: string; questionNo?: number; format?: string; retryable: boolean; message: string };
function exportErrors(result: Awaited<ReturnType<Client["callTool"]>>) {
  return (result.structuredContent as { errors: ExportErrorEntry[] }).errors;
}
test("export tools carry every validation code and known question number without creating handles", async () => withClient(async (client, store) => {
  const good = { ...sample("valid"), questionNo: 3 };
  const overflow = { ...sample("overflow", 45), questionNo: 4 };
  const invalid = { ...sample("invalid"), questionNo: 5, templateId: "missing_template" };
  for (const answer of [good, overflow]) await store.saveAnswer(answer);
  const getAnswer = store.getAnswer.bind(store);
  store.getAnswer = async id => id === invalid.id ? invalid : getAnswer(id);
  for (const name of ["export_answer", "export_exam_bundle"]) {
    for (const [answerId, expectedVersion, code, questionNo] of [
      ["ans_missing", 1, "ANSWER_NOT_FOUND", undefined], [good.id, 2, "VERSION_CONFLICT", 3],
      [overflow.id, 1, "LAYOUT_OVERFLOW", 4], [invalid.id, 1, "LAYOUT_INVALID", 5],
    ] as const) {
      const result = await client.callTool({ name, arguments: { ...(name === "export_answer" ? { answerId, expectedVersion }
        : { answers: [{ answerId, expectedVersion }] }), formats: ["txt"] } });
      assert.equal(result.isError, true, text(result));
      const errors = exportErrors(result);
      assert.equal(errors.length, 1); assert.equal(errors[0].code, code); assert.equal(errors[0].answerId, answerId);
      assert.equal(errors[0].questionNo, questionNo); assert.equal(errors[0].retryable, false); assert.ok(errors[0].message);
    }
  }
  assert.deepEqual(await artifactNames(store), []);
}));

test("export storage failures are retryable; partial single exports retain files and format errors", async () => withClient(async (client, store) => {
  const answer = { ...sample("storage failure"), questionNo: 8 }; await store.saveAnswer(answer);
  const create = store.createExportHandle.bind(store);
  store.createExportHandle = async (file, metadata) => {
    if (metadata.format === "pdf" || metadata.format === "txt") throw Object.assign(new Error("transient storage failure"), { code: "ETIMEDOUT" });
    return create(file, metadata);
  };
  for (const name of ["export_answer", "export_exam_bundle"]) {
    const result = await client.callTool({ name, arguments: { ...(name === "export_answer" ? { answerId: answer.id, expectedVersion: 1 }
      : { answers: [{ answerId: answer.id, expectedVersion: 1 }] }), formats: ["txt"] } });
    assert.equal(result.isError, true); assert.match(text(result), /transient storage failure/);
    const [error] = exportErrors(result);
    assert.equal(error.code, "EXPORT_FAILED"); assert.equal(error.retryable, true); assert.equal(error.format, "txt");
    if (name === "export_answer") { assert.equal(error.answerId, answer.id); assert.equal(error.questionNo, 8); }
    assert.deepEqual(await artifactNames(store), []);
  }
  const partial = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["docx", "txt"] } });
  const value = data<{ files: Bundle["files"]; failed: Array<{ format: string; error: string }> }>(partial);
  assert.deepEqual(value.files.map(file => file.format), ["docx"]);
  assert.deepEqual(value.failed, [{ format: "txt", error: "transient storage failure" }]);
  assert.deepEqual(exportErrors(partial), [{ code: "EXPORT_FAILED", answerId: answer.id, questionNo: 8, format: "txt", retryable: true, message: "transient storage failure" }]);
  assert.match(text(partial), /txt 沒有輸出：transient storage failure/);
  assert.ok((await readArtifact(store, value.files[0].exportUri)).data.length);
  store.getTemplate = async () => { throw Object.assign(new Error("transient template storage failure"), { code: "ECONNRESET" }); };
  for (const name of ["export_answer", "export_exam_bundle"]) {
    const result = await client.callTool({ name, arguments: name === "export_answer" ? { answerId: answer.id, formats: ["txt"] }
      : { answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["txt"] } });
    assert.equal(result.isError, true); assert.equal(exportErrors(result)[0].code, "EXPORT_FAILED");
    assert.equal(exportErrors(result)[0].retryable, true); assert.equal(exportErrors(result)[0].questionNo, 8);
  }
}));

test("each legacy export rejects stale versions before layout or output; omitted versions still export", async () => withClient(async (client, store) => {
  const answer = sample("legacy version"); await store.saveAnswer(answer);
  const getTemplate = store.getTemplate.bind(store); let reads = 0;
  store.getTemplate = async id => { reads++; return getTemplate(id); };
  for (const name of ["export_docx", "export_pdf", "export_text"]) {
    const result = await client.callTool({ name, arguments: { answerId: answer.id, expectedVersion: 2 } });
    assert.equal(result.isError, true); assert.match(text(result), /^VERSION_CONFLICT/);
    assert.match(text(result), /目前版本 1，預期 2.*read_answer\/check_layout/);
  }
  assert.equal(reads, 0); assert.deepEqual(await artifactNames(store), []);
  for (const expectedVersion of [undefined, 1]) assert.equal((await client.callTool({ name: "export_text",
    arguments: { answerId: answer.id, ...(expectedVersion ? { expectedVersion } : {}) } })).isError, undefined);
}));

test("render tool model summaries contain no lines or sections; component metadata has the authoritative snapshot", async () => withClient(async (client, store) => {
  const answer = sample("compact render", 40); await store.saveAnswer(answer);
  const stored = data<AnswerSnapshot>(await client.callTool({ name: "read_answer", arguments: { answerId: answer.id } }));
  for (const name of ["render_answer_sheet", "render_exam_overview"]) {
    const result = await client.callTool({ name, arguments: name === "render_answer_sheet" ? { answerId: answer.id } : { answerIds: [answer.id] } });
    const summary = data<AnswerSnapshot & { warningCount: number }>(result);
    assert.equal(JSON.stringify(summary).includes('"lines"'), false);
    assert.equal(Object.hasOwn(summary.answer, "sections"), false);
    assert.deepEqual(result._meta?.snapshot, stored);
    assert.equal(summary.answer.id, answer.id); assert.equal(summary.answer.version, 1);
    for (const key of ["totalLines", "capacity", "fits", "overflowLines"] as const) assert.equal(summary.layout[key], stored.layout[key]);
    assert.equal(summary.warningCount, 0);
    assert.ok(Buffer.byteLength(JSON.stringify(summary)) * 5 < Buffer.byteLength(JSON.stringify(stored)));
  }
}));

test("storage-only createRequestHash is absent from all full tool snapshots, including previews and widget metadata", async () => withClient(async (client, store) => {
  const created = await client.callTool({ name: "create_answer", arguments: { title: "privacy", idempotencyKey: "privacy_key_01", sections: [{ id: "body", text: "body" }], responseDetail: "full" } });
  const id = data<AnswerSnapshot>(created).answer.id;
  assert.ok((await store.getAnswer(id)).createRequestHash);
  const requests = [
    ["read_answer", { answerId: id }], ["reflow_answer", { answerId: id }], ["render_answer_sheet", { answerId: id }],
    ["render_exam_overview", { answerIds: [id] }], ["preview_change", { answerId: id, operation: "replace_text", sectionId: "body", newText: "new" }],
    ["replace_text", { answerId: id, sectionId: "body", newText: "new", expectedVersion: 1, responseDetail: "full" }],
  ] as const;
  assert.equal(JSON.stringify(created).includes("createRequestHash"), false);
  for (const [name, args] of requests) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, text(result)); assert.equal(JSON.stringify(result).includes("createRequestHash"), false, name);
  }
  assert.ok((await store.getAnswer(id)).createRequestHash);
}));

test("batch tools match single tool visibility, direct-call denial and widget readOnly under every scope", async () => {
  for (const options of [{ readOnly: true }, { scopes: ["essay.read"] }, { scopes: ["essay.read", "essay.write"] },
    { scopes: ["essay.read", "essay.export"] }, { scopes: ["essay.read", "essay.write", "essay.export"] }, {}]) {
    await withClient(async (client, store) => {
      const answer = sample("scope"); await store.saveAnswer(answer);
      const tools = (await client.listTools()).tools;
      for (const [batch, single, args] of [
        ["create_answers", "create_answer", { answers: [{ title: "denied" }] }],
        ["export_exam_bundle", "export_answer", { answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["txt"] }],
        ["render_exam_overview", "render_answer_sheet", { answerIds: [answer.id] }],
      ] as const) {
        const tool = tools.find(tool => tool.name === batch), peer = tools.find(tool => tool.name === single);
        assert.equal(Boolean(tool), Boolean(peer));
        if (!tool) assert.equal((await client.callTool({ name: batch, arguments: args })).isError, true);
        else if (batch === "render_exam_overview") {
          const result = await client.callTool({ name: batch, arguments: args });
          assert.equal(result.isError, undefined); assert.equal(result._meta?.readOnly, Boolean(options.readOnly || (options.scopes && !options.scopes.includes("essay.write"))));
        }
        if (options.scopes && tool) assert.deepEqual(tool._meta?.securitySchemes, peer?._meta?.securitySchemes);
      }
    }, options);
  }
});

test("two-answer PDF bundle embeds one font cost", async t => withClient(async (_client, store) => {
  const template = await store.getTemplate("police_information_essay");
  const report = layoutSections(template, sample("font", 1).sections);
  const onePath = path.join(store.exportDir, "one.pdf"), twoPath = path.join(store.exportDir, "two.pdf");
  const single = await exportPdf(report, template, onePath);
  if (single.font === "Helvetica") { t.skip("No usable PDF CJK font configured or available"); return; }
  await exportPdfBundle([{ report, template }, { report, template }], twoPath);
  const one = await fs.readFile(onePath), two = await fs.readFile(twoPath);
  assert.equal(pdfPageCount(two), pdfPageCount(one) * 2);
  assert.ok(two.length < one.length * 1.6, `bundle=${two.length} single=${one.length} ratio=${two.length / one.length}`);
  t.diagnostic(`PDF_FONT_REUSE single=${one.length} bundle=${two.length} ratio=${two.length / one.length}`);
}));


test("invalid stored JSON is a non-retryable layout error while read I/O failures are retryable", async () => withClient(async (client, store) => {
  const answer = { ...sample("stored data"), questionNo: 6 }; await store.saveAnswer(answer);
  const getAnswer = store.getAnswer.bind(store), getTemplate = store.getTemplate.bind(store);
  for (const source of ["answer", "template"]) {
    for (const error of [new SyntaxError("invalid stored JSON"), Object.assign(new Error("storage timeout"), { code: "ETIMEDOUT" })]) {
      store.getAnswer = source === "answer" ? async () => { throw error; } : getAnswer;
      store.getTemplate = source === "template" ? async () => { throw error; } : getTemplate;
      for (const name of ["export_answer", "export_exam_bundle"]) {
        const result = await client.callTool({ name, arguments: name === "export_answer" ? { answerId: answer.id, formats: ["txt"] }
          : { answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["txt"] } });
        assert.equal(result.isError, true);
        const [failure] = exportErrors(result);
        assert.equal(failure.code, error instanceof SyntaxError ? "LAYOUT_INVALID" : "EXPORT_FAILED");
        assert.equal(failure.retryable, !(error instanceof SyntaxError));
        assert.equal(failure.answerId, answer.id);
        if (source === "template") assert.equal(failure.questionNo, 6);
      }
    }
  }
}));


for (const paperMode of [false, true]) test(`render tools opt into full structured snapshots (${paperMode ? "166 SVG" : "plain"}) while defaults stay compact`,
  { skip: paperMode && !process.env.ESSAY_MCP_PAPER_FONT ? "ESSAY_MCP_PAPER_FONT not set" : false }, async () => withClient(async (client, store) => {
  const plain = sample("plain full"); await store.saveAnswer(plain);
  const paper = createAnswerDocument({ templateId: "police_information_essay_166", title: "paper full", sections: [{ id: "body", text: "原稿紙論述。" }] });
  if (paperMode) await store.saveAnswer(paper);
  const answer = paperMode ? paper : plain;
  for (const name of ["render_answer_sheet", "render_exam_overview"]) {
    const args = name === "render_answer_sheet" ? { answerId: answer.id } : { answerIds: paperMode ? [plain.id, paper.id] : [plain.id], activeAnswerId: answer.id };
    const summary = await client.callTool({ name, arguments: args });
    const compact = data<AnswerSnapshot>(summary);
    assert.equal(Object.hasOwn(compact.layout, "lines"), false);
    assert.equal(Object.hasOwn(compact.answer, "sections"), false);
    assert.equal(Object.hasOwn(compact, "paperSvgPages"), false);
    const result = await client.callTool({ name, arguments: { ...args, responseDetail: "full" } });
    const full = data<AnswerSnapshot & { paperSvgPages?: string[] }>(result);
    assert.ok(full.layout.lines.length > 0);
    assert.deepEqual(full.answer, (result._meta?.snapshot as AnswerSnapshot).answer);
    assert.deepEqual(full.layout, (result._meta?.snapshot as AnswerSnapshot).layout);
    assert.deepEqual(summary._meta, result._meta);
    if (answer === paper) {
      assert.equal(full.paperSvgPages?.length, 2);
      assert.deepEqual(full.paperSvgPages, result._meta?.paperSvgPages);
      assert.match(full.paperSvgPages![0], /<svg/);
    } else assert.equal(Object.hasOwn(full, "paperSvgPages"), false);
  }
}));

test("export errors redact Windows, POSIX and file paths in structured and text results, including partial failures", async () => withClient(async (client, store) => {
  const answer = sample("redacted errors"); await store.saveAnswer(answer);
  const create = store.createExportHandle.bind(store);
  const message = String.raw`missing C:\private\font.ttf and /srv/private/font.ttf and file:///private/renderer.js` + "\n    at secretRenderer (C:\\private\\renderer.js:10:2)";
  store.createExportHandle = async (file, details) => {
    if (details.format === "txt") throw new Error(message);
    return create(file, details);
  };
  for (const name of ["export_answer", "export_exam_bundle"]) {
    const result = await client.callTool({ name, arguments: { ...(name === "export_answer" ? { answerId: answer.id } : { answers: [{ answerId: answer.id, expectedVersion: 1 }] }), formats: ["txt"] } });
    assert.equal(result.isError, true);
    const [error] = exportErrors(result);
    assert.equal(error.code, "EXPORT_FAILED"); assert.equal(error.retryable, false);
    for (const value of [error.message, text(result)]) {
      assert.match(value, /missing <path> and <path> and <path>/);
      assert.doesNotMatch(value, /private|secretRenderer|font\.ttf/);
    }
  }
  const partial = await client.callTool({ name: "export_answer", arguments: { answerId: answer.id, formats: ["docx", "txt"] } });
  const value = data<{ files: unknown[]; failed: Array<{ error: string }> }>(partial);
  assert.equal(value.files.length, 1);
  assert.equal(value.failed[0].error, "missing <path> and <path> and <path>");
  assert.equal(exportErrors(partial)[0].retryable, false);
  assert.doesNotMatch(text(partial), /private|secretRenderer/);
}));

test("bundle reports each duplicated answerId once before reading or exporting", async () => withClient(async (client, store) => {
  store.getAnswer = async () => { throw new Error("must reject before reading"); };
  const ids = ["ans_duplicateA", "ans_duplicateB", "ans_duplicateA", "ans_duplicateB", "ans_duplicateA"];
  const result = await client.callTool({ name: "export_exam_bundle", arguments: { answers: ids.map(answerId => ({ answerId, expectedVersion: 1 })) } });
  assert.equal(result.isError, true);
  const errors = exportErrors(result);
  assert.deepEqual(errors.map(error => error.answerId), ["ans_duplicateA", "ans_duplicateB"]);
  for (const error of errors) {
    assert.equal(error.code, "LAYOUT_INVALID"); assert.equal(error.retryable, false);
    assert.ok(error.message.includes(error.answerId!)); assert.ok(text(result).includes(error.answerId!));
  }
  assert.deepEqual(await artifactNames(store), []);
}));
