import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createAnswerDocument, templateSchema } from "../src/domain.js";
import { layoutSections, summarizeLayout } from "../src/layout.js";
import { layoutQualityNotes } from "../src/layout-quality.js";

const template = templateSchema.parse(JSON.parse(readFileSync("templates/police_information_essay.json", "utf8")));

test("small overflow gives section targets in one pass and stops at fits", () => {
  for (const extra of [1, 2, 3, 4]) {
    const answer = createAnswerDocument({ templateId: template.id, title: "test", sections: [
      { id: "intro", text: "甲".repeat(Math.floor(template.columns / 2) * (44 + extra - 1) + 1) },
    ] });
    const report = layoutSections(template, answer.sections);
    assert.equal(report.overflowLines, extra);
    const plan = summarizeLayout(report, true);
    assert.match(plan, /小幅超出/);
    assert.match(plan, new RegExp(`intro ${44 + extra}→44 行`));
    assert.match(plan, /edit_text/);
    assert.match(plan, /尾行/);
    assert.match(plan, /已在容量內就停止/);
    assert.doesNotMatch(summarizeLayout(report), /小幅超出/);
  }
});

test("score length note is neat-only, capacity capped and uses 75 percent threshold", () => {
  const check = (question: string | undefined, count: number, neatFormat = true) => {
    const answer = { ...createAnswerDocument({ templateId: template.id, title: "test", question,
      sections: [{ text: Array(count).fill("內容。").join("\n") }] }), layoutOptions: { neatFormat } };
    return layoutQualityNotes(template, answer, layoutSections(template, answer.sections, answer.layoutOptions)).filter(n => n.startsWith("篇幅提醒"));
  };
  assert.equal(check("請論述。（25分）", 19).length, 1);
  assert.match(check("請論述。(25 分)", 28)[0], /38 行/);
  assert.equal(check("請論述。（25分）", 29).length, 0);
  assert.equal(check("請論述。（50分）", 33).length, 0);
  assert.equal(check("請論述。（50分）", 32).length, 1);
  assert.equal(check("請論述。（25分）", 19, false).length, 0);
  assert.equal(check(undefined, 19).length, 0);
  assert.equal(check("請論述。（0分）", 19).length, 0);
  assert.equal(check("(一)甲（10分）(二)乙（15分）", 19).length, 1);
  assert.equal(check("(一)甲（10分）(二)乙（10分）", 19).length, 1);
  assert.equal(check("(一)甲（10分）(二)乙（5分）(三)丙（5分）", 19).length, 1);
  assert.equal(check("請論述。（共25分）", 19).length, 1);
  assert.equal(check("（25分）(一)甲（10分）(二)乙（15分）", 29).length, 0);
  assert.equal(check("（共25分）(一)甲（10分）(二)乙（15分）", 29).length, 0);
});

test("small overflow uses an available single line and prefers short tails within protection group", () => {
  const sections = Array.from({ length: 21 }, (_, i) => ({ id: `s${i}`, heading: "標題", text: "甲" }));
  const answer = createAnswerDocument({ templateId: template.id, title: "test", sections: [
    ...sections, { id: "tail", heading: "標題", text: "甲".repeat(22) },
  ] });
  const report = layoutSections(template, answer.sections);
  assert.equal(report.totalLines, 45);
  const plan = summarizeLayout(report, true);
  assert.match(plan, /tail 3→2 行/);
  assert.doesNotMatch(plan, /捨棄論點/);

  const ranked = createAnswerDocument({ templateId: template.id, title: "test", sections: [
    { id: "full", text: "甲".repeat(63), priority: 1 },
    { id: "tail", text: "乙".repeat(21 * 41 + 1), priority: 2 },
  ] });
  const targeted = summarizeLayout(layoutSections(template, ranked.sections), true);
  assert.match(targeted, /tail 42→41 行/);
  assert.doesNotMatch(targeted, /full 3→/);
});
