import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import { FileStore } from "../src/storage.js";
import { createAnswerDocument } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { originalPaperPreview } from "../src/original-paper.js";
import { exportDocx, exportPdf } from "../src/exporters.js";

test("165 and legacy 166 preserve identical wrapping, SVG, DOCX geometry and PDF drawing coordinates", {
  skip: !process.env.ESSAY_MCP_PAPER_FONT && "approved MOE font unavailable; actual paper rendering remains unverified",
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paper-code-compatibility-"));
  try {
    const store = new FileStore({ answerDir: path.join(root, "answers"), exportDir: root });
    const current = await store.getTemplate("police_information_essay_165");
    const legacy = await store.getTemplate("police_information_essay_166");
    const sections = [{ id: "body", text: Array.from({ length: 44 }, (_, i) => `第${i + 1}行 甲 SAP 與ERP 1。`).join("\n"),
      paragraphFormat: { firstLineIndent: 1, leftIndent: 1, rightIndent: 1 } }];
    const oldAnswer = createAnswerDocument({ templateId: legacy.id, title: "代碼相容", sections });
    await store.saveAnswer(oldAnswer);
    const before = await fs.readFile(path.join(store.answerDir, `${oldAnswer.id}.json`));
    const saved = await store.getAnswer(oldAnswer.id);
    const oldReport = layoutSections(legacy, saved.sections, saved.layoutOptions);
    const report = layoutSections(current, saved.sections, saved.layoutOptions);
    assert.deepEqual(report, { ...oldReport, templateId: current.id });
    assert.equal(report.totalLines, 44);
    assert.equal(report.fits, true);
    assert.deepEqual(originalPaperPreview(current, report), originalPaperPreview(legacy, oldReport));
    // Also cover natural wrapping, heading placement and punctuation with the same measured font.
    const wrapped = createAnswerDocument({ templateId: legacy.id, title: "換行", sections: [{ id: "mixed", heading: "一、資料與流程",
      text: "資訊安全 Zero Trust Redundancy，資料與流程須相互配合。".repeat(8) }] });
    assert.deepEqual(layoutSections(current, wrapped.sections, wrapped.layoutOptions),
      { ...layoutSections(legacy, wrapped.sections, wrapped.layoutOptions), templateId: current.id });
    const xml: string[][] = [];
    const draw = t.mock.method(PDFDocument.prototype, "text");
    const coordinates: unknown[][] = [];
    for (const [index, template] of [legacy, current].entries()) {
      const layout = index === 0 ? oldReport : report;
      const docx = path.join(root, `${index}.docx`), pdf = path.join(root, `${index}.pdf`);
      assert.equal((await exportDocx(layout, template, docx)).pages, 2);
      const archive = await JSZip.loadAsync(await fs.readFile(docx));
      const files = Object.keys(archive.files).filter(name => /^word\/(document|header\d+|styles)\.xml$/.test(name)).sort();
      xml.push(await Promise.all(files.map(name => archive.file(name)!.async("string"))));
      const start = draw.mock.callCount();
      assert.equal((await exportPdf(layout, template, pdf)).pages, 2);
      coordinates.push(draw.mock.calls.slice(start).map((call: { arguments: unknown[] }) => call.arguments));
      assert.equal((await fs.readFile(pdf)).subarray(0, 5).toString(), "%PDF-");
    }
    assert.ok(xml[0].length >= 3, "compare document, original-paper header and styles");
    assert.deepEqual(xml[1], xml[0], "all Word text, table, page and background coordinates must match");
    assert.equal(coordinates[0].length, 44);
    assert.deepEqual(coordinates[1], coordinates[0], "all PDF text and positioning arguments must match");
    assert.deepEqual(await fs.readFile(path.join(store.answerDir, `${oldAnswer.id}.json`)), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
