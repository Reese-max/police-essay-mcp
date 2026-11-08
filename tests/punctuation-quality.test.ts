import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeSection, templateSchema } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { layoutWarnings } from "../src/planning.js";
import { exportPdf, exportPdfBundle } from "../src/exporters.js";
import PDFDocument from "pdfkit";

const template = templateSchema.parse(JSON.parse(await fs.readFile("templates/police_information_essay.json", "utf8")));
const options = { avoidPunctuationOnlyLines: true, wholeLatinWords: true };

test("closing punctuation carries a grapheme without losing characters, changing line count or mutating stored text", () => {
  const text = "甲".repeat(21) + "，";
  const section = normalizeSection({ id: "body", text }, 0);
  const before = JSON.stringify(section);
  const legacy = layoutSections(template, [section]);
  assert.deepEqual(legacy.lines.map(l => l.text), ["甲".repeat(21), "，"]);
  assert.equal(layoutWarnings(legacy)[0].code, "PUNCTUATION_ONLY_LINE");
  const fixed = layoutSections(template, [section], options);
  assert.deepEqual(fixed.lines.map(l => l.text), ["甲".repeat(20), "甲，"]);
  assert.equal(fixed.lines.map(l => l.text).join(""), text);
  assert.equal(fixed.totalLines, legacy.totalLines);
  assert.deepEqual(layoutWarnings(fixed), []);
  assert.equal(JSON.stringify(section), before);
  assert.deepEqual(layoutSections(template, [section], { avoidPunctuationOnlyLines: false }), legacy);
});

test("punctuation protection preserves explicit standalone marks and keeps Latin words whole when possible", () => {
  const explicit = normalizeSection({ text: "標點是刻意單獨輸入的。\n，\n---\n。" }, 0);
  assert.deepEqual(layoutSections(template, [explicit], options), layoutSections(template, [explicit]));
  assert.deepEqual(layoutWarnings(layoutSections(template, [explicit], options)), []);
  const section = normalizeSection({ text: "甲".repeat(18) + " Token。" }, 0);
  const report = layoutSections(template, [section], options);
  assert.deepEqual(report.lines.map(l => l.text), ["甲".repeat(18) + " ", "Token。"]);
  assert.equal(report.lines.map(l => l.text).join(""), section.text);
  for (const text of ["甲".repeat(20) + "e\u0301。", "甲".repeat(20) + "😀。", "甲".repeat(21) + "。！？"]) {
    const input = normalizeSection({ text }, 0);
    const wrapped = layoutSections(template, [input], options);
    assert.equal(wrapped.lines.map(l => l.text).join(""), text);
    assert.ok(wrapped.lines.every(l => l.displayWidth <= template.columns));
  }
});

test("PDF reports actual glyph overflow with the document page and row instead of claiming column fit is enough", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-glyph-width-"));
  const prototype = PDFDocument.prototype as any, original = prototype.text;
  const positions: Array<{ x: number; y: number; width: number }> = [];
  prototype.text = function(this: any, text: unknown, ...args: any[]) {
    if (text === "W" && typeof args[0] === "number") positions.push({ x: args[0], y: args[1], width: this.widthOfString(text) });
    return original.call(this, text, ...args);
  };
  try {
    const big = { ...template, fontSizePt: 28 };
    const report = layoutSections(big, [normalizeSection({ text: "W".repeat(42) }, 0)]);
    assert.equal(report.fits, true);
    const result = await exportPdfBundle([{ template, report: layoutSections(template, []) }, { template: big, report }], path.join(root, "wide.pdf"));
    assert.match(result.fontWarning ?? "", /第 3 頁第 1 行實際字形在不重疊下所需寬度超出可用格寬/);
    assert.ok(positions[41].x + positions[41].width < 595.28, "warning-only overflow must preserve the legacy positions, not push additional glyphs off the page");
    const short = layoutSections(big, [normalizeSection({ text: "W".repeat(14) + "\n" + "W".repeat(14) + "\n" + "W".repeat(14) }, 0)]);
    const fixed = await exportPdf(short, big, path.join(root, "wrapped.pdf"));
    assert.doesNotMatch(fixed.fontWarning ?? "", /實際字形.*超出/);
    assert.equal(positions.length, 84, "every wide glyph must be drawn exactly once");
    for (let index = 43; index < positions.length; index++) {
      const previous = positions[index - 1], current = positions[index];
      if (current.y === previous.y && current.x > previous.x) assert.ok(current.x >= previous.x + previous.width - 0.01, "a complete run that fits must use non-overlapping glyph advances");
    }
  } finally { prototype.text = original; await fs.rm(root, { recursive: true, force: true }); }
});
