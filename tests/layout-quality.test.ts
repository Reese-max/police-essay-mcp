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
  const leadIn = score(standard, [{ text: "（三）流程：\n1. 擬具需求。\n2. 公告周知。" }]);
  assert.equal(leadIn.embeddedHeadingParagraphs, 0);
  const proseBelow = score(standard, [{ text: "（三）流程\n擬具需求並公告周知。" }]);
  assert.equal(proseBelow.embeddedHeadingParagraphs, 1);
});

test("numbered paragraph detection covers the supported Chinese and Arabic marker families", () => {
  // One section each, so no marker counts as a lead-in for the next one.
  const result = score(standard, ["壹、甲", "拾、乙", "一、丙", "二十、丁", "（一）戊", "(一)己", "1.庚", "1、辛", "１．壬", "（1）癸", "(1)子"]
    .map((text, index) => ({ id: `s${index}`, text })));
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

test("review regressions: tens numerals, heavenly stems, quoted sentence ends and blank paragraphs", () => {
  const twenties = score(standard, Array.from({ length: 22 }, (_, index) => ({
    heading: `${["", "十", "二十"][Math.floor((index + 1) / 10)]}${["", "一", "二", "三", "四", "五", "六", "七", "八", "九"][(index + 1) % 10]}、第${index + 1}節`,
    text: "內容。",
  })));
  assert.equal(twenties.hierarchyIssues, 0);
  const stems = score(standard, [{ text: "內文。", paragraphs: [
    { text: "一般內文說明。", format: { firstLineIndent: 4 } },
    { text: "甲、天干編號段落說明。" },
    { text: "另一段一般內文。", format: { firstLineIndent: 4 } },
  ] }]);
  assert.equal(stems.indentInconsistency, 0);
  const quoted = score(standard, [{ text: "一、他說：「依法處理。」" }]);
  assert.equal(quoted.embeddedHeadingParagraphs, 0);
  const blank = score(standard, [{ heading: "一、甲", text: "x", paragraphs: [
    { text: "內文一段落。", format: { firstLineIndent: 4 } }, { text: "" }, { text: "內文二段落。", format: { firstLineIndent: 4 } },
  ] }]);
  assert.equal(blank.indentInconsistency, 0);
});

test("short tail warning appears only when the answer overflows", async () => {
  const { layoutWarnings } = await import("../src/planning.js");
  const perLine = layoutSections(standard, createAnswerDocument({ templateId: standard.id, title: "t", sections: [{ text: "甲".repeat(200) }] }).sections)
    .lines[0].text.length;
  const tailParagraph = "甲".repeat(perLine + 1);
  const tails = (filler: number) => {
    const answer = createAnswerDocument({ templateId: standard.id, title: "t", sections: [{ text: [tailParagraph, ...Array(filler).fill("乙")].join("\n") }] });
    return layoutWarnings(layoutSections(standard, answer.sections), standard).filter(warning => warning.code === "SHORT_TAIL_LINE");
  };
  assert.equal(tails(10).length, 0);
  assert.equal(tails(50).length, 1);
});

test("layout quality notes name skipped levels and disabled auto hanging indent", async () => {
  const { layoutQualityNotes } = await import("../src/layout-quality.js");
  const notesFor = (sections: Parameters<typeof createAnswerDocument>[0]["sections"], layoutOptions = {}) => {
    const answer = { ...createAnswerDocument({ templateId: standard.id, title: "t", sections }), layoutOptions };
    return layoutQualityNotes(standard, answer, layoutSections(standard, answer.sections, layoutOptions));
  };
  const skipped = notesFor([{ id: "a", heading: "壹、概念", text: "（一）原則\n1. 驗證。\n2. 授權。" }]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /「（一）原則」跳過中間層級.*一、/);
  assert.deepEqual(notesFor([{ id: "a", heading: "壹、概念", text: "一、原則\n（一）驗證。\n（二）授權。" }]), []);
  const off = notesFor([{ id: "a", text: `1. ${"甲".repeat(60)}` }], { autoHangingIndent: false });
  assert.match(off.join(""), /autoHangingIndent=true/);
});

test("compactPaper inlined headings and colon list items are not embedded headings", { skip: !process.env.ESSAY_MCP_PAPER_FONT }, () => {
  const options = { compactPaper: true, autoHangingIndent: true };
  const result = score(paper165, [
    { id: "a", heading: "壹、原因", text: "（一）門檻過高，告警未通報。\n（二）無人覆核。" },
    { id: "b", heading: "貳、對策", text: "（一）流程\n1.分級：分重大與一般兩級\n2.時限：訂定通報完成時限" },
  ], options);
  assert.equal(result.embeddedHeadingParagraphs, 0);
  // Mixed inlined (short) and standalone (too wide) headings must still read as 壹→貳→參→肆, not 貳→肆.
  const long = "乙".repeat(20);
  const mixed = score(paper165, [
    { id: "a", heading: "壹、甲", text: "說明。" }, { id: "b", heading: `貳、${long}`, text: "說明。" },
    { id: "c", heading: "參、丙", text: "說明。" }, { id: "d", heading: `肆、${long}`, text: "說明。" },
  ], options);
  assert.equal(mixed.hierarchyIssues, 0);
});