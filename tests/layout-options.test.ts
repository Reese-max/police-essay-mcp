import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { answerDocumentSchema, createAnswerDocument, layoutLineSchema, normalizeSection, paragraphFormatSchema, templateSchema, type AnswerSnapshot } from "../src/domain.js";
import { layoutSections, renderTextLine } from "../src/layout.js";
import { layoutWarnings, planLines } from "../src/planning.js";
import { exportDocx, exportParagraphTextBundle, exportText } from "../src/exporters.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import JSZip from "jszip";
import { JSDOM, VirtualConsole } from "jsdom";
import { POLICE_ESSAY_WIDGET_HTML } from "../src/widget.js";
import { originalPaperAvailableWidth, originalPaperMeasure } from "../src/original-paper.js";

const template = templateSchema.parse(JSON.parse(await fs.readFile(new URL("../templates/police_information_essay.json", import.meta.url), "utf8")));
const enabled = { wholeLatinWords: true, keepHeadingWithNext: true, avoidPunctuationOnlyLines: true };
const legacy = { wholeLatinWords: false, keepHeadingWithNext: false, avoidPunctuationOnlyLines: false };

test("whole Latin words preserve all characters, long words and breaks at spaces", () => {
  const narrow = { ...template, columns: 20 };
  const text = "Zero Trust Redundancy 提升";
  const section = normalizeSection({ text }, 0);
  const off = layoutSections(narrow, [section]);
  const on = layoutSections(narrow, [section], enabled);
  assert.deepEqual(off.lines.map(line => line.text), ["Zero Trust Redundanc", "y 提升"]);
  assert.deepEqual(on.lines.map(line => line.text), ["Zero Trust ", "Redundancy 提升"]);
  assert.deepEqual(layoutSections(narrow, [section], legacy), off);
  assert.equal(layoutWarnings(on).length, 0);
  for (const text of ["X " + "A".repeat(45), "A".repeat(19) + " World", "A".repeat(20) + " World", "前😀e\u0301 Zero Trust Redundancy 1234567890123終"]) {
    const sections = [normalizeSection({ text }, 0)];
    for (const options of [legacy, enabled]) {
      const report = layoutSections(narrow, sections, options);
      assert.equal(report.lines.map(line => line.text).join(""), text);
      assert.ok(report.lines.every(line => line.displayWidth <= narrow.columns));
    }
    if (text.endsWith(" World")) assert.deepEqual(layoutSections(narrow, sections, enabled), layoutSections(narrow, sections));
    else if (text.startsWith("X ")) {
      const report = layoutSections(narrow, sections, enabled);
      assert.deepEqual(report, layoutSections(narrow, sections));
      assert.match(layoutWarnings(report)[0].message, /長於一行/);
    }
  }
  const indented = normalizeSection({ text: "X RedundancyY", paragraphFormat: { firstLineIndent: 8 } }, 0);
  const report = layoutSections(narrow, [indented], enabled);
  assert.deepEqual(report.lines.map(line => line.text), ["X ", "RedundancyY"]);
  // An all-Latin first line must still break, rather than becoming an empty line.
  const long = normalizeSection({ text: "A".repeat(45) }, 0);
  assert.deepEqual(layoutSections(narrow, [long], enabled), layoutSections(narrow, [long]));
  const digits = normalizeSection({ text: "中1234567890" }, 0);
  assert.deepEqual(layoutSections({ ...narrow, columns: 10 }, [digits], enabled).lines.map(line => line.text), ["中", "1234567890"]);
});

test("whole words move only when the full run fits and a non-whitespace prefix remains", () => {
  const narrow = { ...template, columns: 20 };
  for (const text of ["ab " + "W".repeat(25), "  " + "A".repeat(20), "\t" + "A".repeat(20)]) {
    const section = normalizeSection({ text }, 0);
    assert.deepEqual(layoutSections(narrow, [section], enabled), layoutSections(narrow, [section]));
  }
  assert.deepEqual(layoutSections(narrow, [normalizeSection({ text: "ab " + "W".repeat(25) }, 0)], enabled)
    .lines.map(line => line.text), ["ab " + "W".repeat(17), "W".repeat(8)]);
  assert.deepEqual(layoutSections(narrow, [normalizeSection({ text: "ab " + "W".repeat(20) }, 0)], enabled)
    .lines.map(line => line.text), ["ab ", "W".repeat(20)]);
});

