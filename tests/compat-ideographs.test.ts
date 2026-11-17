import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createAnswerDocument, layoutText, templateSchema, unifyCompatibilityIdeographs, type AnswerSection } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { scoreLayout } from "../src/layout-quality.js";

// U+F901 更, U+F902 車, U+F914 樂 and U+2F804 你 look identical to U+66F4, U+8ECA, U+6A02 and U+4F60.
const compat = "更車", unified = "更車";
const template = (id: string) => templateSchema.parse(JSON.parse(readFileSync(new URL(`../templates/${id}.json`, import.meta.url), "utf8")));
const general = template("police_information_essay"), paper = template("police_information_essay_165");
const answerOf = (templateId: string, sections: Array<{ id: string; heading?: string; text: string }>) => createAnswerDocument({ templateId, title: "t", sections });
const laidOut = (target: ReturnType<typeof template>, sections: AnswerSection[], options = {}) => layoutSections(target, sections, options).lines.map(line => line.text).join("\n");

test("compatibility ideographs map to their unified forms and nothing else changes", () => {
  assert.equal(unifyCompatibilityIdeographs(`a${compat}\u{2F804}z`), `a${unified}你z`);
  // U+FA0E has no unified equivalent; decomposed accents and full-width forms are not this function's business.
  for (const untouched of ["﨎", "é", "Ａ１", "一般文字 ABC 123，。"]) assert.equal(unifyCompatibilityIdeographs(untouched), untouched);
  assert.equal(layoutText(paper, compat), unified);
  assert.equal(layoutText(general, compat), compat);
});

test("the general template lays out exactly what was written", () => {
  const answer = answerOf(general.id, [{ id: "a", heading: "樂", text: `${compat}一` }]);
  const text = laidOut(general, answer.sections, answer.layoutOptions);
  assert.ok(text.includes("樂") && text.includes(`${compat}一`), text);
});

const paperFont = process.env.ESSAY_MCP_PAPER_FONT;
const needsFont = { skip: !paperFont || !existsSync(paperFont) };

test("the 165 paper lays out unified forms instead of reporting a missing glyph; the stored answer is untouched", needsFont, () => {
  const answer = answerOf(paper.id, [{ id: "a", heading: "樂", text: `${compat}一\u{2F804}` }]);
  const text = laidOut(paper, answer.sections, answer.layoutOptions);
  assert.ok(text.includes("樂") && text.includes(`${unified}一你`), text);
  assert.doesNotMatch(text, /[豈-﫿\u{2F800}-\u{2FA1F}]/u);
  assert.equal(answer.sections[0].text, `${compat}一\u{2F804}`);
  // Answers saved before per-paragraph storage carry only `text`.
  const legacy = answer.sections.map(({ paragraphs: _dropped, ...section }) => section) as AnswerSection[];
  assert.ok(laidOut(paper, legacy, answer.layoutOptions).includes(`${unified}一你`));
});

test("a heading inlined by compactPaper is still recognised when it was written with a compatibility ideograph", needsFont, () => {
  const body = "本文說明此一制度之目的與適用範圍，並就實務見解加以整理分析。";
  const score = (mark: string) => {
    const answer = answerOf(paper.id, [{ id: "lead", text: "前言說明本題爭點所在。" },
      { id: "a", heading: `一、${mark}觀其成`, text: `（一）${body}\n（二）${body}` }, { id: "b", heading: "二、依法行政", text: `（一）${body}\n（二）${body}` },
      { id: "end", text: "綜上，應視個案具體情形判斷之。" }]);
    const options = { ...answer.layoutOptions, compactPaper: true };
    return scoreLayout(paper, { ...answer, layoutOptions: options }, layoutSections(paper, answer.sections, options));
  };
  assert.deepEqual(score("樂"), score("樂"));
});
