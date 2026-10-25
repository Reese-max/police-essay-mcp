import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import PDFDocument from "pdfkit";
import { createAnswerDocument, templateSchema } from "../src/domain.js";
import { exportPdf } from "../src/exporters.js";
import { layoutSections } from "../src/layout.js";
import { originalPaperFontPath, validatedOriginalPaperFont } from "../src/original-paper.js";

test("CI installs pdftotext before every matrix test run", async () => {
  const workflow = await fs.readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const steps = workflow.split(/^      - /m).slice(1);
  const testIndex = steps.findIndex(step => /^run: npm test\s*$/m.test(step));
  assert.ok(testIndex >= 0, "CI must run the test suite");
  const setup = steps.slice(0, testIndex).filter(step => !/^\s*if:/m.test(step)).join("\n");
  assert.match(setup, /apt-get install[^\n]*\bpoppler-utils\b/, "all matrix jobs need pdftotext before npm test");
});

test("166 PDF preserves measured glyph positions inside the writing area", { skip: !process.env.ESSAY_MCP_PAPER_FONT }, async t => {
  const template = templateSchema.parse(JSON.parse(await fs.readFile(new URL("../templates/police_information_essay_166.json", import.meta.url), "utf8")));
  const text = "i".repeat(39);
  const answer = createAnswerDocument({ templateId: template.id, title: "PDF geometry", sections: [{ text }] });
  const report = layoutSections(template, answer.sections);
  assert.equal(report.fits, true);
  assert.equal(report.totalLines, 1);
  const face = validatedOriginalPaperFont(originalPaperFontPath());
  const measure = (value: string) => face.layout(value).positions.reduce((sum: number, p: { xAdvance: number }) => sum + p.xAdvance, 0) * template.fontSizePt / face.unitsPerEm;
  const draw = t.mock.method(PDFDocument.prototype, "text");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paper166-pdf-geometry-"));
  try {
    await exportPdf(report, template, path.join(directory, "answer.pdf"));
    const calls: Array<[string, number, number]> = draw.mock.calls.map((call: { arguments: unknown[] }) => call.arguments as [string, number, number]);
    assert.equal(calls.map(([value]) => value).join(""), text);
    const right = Math.max(...calls.map(([value, x]) => x + measure(value)));
    assert.ok(right <= 496, `166 PDF extends to ${right.toFixed(2)}pt, beyond the 496pt writing boundary`);
    let expectedX = 130.32;
    for (const [value, x] of calls) {
      assert.ok(Math.abs(x - expectedX) < 0.01, "PDF and measured layout must use the same glyph advances");
      expectedX += measure(value);
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