test("split-word warnings distinguish disabled wrapping from runs longer than the available line", () => {
  const report = (text: string, columns = 38, leftIndent = 0, rightIndent = 0, firstLineIndent = 0) =>
    layoutSections({ ...template, columns }, [normalizeSection({ text,
      paragraphFormat: { leftIndent, rightIndent, firstLineIndent } }, 0)]);
  const example = report("零信任架構" + "x".repeat(30) + " Redundancy 提升");
  const short = layoutWarnings(example, { ...template, columns: 38 });
  assert.equal(short.length, 1);
  assert.match(short[0].message, /僅因未啟用整字換行/);
  assert.match(short[0].message, /update_answer_info.*layoutOptions\.wholeLatinWords=true/);
  assert.match(short[0].message, /不阻擋匯出/);
  assert.doesNotMatch(short[0].message, /長於一行/);
  assert.deepEqual(layoutWarnings(example), short);
  for (const layout of [report("ab " + "W".repeat(25), 20), report("前 " + "A1".repeat(25), 20),
    report("ab " + "W".repeat(17), 20, 2, 2), report("123456789012345678901", 10)]) {
    const warnings = layoutWarnings(layout);
    assert.ok(warnings.length > 0);
    assert.ok(warnings.every(warning => /長於一行/.test(warning.message)), "measure the whole run across all lines");
    assert.ok(warnings.every(warning => /不阻擋匯出/.test(warning.message)));
  }
  // The next line has no first-line indent, so this word can move there.
  assert.match(layoutWarnings(report("前 Redundancy", 20, 0, 0, 8))[0].message, /wholeLatinWords=true/);
  const separate = layoutSections(template, [normalizeSection({ text: "First\nSecond" }, 0)]);
  assert.deepEqual(layoutWarnings(separate), []);
});

test("heading padding counts toward sections, capacity and overflow before pagination", () => {
  const small = { ...template, linesPerPage: 4, pages: 1 };
  const answer = createAnswerDocument({ templateId: small.id, title: "標題", sections: [
    { id: "intro", text: "甲\n乙\n丙" }, { id: "body", heading: "標題", text: "正文" },
  ] });
  const off = layoutSections(small, answer.sections);
  const on = layoutSections(small, answer.sections, enabled);
  assert.deepEqual(layoutSections(small, answer.sections, legacy), off);
  assert.deepEqual(layoutWarnings(off).map(warning => warning.code), ["ORPHAN_HEADING"]);
  assert.equal(off.lines[3].isHeading, true); assert.equal(off.lines[3].page, 1);
  assert.equal(on.totalLines, off.totalLines + 1);
  assert.equal(on.overflowLines, off.overflowLines + 1);
  assert.equal(on.lines[3].isPadding, true); assert.equal(on.lines[3].isSpacer, true);
  assert.equal(on.lines[3].sectionId, "body"); assert.equal(renderTextLine(on.lines[3], small), "");
  assert.equal(layoutLineSchema.parse(on.lines[3]).isPadding, true);
  assert.equal(on.lines[4].isHeading, true); assert.equal(on.lines[4].page, 2); assert.equal(on.lines[4].lineOnPage, 1);
  assert.equal(on.lines[5].page, 2);
  assert.equal(planLines(answer, on).sections[1].lines, 3);
  assert.equal(on.compressionHints.find(hint => hint.sectionId === "body")?.currentLines, 3);
  assert.deepEqual(layoutWarnings(on), []);
  const top = [answer.sections[1]];
  assert.deepEqual(layoutSections(small, top, enabled), layoutSections(small, top));
  const longHeading = [normalizeSection({ text: "甲" }, 0), normalizeSection({ heading: "標\n題\n太\n長", text: "正文" }, 1)];
  assert.deepEqual(layoutSections(small, longHeading, enabled), layoutSections(small, longHeading));
  const headingOnly = [{ ...answer.sections[1], paragraphs: [], text: "", headingStyle: { spaceAfterLines: 4 } }];
  // Empty paragraphs are rendered body lines too; a block taller than a page stays unchanged.
  assert.deepEqual(layoutSections(small, [answer.sections[0], ...headingOnly], enabled), layoutSections(small, [answer.sections[0], ...headingOnly]));
});

