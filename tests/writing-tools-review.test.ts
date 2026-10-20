import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAnswerDocument, type AnswerSection, type AnswerTemplate } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { renumberItems } from "../src/numbering.js";
import { describeTargetChanges, planLines } from "../src/planning.js";

const templateDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "templates");
const grid = JSON.parse(readFileSync(path.join(templateDir, "police_information_essay.json"), "utf8")) as AnswerTemplate;
const texts = (section: AnswerSection) => section.paragraphs?.length ? section.paragraphs.map((paragraph) => paragraph.text) : section.text.split("\n");
const answer = (sections: Parameters<typeof createAnswerDocument>[0]["sections"]) =>
  createAnswerDocument({ templateId: grid.id, title: "審查回歸", sections });

test("numbers in the prose such as 二、三級 are neither counted nor rewritten", () => {
  const doc = answer([{ id: "a", heading: "一、說明", text: "二、三級機關應依規定辦理。\n一、組織。\n三、預算。" }]);
  const { sections, skipped } = renumberItems(doc.sections);
  assert.deepEqual(texts(sections[0]), ["二、三級機關應依規定辦理。", "一、組織。", "二、預算。"]);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /「一、說明」第1段/);
  assert.throws(() => renumberItems(answer([{ id: "a", text: "二、三級機關應依規定辦理。" }]).sections), /編號已經是連續的.*未計入/);
});

test("lists longer than 99 items keep arabic numbers going and refuse Chinese numerals past 99", () => {
  const arabic = answer([{ id: "a", text: Array.from({ length: 101 }, () => "1. 項目").join("\n") }]);
  const renumbered = texts(renumberItems(arabic.sections).sections[0]);
  assert.equal(renumbered[99], "100. 項目");
  assert.equal(renumbered[100], "101. 項目");
  const chinese = answer([{ id: "a", text: Array.from({ length: 100 }, () => "（一）項目").join("\n") }]);
  assert.throws(() => renumberItems(chinese.sections), /第 100 項，超過中文數字編號的上限 99/);
});

test("line targets only read a section's own target, also for ids like constructor", () => {
  const doc = { ...answer([{ id: "constructor", heading: "一、前言", text: "內容。" }, { id: "toString", text: "內容。" }]), lineTargets: { toString: 3 } };
  const plan = planLines(doc, layoutSections(grid, doc.sections));
  assert.deepEqual(plan.sections.map((section) => [section.sectionId, section.targetLines, section.overTarget]),
    [["constructor", undefined, undefined], ["toString", 3, -2]]);
  assert.deepEqual(describeTargetChanges({ ...doc, lineTargets: {} }, doc), ["「toString」目標行數：未設定→3 行"]);
});

test("a target that alone exceeds the sheet is reported even when other sections have none", () => {
  const doc = { ...answer([{ id: "a", heading: "一、前言", text: "內容。" }, { id: "b", text: "內容。" }]), lineTargets: { a: 45 } };
  const plan = planLines(doc, layoutSections(grid, doc.sections));
  assert.ok(plan.notes.some((note) => /各節目標合計 46 行（未設定目標的區塊以目前行數計），超過答案紙容量 44 行/.test(note)), plan.notes.join("|"));
});

test("titles that start with a numeral word stay items; prose numbers only skip when out of sequence", () => {
  for (const text of ["一、前言\n二、三權分立\n三、結論", "壹、參考資料\n貳、結論", "一、組織\n二、三級機關之職權\n三、預算"]) {
    assert.throws(() => renumberItems(answer([{ id: "a", text }]).sections), (error: Error) => /^編號已經是連續的/.test(error.message)
      && !error.message.includes("未計入"), text);
  }
  const inserted = renumberItems(answer([{ id: "a", text: "一、前言\n一、新增\n二、三權分立\n三、結論" }]).sections);
  assert.deepEqual(texts(inserted.sections[0]), ["一、前言", "二、新增", "三、三權分立", "四、結論"]);
  assert.deepEqual(inserted.skipped, []);
});

test("arabic markers of any length are renumbered", () => {
  const { sections } = renumberItems(answer([{ id: "a", text: "9999. 甲\n10000. 乙\n3. 丙" }]).sections);
  assert.deepEqual(texts(sections[0]), ["1. 甲", "2. 乙", "3. 丙"]);
});
