import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import { CloudStore } from "../src/cloud-storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";
import { createAnswerDocument, templateSchema, type AnswerTemplate } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import * as fontkit from "fontkit";

const general = "police_information_essay", paper = "police_information_essay_165", legacy = "police_information_essay_166";
const handwriting = "police_information_essay_165_handwriting_xiaolai";
const skipFonts = !process.env.ESSAY_MCP_PAPER_FONT || !existsSync(process.env.ESSAY_MCP_PAPER_FONT)
  || !process.env.ESSAY_MCP_HANDWRITING_FONT_DIR || !existsSync(path.join(process.env.ESSAY_MCP_HANDWRITING_FONT_DIR, "Xiaolai-Regular.ttf"));
const restore = (name: string, value: string | undefined) => { if (value === undefined) delete process.env[name]; else process.env[name] = value; };
async function withoutFonts(run: () => Promise<void>) {
  const names = ["ESSAY_MCP_PAPER_FONT", "ESSAY_MCP_HANDWRITING_FONT", "ESSAY_MCP_HANDWRITING_FONT_DIR"];
  const previous = names.map(name => process.env[name]);
  try { for (const name of names) delete process.env[name]; await run(); }
  finally { names.forEach((name, index) => restore(name, previous[index])); }
}

async function withClient(run: (client: Client, store: FileStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-switch-template-"));
  const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store), client = new Client({ name: "switch-template-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try { await server.connect(a); await client.connect(b); await run(client, store); }
  finally { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent as any;
}
async function rejected(client: Client, store: FileStore, answerId: string, templateId: string, message: RegExp) {
  const before = await store.getAnswer(answerId), revisions = await store.listRevisions(answerId, { limit: 30 });
  const result = await client.callTool({ name: "update_answer_info", arguments: { answerId, templateId, expectedVersion: before.version, title: "不可儲存的修改" } });
  assert.equal(result.isError, true, JSON.stringify(result));
  assert.match(JSON.stringify(result.content), message);
  assert.deepEqual(await store.getAnswer(answerId), before);
  assert.deepEqual(await store.listRevisions(answerId, { limit: 30 }), revisions);
}

test("tools/list declares the optional template input and stays within the JSON byte budget", async () => withClient(async client => {
  const tools = (await client.listTools()).tools, bytes = Buffer.byteLength(JSON.stringify(tools));
  console.log(`tools/list bytes: ${bytes}`);
  assert.ok(bytes <= 80_000, `${bytes} > 80000`);
  const tool = tools.find(tool => tool.name === "update_answer_info")!;
  assert.deepEqual(tool.inputSchema.properties!.templateId, { type: "string" });
  assert.ok(!tool.inputSchema.required?.includes("templateId"));
  assert.equal(tool.description, "Edit title, exam, question number, question or layout options at expectedVersion. templateId switches to a same-layout template (e.g. 165 standard or handwriting font).");
}));

test("unknown templates and different layouts fail before opening any font and preserve the answer", async () => withoutFonts(() => withClient(async (client, store) => {
  for (const templateId of [general, paper]) {
    // Model a saved answer whose font is no longer installed; ordinary storage validates fonts on save.
    const answer = createAnswerDocument({ templateId, title: "原稿", sections: [{ text: "資料安全" }] });
    await fs.mkdir(store.answerDir, { recursive: true });
    await fs.writeFile(path.join(store.answerDir, `${answer.id}.json`), JSON.stringify(answer));
    await rejected(client, store, answer.id, "missing_template", /找不到模板 missing_template。/);
    const target = templateId === general ? paper : general;
    const name = (await store.getTemplate(target)).name;
    const result = await client.callTool({ name: "update_answer_info", arguments: { answerId: answer.id, templateId: target, expectedVersion: 1 } });
    assert.equal(result.isError, true);
    assert.equal((result.content as { text: string }[])[0].text,
      `只能切換到版面相同的範本（例如 165 原稿紙的標準楷書與手寫體之間）；「${name}」的版面與目前範本不同。`);
    assert.deepEqual(await store.getAnswer(answer.id), JSON.parse(JSON.stringify(answer))); // the file holds no undefined keys
    assert.deepEqual(await store.listRevisions(answer.id, { limit: 30 }), []);
  }
})));

test("same template is a no-op and may be combined with other edits", async () => withoutFonts(() => withClient(async (client, store) => {
  for (const templateId of [general, paper, legacy]) {
    const created = await call(client, "create_answer", { templateId, title: "原稿", sections: [] });
    const before = await store.getAnswer(created.answer.id), revisions = await store.listRevisions(before.id, { limit: 30 });
    const unchanged = await call(client, "update_answer_info", { answerId: before.id, templateId, expectedVersion: 1 });
    assert.equal(unchanged.answer.version, 1); assert.deepEqual(unchanged.changes, []);
    assert.deepEqual(await store.getAnswer(before.id), before);
    assert.deepEqual(await store.listRevisions(before.id, { limit: 30 }), revisions);
    const updated = await call(client, "update_answer_info", { answerId: before.id, templateId, expectedVersion: 1, title: "新標題" });
    assert.equal(updated.answer.version, 2); assert.equal(updated.answer.title, "新標題");
    assert.equal(updated.answer.templateId, templateId);
  }
})));

test("hidden is optional; file and cloud inventories omit only the legacy alias and still load it", async () => withoutFonts(() => withClient(async (_client, store) => {
  const cloud = new CloudStore({ firestore: new MemoryFirestore().client(), storage: new MemoryStorage().client(), environment: "staging",
    ownerKey: "a".repeat(64), artifactBucket: "synthetic-artifacts", templateDir: path.resolve("templates") });
  const template = await store.getTemplate(paper);
  assert.equal(templateSchema.parse({ ...template, hidden: true }).hidden, true);
  assert.equal(templateSchema.parse({ ...template, hidden: false }).hidden, false);
  assert.equal(templateSchema.parse(template).hidden, undefined);
  for (const backend of [store, cloud]) {
    assert.deepEqual((await backend.listTemplates()).map(t => t.id), [general, paper]);
    assert.equal((await backend.getTemplate(legacy)).hidden, true);
  }
})));

test("legacy switches both ways, preserves the exam link, combines edits, and checks expectedVersion", async () => withoutFonts(() => withClient(async (client, store) => {
  const exam = await call(client, "start_exam", { title: "測試考試", questions: [{ questionNo: 1, question: "測試題目" }] });
  const created = await call(client, "create_answer", { templateId: legacy, title: "原稿", sections: [], examId: exam.examId, questionNo: 1 });
  const before = await store.getAnswer(created.answer.id), plan = await store.getExam(exam.examId);
  assert.equal(plan.questions[0].answerId, before.id);
  const result = await call(client, "update_answer_info", { answerId: before.id, templateId: paper, title: "新標題", expectedVersion: 1 });
  assert.equal(result.answer.version, 2); assert.equal(result.answer.templateId, paper);
  assert.equal(result.answer.id, before.id); assert.equal(result.answer.title, "新標題");
  // Both ids carry the same display name, so the change is reported by id.
  assert.ok(result.changes.includes(`範本：「${legacy}」→「${paper}」`), JSON.stringify(result.changes));
  assert.deepEqual(await store.getExam(exam.examId), plan);
  const stale = await client.callTool({ name: "update_answer_info", arguments: { answerId: before.id, templateId: legacy, expectedVersion: 1 } });
  assert.equal(stale.isError, true); assert.match(JSON.stringify(stale.content), /Version conflict/);
  assert.equal((await store.getAnswer(before.id)).version, 2);
  const returned = await call(client, "update_answer_info", { answerId: before.id, templateId: legacy, expectedVersion: 2 });
  assert.equal(returned.answer.templateId, legacy); assert.equal(returned.answer.version, 3);
  assert.deepEqual((await store.listRevisions(before.id, { limit: 30 })).map(r => r.version).sort(), [1, 2, 3]);
})));

test("missing or unloadable target font cannot save any combined edit", async () => withoutFonts(() => withClient(async (client, store) => {
  const answer = createAnswerDocument({ templateId: paper, title: "原稿", sections: [{ text: "資料安全" }] });
  await fs.mkdir(store.answerDir, { recursive: true });
  await fs.writeFile(path.join(store.answerDir, `${answer.id}.json`), JSON.stringify(answer));
  await rejected(client, store, answer.id, handwriting, /ESSAY_MCP_HANDWRITING_FONT_DIR/);
  const previous = process.env.ESSAY_MCP_HANDWRITING_FONT_DIR;
  try {
    process.env.ESSAY_MCP_HANDWRITING_FONT_DIR = store.exportDir;
    await fs.mkdir(store.exportDir, { recursive: true });
    await fs.writeFile(path.join(store.exportDir, "Xiaolai-Regular.ttf"), "not a font");
    await rejected(client, store, answer.id, handwriting, /稿紙（手寫體）字型無法載入/);
  } finally { restore("ESSAY_MCP_HANDWRITING_FONT_DIR", previous); }
})));

test("same-layout switch rejects overflow before saving (font-independent branch coverage)", async () => withClient(async (client, store) => {
  const base = await store.getTemplate(general);
  const source = { ...base, id: "small_source", name: "小版面來源", pages: 1, linesPerPage: 1, overflowPolicy: "reject" as const };
  const target = { ...source, id: "small_target", name: "小版面目標", fontFamily: "Another font" };
  // Synthetic same-layout templates use the real general layout engine; storage permits an editable overflow draft.
  const getTemplate = store.getTemplate.bind(store);
  store.getTemplate = async id => id === source.id ? source : id === target.id ? target : getTemplate(id);
  const answer = createAnswerDocument({ templateId: source.id, title: "原稿", sections: [{ text: "第一行\n第二行" }] });
  assert.equal(layoutSections(source, answer.sections).overflowLines, 1);
  await store.saveAnswer(answer);
  await rejected(client, store, answer.id, target.id, /改用「小版面目標」後超出 1 行，未變更範本。/);
}));

test("165 switches to Xiaolai once, exports its embedded font, and records history; restore keeps the current template", { skip: skipFonts }, async () => withClient(async (client, store) => {
  const created = await call(client, "create_answer", { templateId: paper, title: "原稿", sections: [{ id: "body", text: "資料安全 ABC 165。" }] });
  const before = await store.getAnswer(created.answer.id);
  const changed = await call(client, "update_answer_info", { answerId: before.id, templateId: handwriting, expectedVersion: before.version, responseDetail: "full" });
  assert.equal(changed.answer.id, before.id); assert.equal(changed.answer.version, before.version + 1);
  assert.equal(changed.answer.templateId, handwriting);
  assert.deepEqual(changed.answer.sections, before.sections);
  const target = await store.getTemplate(handwriting), source = await store.getTemplate(paper);
  assert.ok(changed.changes.includes(`範本：「${source.name}」→「${target.name}」`));
  assert.deepEqual(changed.layout, layoutSections(target, changed.answer.sections, changed.answer.layoutOptions));
  assert.equal((await call(client, "read_answer", { answerId: before.id })).answer.templateId, handwriting);
  assert.equal((await store.getRevision(before.id, 1)).templateId, paper);
  assert.equal((await store.getRevision(before.id, 2)).templateId, handwriting);
  const revisions = await call(client, "list_revisions", { answerId: before.id });
  assert.ok(revisions.revisions.find((r: any) => r.version === 2).changes.some((line: string) => line === `範本：「${source.name}」→「${target.name}」`));
  const exported = await call(client, "export_answer", { answerId: before.id, expectedVersion: 2, formats: ["pdf"] });
  assert.deepEqual(exported.failed, []);
  const pdf = (await store.readExport(exported.files[0].exportUri.split("/").pop())).data.toString("latin1");
  const names = [...pdf.matchAll(/\/BaseFont\s*\/([^\s/]+)/g)].map(match => match[1]);
  const targetFace = fontkit.openSync(path.join(process.env.ESSAY_MCP_HANDWRITING_FONT_DIR!, "Xiaolai-Regular.ttf"));
  const sourceFace = fontkit.openSync(process.env.ESSAY_MCP_PAPER_FONT!);
  assert.ok(names.some(name => name.includes(targetFace.postscriptName)), names.join(", "));
  assert.ok(names.every(name => !name.includes(sourceFace.postscriptName)), names.join(", "));
  assert.match(pdf, /\/FontFile[23]\b/);
  const restored = await call(client, "restore_revision", { answerId: before.id, version: 1, expectedVersion: 2, responseDetail: "full" });
  assert.equal(restored.answer.templateId, handwriting, "existing restore restores content/targets only, not template metadata");
  assert.equal(restored.answer.version, 3); assert.deepEqual(restored.answer.sections, before.sections);
}));

test("a legacy answer with text switches to 165", { skip: skipFonts }, async () => withClient(async (client, store) => {
  const created = await call(client, "create_answer", { templateId: legacy, title: "原稿", sections: [{ text: "資料安全" }] });
  const changed = await call(client, "update_answer_info", { answerId: created.answer.id, templateId: paper, expectedVersion: 1 });
  assert.equal(changed.answer.version, 2); assert.equal((await store.getAnswer(created.answer.id)).templateId, paper);
}));

test("a glyph present in MOE but missing in Xiaolai rejects the switch atomically", { skip: skipFonts }, async t => withClient(async (client, store) => {
  const source = fontkit.openSync(process.env.ESSAY_MCP_PAPER_FONT!);
  const target = fontkit.openSync(path.join(process.env.ESSAY_MCP_HANDWRITING_FONT_DIR!, "Xiaolai-Regular.ttf"));
  const code = (source.characterSet as number[]).find(code => code >= 0x21 && !(code >= 0xd800 && code <= 0xdfff)
    && /^[\p{L}\p{N}\p{P}\p{S}]$/u.test(String.fromCodePoint(code)) && source.hasGlyphForCodePoint(code) && !target.hasGlyphForCodePoint(code));
  if (code === undefined) { t.skip("MOE 字型沒有找到 Xiaolai 缺少的可見字元"); return; }
  const character = String.fromCodePoint(code);
  const answer = createAnswerDocument({ templateId: paper, title: "缺字測試", sections: [{ text: character }] });
  await store.saveAnswer(answer);
  await rejected(client, store, answer.id, handwriting, /稿紙字型缺字：/);
}));

test("measured font widths can make a previously fitting answer overflow", { skip: skipFonts }, async t => withClient(async (client, store) => {
  const templates = [await store.getTemplate(paper), await store.getTemplate(handwriting)];
  const fits = (template: AnswerTemplate, text: string) => layoutSections(template,
    createAnswerDocument({ templateId: template.id, title: "寬度測試", sections: [{ text }] }).sections).fits;
  for (const character of "WiM018") {
    const capacities = templates.map(template => {
      let low = 0, high = 10_000;
      assert.equal(fits(template, character.repeat(high)), false);
      while (low + 1 < high) { const mid = Math.floor((low + high) / 2); if (fits(template, character.repeat(mid))) low = mid; else high = mid; }
      return low;
    });
    if (capacities[0] === capacities[1]) continue;
    const source = templates[capacities[0] > capacities[1] ? 0 : 1], target = templates[capacities[0] > capacities[1] ? 1 : 0];
    const text = character.repeat(Math.min(...capacities) + 1);
    assert.equal(fits(source, text), true); assert.equal(fits(target, text), false);
    const answer = createAnswerDocument({ templateId: source.id, title: "寬度測試", sections: [{ text }] });
    await store.saveAnswer(answer);
    await rejected(client, store, answer.id, target.id, /改用「.+」後超出 \d+ 行，未變更範本。/);
    return;
  }
  t.skip("未找到穩定的英數寬度差；另有無字型的真實排版溢出分支測試");
}));