test("multi-line headings and intervening spacers move together, including later sections", () => {
  const small = { ...template, linesPerPage: 5, columns: 6 };
  const sections = [normalizeSection({ text: "甲\n乙\n丙" }, 0),
    normalizeSection({ id: "first", heading: "標題兩行", text: "正文" }, 1),
    normalizeSection({ id: "second", heading: "次標題", text: "正文", headingStyle: { spaceAfterLines: 2 } }, 2)];
  const report = layoutSections(small, sections, enabled);
  assert.equal(report.lines.filter(line => line.isPadding && line.sectionId === "first").length, 2);
  assert.equal(report.lines.filter(line => line.isPadding && line.sectionId === "second").length, 2);
  assert.deepEqual(report.lines.filter(line => line.isHeading).map(line => [line.page, line.lineOnPage]), [[2, 1], [2, 2], [3, 1]]);
  assert.deepEqual(layoutWarnings(report), []);
});

async function withClient(run: (client: Client, store: FileStore, root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-layout-options-"));
  const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store);
  const client = new Client({ name: "layout-options-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try { await run(client, store, root); }
  finally { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text?: string }>).map(item => item.text ?? "").join("\n");
function data<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  assert.equal(result.isError, undefined, text(result));
  return result.structuredContent as T;
}
const sections = [{ id: "intro", text: Array(21).fill("前文").join("\n") },
  { id: "body", heading: "標題", text: "Zero Trust " + "A".repeat(22) + " Redundancy" }];

for (const paper of [false, true]) test(`split warnings reach check, bundle and overview with the ${paper ? "166" : "regular"} template`,
  { skip: paper && !process.env.ESSAY_MCP_PAPER_FONT }, async () => withClient(async (client, store) => {
    const currentTemplate = await store.getTemplate(paper ? "police_information_essay_166" : template.id);
    let count = 40;
    if (paper) {
      const measure = originalPaperMeasure(currentTemplate);
      const available = originalPaperAvailableWidth(paragraphFormatSchema.parse(currentTemplate.paragraphDefaults), currentTemplate);
      count = 1;
      while (measure("i".repeat(count + 1)) <= available) count++;
    }
    const answer = createAnswerDocument({ templateId: currentTemplate.id, title: "舊答案警告", sections: [{ text: "前 " + "i".repeat(count) }] });
    await store.saveAnswer(answer);
    const checked = data<{ warnings: Array<{ code: string; message: string }> }>(await client.callTool({ name: "check_layout", arguments: { answerId: answer.id } }));
    assert.ok(checked.warnings.length > 0);
    assert.ok(checked.warnings.every(warning => /wholeLatinWords=true/.test(warning.message)));
    const bundle = data<{ answers: Array<{ warnings: typeof checked.warnings }> }>(await client.callTool({ name: "export_exam_bundle", arguments: {
      answers: [{ answerId: answer.id, expectedVersion: 1 }], formats: ["docx"] } }));
    assert.deepEqual(bundle.answers[0].warnings, checked.warnings);
    const overview = data<{ examAnswers: Array<{ warnings: number }> }>(await client.callTool({ name: "render_exam_overview", arguments: { answerIds: [answer.id] } }));
    assert.equal(overview.examAnswers[0].warnings, checked.warnings.length);
  }));

test("create tools default and partially override options; hash includes only supplied options", async () => withClient(async (client, store) => {
  const args = { templateId: template.id, title: "預設", sections, idempotencyKey: "layout_hash_01" };
  const created = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: { ...args, responseDetail: "full" } }));
  assert.deepEqual(created.answer.layoutOptions, enabled);
  assert.deepEqual((await store.getRevision(created.answer.id, 1)).layoutOptions, enabled);
  assert.ok(created.layout.lines.some(line => line.isPadding));
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  assert.equal((await store.getAnswer(created.answer.id)).createRequestHash, createHash("sha256").update(canonical({ templateId: template.id, title: args.title, sections })).digest("hex"));
  const reused = await client.callTool({ name: "create_answer", arguments: { ...args, layoutOptions: {} } });
  assert.equal(reused.isError, true); assert.match(text(reused), /IDEMPOTENCY_KEY_REUSED/);
  const batch = data<{ answers: Array<{ answerId: string }> }>(await client.callTool({ name: "create_answers", arguments: { answers: [
    { templateId: template.id, title: "批次預設", sections }, { templateId: template.id, title: "部分", sections, layoutOptions: { wholeLatinWords: false } },
  ] } }));
  assert.deepEqual((await store.getAnswer(batch.answers[0].answerId)).layoutOptions, enabled);
  assert.deepEqual((await store.getAnswer(batch.answers[1].answerId)).layoutOptions, { wholeLatinWords: false, keepHeadingWithNext: true, avoidPunctuationOnlyLines: true });
  const explicit = { ...args, idempotencyKey: "layout_hash_02", layoutOptions: { wholeLatinWords: false } };
  const first = data<AnswerSnapshot>(await client.callTool({ name: "create_answer", arguments: { ...explicit, responseDetail: "full" } }));
  const { idempotencyKey: _key, ...request } = explicit;
  assert.equal((await store.getAnswer(first.answer.id)).createRequestHash, createHash("sha256").update(canonical({ ...request, templateId: template.id })).digest("hex"));
  assert.deepEqual(first.answer.layoutOptions, { wholeLatinWords: false, keepHeadingWithNext: true, avoidPunctuationOnlyLines: true });
  assert.equal(data<{ replayed: boolean }>(await client.callTool({ name: "create_answer", arguments: explicit })).replayed, true);
  assert.throws(() => answerDocumentSchema.parse({ ...first.answer, layoutOptions: { extra: true } }), /Unrecognized/);
  for (const name of ["create_answer", "update_answer_info"] as const) {
    const invalid = await client.callTool({ name, arguments: { templateId: template.id, title: "無效", answerId: first.answer.id, layoutOptions: { extra: true } } });
    assert.equal(invalid.isError, true);
  }
}));

