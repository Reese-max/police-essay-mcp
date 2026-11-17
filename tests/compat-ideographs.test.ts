import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { createAnswerDocument, templateSchema, unifyCompatibilityIdeographs } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";

// U+F901 更, U+F902 車, U+F914 樂 and U+2F800 丽 look identical to U+66F4, U+8ECA, U+6A02 and U+4E3D.
const compat = "更車", unified = "更車";
const template = (id: string) => templateSchema.parse(JSON.parse(readFileSync(new URL(`../templates/${id}.json`, import.meta.url), "utf8")));
const layoutText = (id: string, heading: string, text: string) => {
  const answer = createAnswerDocument({ templateId: id, title: "t", sections: [{ id: "a", heading, text }] });
  return { answer, text: layoutSections(template(id), answer.sections, answer.layoutOptions).lines.map(line => line.text).join("\n") };
};

test("compatibility ideographs map to their unified forms and nothing else changes", () => {
  assert.equal(unifyCompatibilityIdeographs(`a${compat}\u{2F800}z`), `a${unified}丽z`);
  // U+FA0E has no unified equivalent; decomposed accents and full-width forms are not this function's business.
  for (const untouched of ["﨎", "é", "Ａ１", "一般文字 ABC 123，。"]) assert.equal(unifyCompatibilityIdeographs(untouched), untouched);
});

test("layout uses the unified forms in headings and text while the stored answer keeps what was written", () => {
  const { answer, text } = layoutText("police_information_essay", "樂", `${compat}一`);
  assert.ok(text.includes("樂") && text.includes(`${unified}一`), text);
  assert.doesNotMatch(text, /[豈-﫿]/u);
  assert.equal(answer.sections[0].text, `${compat}一`);
});

const paperFont = process.env.ESSAY_MCP_PAPER_FONT;
test("the 165 paper lays out compatibility ideographs instead of reporting a missing glyph", { skip: !paperFont || !existsSync(paperFont) }, () => {
  const { text } = layoutText("police_information_essay_165", "", `${compat}一`);
  assert.ok(text.includes(`${unified}一`), text);
});
