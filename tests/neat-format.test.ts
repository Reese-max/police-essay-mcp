import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { test } from "node:test";
import { createAnswerDocument, templateSchema } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { layoutQualityNotes, scoreLayout } from "../src/layout-quality.js";

const standard = templateSchema.parse(JSON.parse(await fs.readFile("templates/police_information_essay.json", "utf8")));
const neat = { neatFormat: true, autoHangingIndent: true, compactPaper: true };
const start = (line: { format: { leftIndent: number; firstLineIndent: number; hangingIndent: number }; isFirstLineOfParagraph: boolean }) =>
  line.format.leftIndent + (line.isFirstLineOfParagraph ? line.format.firstLineIndent : line.format.hangingIndent);

// The 50招 p.9 skeleton: lead/closing first line 2 cells in, headings flush on their own line,
// body every line at the 3rd cell, numbers to its left.
const skeleton = [
  { id: "intro", text: "甲".repeat(30) },
  { id: "s1", heading: "(一)公告房屋標準價格的政府層級：", text: "乙".repeat(30) },
  { id: "s2", heading: "(二)評定的依據事項：", paragraphs: [{ text: "1.依構造評定：" }, { text: `(1)${"丙".repeat(30)}` }] },
  { id: "end", text: `綜上所述，${"丁".repeat(30)}` },
];

test("neatFormat lays out the book's neat skeleton", () => {
  const answer = createAnswerDocument({ templateId: standard.id, title: "neat", sections: skeleton });
  const report = layoutSections(standard, answer.sections, neat);
  const rows = report.lines.map(line => [line.sectionId, line.isHeading, start(line)]);
  assert.deepEqual(rows, [
    ["intro", false, 4], ["intro", false, 0],
    ["s1", true, 0], ["s1", false, 4], ["s1", false, 4],
    ["s2", true, 0], ["s2", false, 2], ["s2", false, 1], ["s2", false, 4],
    ["end", false, 4], ["end", false, 0],
  ]);
  assert.equal(scoreLayout(standard, { ...answer, layoutOptions: neat }, report).misalignedContinuations, 0);
});

test("neatFormat leaves explicit indents and answers without the flag alone", () => {
  const sections = [{ id: "s", heading: "(一)標題：", text: "乙".repeat(30), paragraphFormat: { firstLineIndent: 2 } }];
  const answer = createAnswerDocument({ templateId: standard.id, title: "explicit", sections });
  assert.deepEqual(layoutSections(standard, answer.sections, neat).lines.map(start), layoutSections(standard, answer.sections).lines.map(start));
  const plain = createAnswerDocument({ templateId: standard.id, title: "legacy", sections: skeleton });
  assert.ok(layoutSections(standard, plain.sections).lines.every(line => start(line) === 0));
});

function notes(sections: Parameters<typeof createAnswerDocument>[0]["sections"], options: object = neat) {
  const answer = { ...createAnswerDocument({ templateId: standard.id, title: "book", sections }), layoutOptions: options };
  const report = layoutSections(standard, answer.sections, options);
  return { notes: layoutQualityNotes(standard, answer, report).join("\n"), quality: scoreLayout(standard, answer, report) };
}

test("book-format notes: label headings, 壹、 and more than three levels", () => {
  const label = notes([{ id: "a", heading: "壹、前言", text: "內容。" }, { id: "b", heading: "貳、本文", text: "內容。" }, { id: "c", heading: "參、結論", text: "內容。" }]);
  assert.match(label.notes, /「壹、前言」、「貳、本文」、「參、結論」是功能標籤/);
  assert.match(label.notes, /不用「壹、」/);
  assert.equal(label.quality.bookFormatIssues, 2);
  const deep = notes([{ id: "a", heading: "一、甲：", paragraphs: [{ text: "(一)乙：" }, { text: "1.丙：" }, { text: "(1)丁。" }] }]);
  assert.match(deep.notes, /用了 4 層/);
  const book = notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙：" }, { text: "(1)丙。" }] }, { id: "end", text: "綜上所述。" }]);
  assert.equal(book.quality.bookFormatIssues, 0); assert.doesNotMatch(book.notes, /格式提醒/);
  assert.equal(notes([{ id: "a", heading: "壹、前言", text: "內容。" }], {}).quality.bookFormatIssues, 0, "older answers are not held to the books");
});

test("review rv5: independent book notes, headless middle text is body, full-width brackets", () => {
  const both = notes([{ id: "s", heading: "壹、法規依據：", paragraphs: [{ text: "一、點" }, { text: "(一)項" }, { text: "1.目" }, { text: "(1)細目" }] }]);
  assert.match(both.notes, /不用「壹、」/); assert.match(both.notes, /用了 5 層/);
  const answer = createAnswerDocument({ templateId: standard.id, title: "mid", sections: [{ id: "intro", text: "前言。" },
    { id: "s1", heading: "(一)甲：", text: "乙。" }, { id: "mid", text: "丙".repeat(40) }, { id: "end", text: "綜上所述。" }] });
  const mid = layoutSections(standard, answer.sections, neat).lines.filter(line => line.sectionId === "mid");
  assert.ok(mid.length > 1 && mid.every(line => start(line) === 4), "headless text between body sections stays on the text line");
  assert.match(notes([{ id: "s", heading: "（一）甲：", text: "乙。" }]).notes, /半形/);
  const book = notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙：" }, { text: "(1)丙。" }] }, { id: "end", text: "綜上所述。" }]);
  assert.equal(book.notes, "", "the book skeleton draws no structural or format note");
});