test("legacy reads, update toggles, duplicates, previews and revisions use stored options", async () => withClient(async (client, store) => {
  const answer = createAnswerDocument({ templateId: template.id, title: "舊答案", sections });
  assert.equal(answer.layoutOptions, undefined);
  await store.saveAnswer(answer);
  const read = async () => data<AnswerSnapshot>(await client.callTool({ name: "read_answer", arguments: { answerId: answer.id } }));
  const original = await read();
  assert.deepEqual(original.layout, layoutSections(template, answer.sections));
  assert.deepEqual(data<AnswerSnapshot>(await client.callTool({ name: "load_exam_paper", arguments: { answerId: answer.id } })).layout, original.layout);
  const oldCopy = data<AnswerSnapshot>(await client.callTool({ name: "duplicate_answer", arguments: { answerId: answer.id, responseDetail: "full" } }));
  assert.equal(oldCopy.answer.layoutOptions, undefined); assert.deepEqual(oldCopy.layout, original.layout);
  const toggled = data<AnswerSnapshot & { changes: string[] }>(await client.callTool({ name: "update_answer_info", arguments: {
    answerId: answer.id, expectedVersion: 1, layoutOptions: enabled, responseDetail: "full" } }));
  assert.deepEqual(toggled.changes, ["整字換行：關 → 開", "標題不落頁尾：關 → 開"]);
  assert.equal(toggled.answer.version, 2); assert.equal(toggled.layout.totalLines, original.layout.totalLines + 1);
  assert.deepEqual(data<AnswerSnapshot>(await client.callTool({ name: "load_exam_paper", arguments: { answerId: answer.id } })).layout, toggled.layout);
  const copy = data<AnswerSnapshot>(await client.callTool({ name: "duplicate_answer", arguments: { answerId: answer.id, responseDetail: "full" } }));
  assert.deepEqual(copy.answer.layoutOptions, enabled); assert.deepEqual(copy.layout, toggled.layout);
  const preview = data<{ before: AnswerSnapshot; after: AnswerSnapshot }>(await client.callTool({ name: "preview_change", arguments: {
    answerId: answer.id, operation: "replace_text", sectionId: "body", newText: "正文。" } }));
  assert.deepEqual(preview.before.layout, toggled.layout); assert.deepEqual(preview.after.answer.layoutOptions, enabled);
  assert.deepEqual(preview.after.layout, layoutSections(template, preview.after.answer.sections, enabled));
  assert.ok(preview.after.layout.lines.some(line => line.isPadding)); assert.equal((await read()).answer.version, 2);
  const revisions = data<{ revisions: Array<{ version: number; totalLines: number; changes: string[] }> }>(await client.callTool({ name: "list_revisions", arguments: { answerId: answer.id } }));
  assert.deepEqual(revisions.revisions.map(revision => [revision.version, revision.totalLines]), [[2, toggled.layout.totalLines], [1, original.layout.totalLines]]);
  assert.ok(revisions.revisions[0].changes.includes("整字換行：關 → 開"));
  const partial = data<AnswerSnapshot & { changes: string[] }>(await client.callTool({ name: "update_answer_info", arguments: {
    answerId: answer.id, layoutOptions: { wholeLatinWords: false }, responseDetail: "full" } }));
  assert.deepEqual(partial.answer.layoutOptions, { wholeLatinWords: false, keepHeadingWithNext: true, avoidPunctuationOnlyLines: true });
  assert.deepEqual(partial.changes, ["整字換行：開 → 關"]);
  const restored = data<AnswerSnapshot>(await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version: 1, expectedVersion: 3, responseDetail: "full" } }));
  assert.deepEqual(restored.answer.layoutOptions, partial.answer.layoutOptions);
  const off = data<AnswerSnapshot & { changes: string[] }>(await client.callTool({ name: "update_answer_info", arguments: {
    answerId: answer.id, layoutOptions: { keepHeadingWithNext: false }, responseDetail: "full" } }));
  assert.deepEqual(off.changes, ["標題不落頁尾：開 → 關"]); assert.deepEqual(off.layout, original.layout);
}));

