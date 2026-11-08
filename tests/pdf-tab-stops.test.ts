import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { templateSchema, createAnswerDocument } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { exportDocx, exportPdf } from "../src/exporters.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = templateSchema.parse(
  JSON.parse(await fs.readFile(path.join(projectRoot, "templates", "police_information_essay.json"), "utf8")),
);

const binaryReady = (bin: string): boolean => {
  try {
    execFileSync(bin, bin === "soffice" ? ["--version"] : ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
const skip = !binaryReady("pdftotext") || !binaryReady("soffice");

function wordX(xml: string, char: string): number {
  const wordRe = /<word\s+([^>]*)>([^<]*)<\/word>/g;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(xml)) !== null) {
    if (match[2] === char) {
      const xMin = match[1].match(/xMin="([0-9.]+)"/);
      assert.ok(xMin, `找不到字元 ${char} 的 xMin`);
      return Number(xMin[1]);
    }
  }
  throw new Error(`PDF bbox 輸出中找不到字元 ${char}`);
}

test("PDF Tab 對齊答題格欄位，與 DOCX 定位點相差小於 2pt", { skip }, async () => {
  const answer = createAnswerDocument({
    templateId: template.id,
    title: "tab 定位點測試",
    sections: [{ id: "body", text: "甲\t乙\t丙", paragraphFormat: { tabSize: 4 } }],
  });
  const report = layoutSections(template, answer.sections);
  assert.equal(report.lines.length, 1);
  assert.equal(report.lines[0]!.text, "甲\t乙\t丙");

  const pdfDir = await fs.mkdtemp(path.join(os.tmpdir(), "essay-tab-pdf-"));
  const docxDir = await fs.mkdtemp(path.join(os.tmpdir(), "essay-tab-docx-"));
  try {
    const pdfPath = path.join(pdfDir, "tab.pdf");
    const docxPath = path.join(docxDir, "tab.docx");
    await exportPdf(report, template, pdfPath);
    await exportDocx(report, template, docxPath);

    const pdfXml = execFileSync("pdftotext", ["-bbox", pdfPath, "-"], { encoding: "utf8" });
    const pdfYi = wordX(pdfXml, "乙");

    execFileSync("soffice", ["--headless", "--convert-to", "pdf", "--outdir", docxDir, docxPath], {
      stdio: "ignore",
    });
    const docxXml = execFileSync("pdftotext", ["-bbox", path.join(docxDir, "tab.pdf"), "-"], {
      encoding: "utf8",
    });
    const docxYi = wordX(docxXml, "乙");

    assert.ok(
      Math.abs(pdfYi - docxYi) < 2,
      `PDF 乙 x=${pdfYi.toFixed(2)}pt 與 DOCX 定位點 x=${docxYi.toFixed(2)}pt 相差超過 2pt`,
    );
  } finally {
    await fs.rm(pdfDir, { recursive: true, force: true });
    await fs.rm(docxDir, { recursive: true, force: true });
  }
});