test("book notes: body points need a 大標, items each own a paragraph", () => {
  const terms = notes([{ id: "intro", text: "前言。" }, { id: "t1", text: "Locard 交換原理指出接觸會留下痕跡。" }, { id: "t2", text: "滲透測試是授權模擬攻擊。" }, { id: "end", text: "綜上所述。" }]);
  assert.match(terms.notes, /「Locard 交換原理指出接」、「滲透測試是授權模擬攻擊。」在本文中卻沒有大標/);
  const inline = notes([{ id: "intro", text: "前言。" }, { id: "a", text: "(一)甲：內容。" }, { id: "end", text: "綜上所述。" }]);
  assert.doesNotMatch(inline.notes, /沒有大標/, "a 大標 written inline at the paragraph start counts (最充實 format)");
  const restart = notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙。" }] }, { id: "b", paragraphs: [{ text: "1.丙。" }] }, { id: "end", text: "綜上所述。" }]);
  assert.match(restart.notes, /「1.丙。」在本文中卻沒有大標/); assert.doesNotMatch(restart.notes, /編號又從頭起算/, "one note per problem");
  assert.match(notes([{ id: "a", heading: "(一)甲：", paragraphs: [{ text: "(1)乙。(2)丙。" }] }]).notes, /一段內有多個編號項/);
  assert.doesNotMatch(notes([{ id: "a", heading: "(一)甲：", paragraphs: [{ text: "(1)依第2條規定。" }] }]).notes, /多個編號項/);
});

test("a colon-ended 中標 over body text is not an embedded heading in neat answers", () => {
  const sections = [{ id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.組織策略：" }, { text: "納入數位轉型願景。" }, { text: "2.作業流程：" }, { text: "先小規模試辦。" }] }];
  assert.equal(notes(sections).quality.embeddedHeadingParagraphs, 0);
  assert.equal(notes(sections, {}).quality.embeddedHeadingParagraphs, 2, "older answers keep the earlier rule");
});

test("review rv6: decimals, stacked 中標 and a closing-less last section", () => {
  assert.doesNotMatch(notes([{ id: "s", heading: "(一)查處情形：", paragraphs: [{ text: "1.本案查扣共5公斤；1.5公斤為安非他命。" }] }]).notes, /多個編號項/);
  assert.match(notes([{ id: "intro", text: "前言。" }, { id: "a", heading: "(一)甲：", paragraphs: [{ text: "1.乙。" }] }, { id: "b", paragraphs: [{ text: "1.丙重起。" }] }]).notes, /編號又從頭起算/);
});

test("a far-over answer gets a cut plan that reaches capacity; a small overflow does not", async () => {
  const { summarizeLayout } = await import("../src/layout.js");
  const plan = (sections: Parameters<typeof createAnswerDocument>[0]["sections"]) => {
    const report = layoutSections(standard, createAnswerDocument({ templateId: standard.id, title: "far", sections }).sections, neat);
    const text = summarizeLayout(report);
    const cuts = new Map([...text.matchAll(/(\w+) (\d+)→(\d+) 行/gu)].map((m) => [m[1], [Number(m[2]), Number(m[3])]]));
    return { report, text, cuts };
  };
  const long = (id: string, n: number, extra = {}) => ({ id, heading: "(一)標題：", text: "甲".repeat(n), ...extra });
  // A core section the hints protect stays untouched while a compressible one can absorb the overflow.
  const far = plan([long("core", 300, { required: true, priority: 5, compressible: 0 }), long("extra", 950, { required: false, priority: 1, compressible: 3 })]);
  assert.ok(far.report.overflowLines >= 5, far.text);
  assert.ok(!far.cuts.has("core"), far.text);
  const removed = [...far.cuts.values()].reduce((n, [from, to]) => n + from - to, 0);
  assert.equal(removed, far.report.overflowLines, "cuts add up to exactly the overflow, so meeting them fits");
  assert.match(far.text, /一次 write_answer/);
  // Far beyond what tightening can recover: say so instead of listing impossible targets.
  assert.match(plan([long("a", 3000)]).text, /先向使用者說明取捨/);
  let small = far.report;
  for (let n = 400; n < 2000 && !(small.overflowLines > 0 && small.overflowLines < 5); n += 5)
    small = layoutSections(standard, createAnswerDocument({ templateId: standard.id, title: "near", sections: [long("a", n)] }).sections, neat);
  assert.ok(small.overflowLines > 0 && small.overflowLines < 5);
  assert.doesNotMatch(summarizeLayout(small), /超出較多/);
});
