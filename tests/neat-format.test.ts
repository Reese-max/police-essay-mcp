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
