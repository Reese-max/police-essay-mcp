import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { FileStore } from "../src/storage.js";
import { createAnswerDocument } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { originalPaper, originalPaperPreview, originalPaperFontPath, originalPaperRenderBaseline, validatedOriginalPaperFont } from "../src/original-paper.js";
import { exportPdf } from "../src/exporters.js";

test("166 PDF and SVG preserve mixed-script text at all 44 calibrated baselines", { skip: !process.env.ESSAY_MCP_PAPER_FONT }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baseline-multipage-"));
  try {
    const template = await new FileStore().getTemplate("police_information_essay_166");
    const textLine = "甲 SAP 與ERP 1";
    const text = Array(44).fill(textLine).join("\n");
    const answer = createAnswerDocument({ templateId: template.id, title: "isolated baseline regression", sections: [{ id: "body", text }] });
    const report = layoutSections(template, answer.sections);
    assert.equal(report.totalLines, 44);
    assert.deepEqual(report.lines.map(line => line.text), Array(44).fill(textLine));
    const previews = originalPaperPreview(template, report);
    const face = validatedOriginalPaperFont(originalPaperFontPath());
    const perRow = face.layout(textLine).glyphs.length;
    const draw = t.mock.method(PDFDocument.prototype, "text");
    const file = path.join(root, "baselines.pdf");
    const exported = await exportPdf(report, template, file);
    assert.equal(exported.pages, 2);
    assert.equal((await fs.readFile(file)).subarray(0, 5).toString(), "%PDF-");
    const calls = draw.mock.calls.map((c: { arguments: unknown[] }) => c.arguments as [string, number, number]);
    assert.equal(calls.length, 44);
    assert.equal(previews.length, 2);
    for (let page = 0; page < 2; page++) {
      const glyphs = [...previews[page].matchAll(/<use href="[^"]+" x="([\d.]+)" y="([\d.]+)"/g)];
      assert.equal(glyphs.length, perRow * 22);
      for (let row = 0; row < 22; row++) {
        const call = calls[page * 22 + row];
        assert.equal(call[0], textLine);
        assert.ok(Math.abs(call[1] - Number(glyphs[row * perRow][1])) < .02);
        const baseline = call[2] + template.fontSizePt * face.ascent / face.unitsPerEm;
        assert.ok(Math.abs(baseline - Number(glyphs[row * perRow][2])) < .02, `page ${page + 1} row ${row + 1}`);
        assert.ok(Math.abs(baseline - originalPaperRenderBaseline(row)) < .0001);
        assert.ok(Math.abs(baseline - (originalPaper.rows[row][1] - 3.5) + 1.5) < .0001);
      }
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