test("padding exports and renders as blank paper rows and is omitted from paragraph TXT", async () => withClient(async (_client, _store, root) => {
  const answer = createAnswerDocument({ templateId: template.id, title: "空白", sections });
  const report = layoutSections(template, answer.sections, enabled);
  const paper = path.join(root, "paper.txt"), paragraphs = path.join(root, "paragraphs.txt"), docx = path.join(root, "answer.docx");
  await exportText(report, template, paper);
  await exportParagraphTextBundle([{ report, template }], paragraphs);
  await exportDocx(report, template, docx);
  const raw = await fs.readFile(paper, "utf8");
  assert.ok(raw.includes("前文\n\n\f\n標題\n"));
  assert.equal(await fs.readFile(paragraphs, "utf8"), sections.map(section => [section.heading, section.text].filter(Boolean).join("\n")).join("\n\n") + "\n");
  const xml = await (await JSZip.loadAsync(await fs.readFile(docx))).file("word/document.xml")!.async("string");
  assert.equal((xml.match(/<w:tr>/g) ?? []).length, template.pages * template.linesPerPage);
  const errors: Error[] = [];
  const virtualConsole = new VirtualConsole(); virtualConsole.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(POLICE_ESSAY_WIDGET_HTML, { runScripts: "dangerously", url: "https://view.test", virtualConsole,
    beforeParse(window) { Object.defineProperty(window, "openai", { value: { toolOutput: { answer, layout: report }, toolResponseMetadata: { readOnly: true } } }); } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    const rows = dom.window.document.querySelectorAll(".answer-line");
    assert.equal(rows.length, template.pages * template.linesPerPage);
    assert.ok(rows[21].classList.contains("spacer"));
    assert.equal(rows[21].querySelector(".line-text")?.textContent, "");
    assert.equal(rows[22].querySelector(".line-text")?.textContent, "標題");
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); }
}));

test("a two-line heading starting on the page bottom moves with its body", () => {
  const small = { ...template, linesPerPage: 4, columns: 6 };
  const sections = [normalizeSection({ text: "甲\n乙\n丙" }, 0),
    normalizeSection({ id: "heading", heading: "標題兩行", text: "正文" }, 1)];
  const off = layoutSections(small, sections);
  assert.deepEqual(off.lines.filter(line => line.isHeading).map(line => [line.page, line.lineOnPage]), [[1, 4], [2, 1]]);
  assert.equal(off.lines.at(-1)!.page, 2);
  const on = layoutSections(small, sections, enabled);
  assert.equal(on.totalLines, off.totalLines + 1);
  assert.equal(on.lines[3].isPadding, true);
  assert.deepEqual(on.lines.filter(line => line.isHeading).map(line => [line.page, line.lineOnPage]), [[2, 1], [2, 2]]);
  assert.equal(on.lines.at(-1)!.page, 2); assert.equal(on.lines.at(-1)!.lineOnPage, 3);
  assert.deepEqual(layoutWarnings(on), []);
});
