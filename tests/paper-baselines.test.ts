import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import { FileStore } from "../src/storage.js";
import { createAnswerDocument } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { originalPaperPreview, originalPaperFontPath, validatedOriginalPaperFont } from "../src/original-paper.js";
import { exportPdf } from "../src/exporters.js";

test("166 real PDF and SVG share all 22 baselines and preserve mixed-script spaces", { skip: !process.env.ESSAY_MCP_PAPER_FONT }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baseline-regression-"));
  try {
    const template = await new FileStore().getTemplate("police_information_essay_166");
    const text = Array(22).fill("甲 SAP 與ERP 1").join("\n");
    const answer = createAnswerDocument({ templateId: template.id, title: "isolated baseline regression", sections: [{ id: "body", text }] });
    const report = layoutSections(template, answer.sections);
    const preview = originalPaperPreview(template, report)[0];
    const glyphs = [...preview.matchAll(/<use href="[^"]+" x="([\d.]+)" y="([\d.]+)"/g)];
    const face = validatedOriginalPaperFont(originalPaperFontPath());
    const perRow = face.layout("甲 SAP 與ERP 1").glyphs.length;
    assert.equal(glyphs.length, perRow * 22);
    const draw = t.mock.method(PDFDocument.prototype, "text");
    const file = path.join(root, "baselines.pdf");
    await exportPdf(report, template, file);
    assert.equal((await fs.readFile(file)).subarray(0, 5).toString(), "%PDF-");
    const calls = draw.mock.calls.map((c: { arguments: unknown[] }) => c.arguments as [string, number, number]);
    assert.equal(calls.length, 22);
    for (let row = 0; row < 22; row++) {
      assert.equal(calls[row][0], "甲 SAP 與ERP 1");
      assert.ok(Math.abs(calls[row][1] - Number(glyphs[row * perRow][1])) < .02);
      const baseline = calls[row][2] + template.fontSizePt * face.ascent / face.unitsPerEm;
      assert.ok(Math.abs(baseline - Number(glyphs[row * perRow][2])) < .02, `row ${row + 1}`);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
