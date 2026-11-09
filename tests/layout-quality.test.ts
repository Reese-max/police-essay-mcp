import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { createAnswerDocument, templateSchema } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { scoreLayout } from "../src/layout-quality.js";

const standard = templateSchema.parse(JSON.parse(await fs.readFile("templates/police_information_essay.json", "utf8")));
const paper165 = templateSchema.parse(JSON.parse(await fs.readFile("templates/police_information_essay_165.json", "utf8")));

function score(template: typeof standard, sections: Parameters<typeof createAnswerDocument>[0]["sections"], options = {}) {
  const answer = createAnswerDocument({ templateId: template.id, title: "排版品質測試", sections });
  const report = layoutSections(template, answer.sections, options);
  return scoreLayout(template, answer, report);
}

function scoreWithContinuationIndent(template: typeof standard, text: string, indent: number) {
  const answer = createAnswerDocument({ templateId: template.id, title: "懸掛縮排測試", sections: [{ text }] });
  const report = layoutSections(template, answer.sections);
  for (const line of report.lines.slice(1)) {
    line.format = { ...line.format, leftIndent: indent };
  }
  return scoreLayout(template, answer, report);
}

test("fill is a two-decimal occupied-capacity ratio", () => {
  const sparse = score(standard, [{ text: "短文。" }]);
  const fuller = score(standard, [{ text: "甲".repeat(22) }]);
  assert.equal(sparse.fill, 0.02);
  assert.ok(fuller.fill > sparse.fill);
});

test("flattened structure distinguishes a single long list from a sectioned answer", () => {
  const good = score(standard, [
    { heading: "一、第一節", text: "第一節內容。" },
    { heading: "二、第二節", text: "第二節內容。" },
  ]);
  const bad = score({ ...standard, columns: 12 }, [{
    text: `1. ${"甲".repeat(90)}\n2. ${"乙".repeat(90)}`,
  }]);
  assert.equal(good.flattenedStructure, false);
  assert.equal(bad.flattenedStructure, true);
});

test("embedded heading paragraphs count only numbered body paragraphs without sentence-ending punctuation", () => {
  const good = score(standard, [{ text: "一、管理措施應落實並定期檢討。" }]);
  const bad = score(standard, [{ text: "一、管理措施應落實並定期檢討" }]);
  assert.equal(good.embeddedHeadingParagraphs, 0);
  assert.ok(bad.embeddedHeadingParagraphs > 0);
});

test("numbered paragraph detection covers the supported Chinese and Arabic marker families", () => {
  const result = score(standard, [{
    text: "壹、甲\n拾、乙\n一、丙\n二十、丁\n（一）戊\n(一)己\n1.庚\n1、辛\n１．壬\n（1）癸\n(1)子",
  }]);
  assert.equal(result.embeddedHeadingParagraphs, 11);
});

test("numbered paragraph continuations use the measured hanging start column", () => {
  const content = `2.ERP 以共用平台整合資料與流程，${"持續管理並定期檢查。".repeat(5)}`;
  const good = scoreWithContinuationIndent(standard, content, 4);
  const bad = score(standard, [{
    text: content,
    paragraphFormat: { firstLineIndent: 6 },
  }]);
  assert.equal(good.misalignedContinuations, 0);
  assert.ok(bad.misalignedContinuations > 0);
});

test("hierarchy accepts consecutive siblings and detects numbering gaps and level jumps", () => {
  const good = score(standard, [
    { heading: "一、第一節", text: "內容。" },
    { heading: "（一）子項", text: "內容。" },
    { heading: "二、第二節", text: "內容。" },
  ]);
  const bad = score(standard, [
    { heading: "一、第一節", text: "內容。" },
    { heading: "三、第三節", text: "內容。" },
    { heading: "（一）跳級", text: "內容。" },
  ]);
  assert.equal(good.hierarchyIssues, 0);
  assert.ok(bad.hierarchyIssues > 0);
  const mixedFamilies = score(standard, [{ text: "1.第一項\n2、第二項" }]);
  assert.ok(mixedFamilies.hierarchyIssues > 0);
});

test("body paragraph first-line indentation is consistent or reported", () => {
  const good = score(standard, [
    { heading: "前言", text: "第一段內容。", paragraphFormat: { firstLineIndent: 2 } },
    { heading: "結語", text: "第二段內容。", paragraphFormat: { firstLineIndent: 2 } },
  ]);
  const bad = score(standard, [
    { heading: "前言", text: "第一段內容。", paragraphFormat: { firstLineIndent: 0 } },
    { heading: "結語", text: "第二段內容。", paragraphFormat: { firstLineIndent: 4 } },
  ]);
  assert.equal(good.indentInconsistency, 0);
  assert.ok(bad.indentInconsistency > 0);
});

test("short tail lines ignore single-line paragraphs and flag tails up to four columns", () => {
  const narrow = { ...standard, columns: 10 };
  const good = score(narrow, [{ text: "甲".repeat(13) }]);
  const bad = score(narrow, [{ text: "甲".repeat(12) }]);
  assert.equal(good.shortTailLines, 0);
  assert.ok(bad.shortTailLines > 0);
});

test("punctuation-only warnings follow planning layoutWarnings", () => {
  const good = score(standard, [{ text: `${"甲".repeat(20)}，` }]);
  const bad = score(standard, [{ text: `${"甲".repeat(21)}，` }]);
  assert.equal(good.punctuationOnlyLines, 0);
  assert.ok(bad.punctuationOnlyLines > 0);
});

test("165 paper hanging-indent measurements distinguish aligned and top-aligned continuations", {
  skip: !process.env.ESSAY_MCP_PAPER_FONT,
}, () => {
  const content = `2.ERP 以共用平台整合資料與流程，${"持續管理並定期檢查。".repeat(8)}`;
  const good = scoreWithContinuationIndent(paper165, content, 4);
  const bad = score(paper165, [{ text: content, paragraphFormat: { firstLineIndent: 8 } }]);
  assert.equal(good.misalignedContinuations, 0);
  assert.ok(bad.misalignedContinuations > 0);
});
