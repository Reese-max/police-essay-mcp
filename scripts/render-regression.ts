import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { templateSchema, createAnswerDocument } from "../src/domain.js";
import { exportDocx, exportPdf } from "../src/exporters.js";
import { layoutSections } from "../src/layout.js";

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resolveCommand(environmentName: string, commandName: string): string | undefined {
  const configured = process.env[environmentName];
  if (configured) return configured;
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [commandName], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return undefined;
  return result.stdout.trim().split(/\r?\n/)[0] || undefined;
}

async function run(command: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(command, args, { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
}

async function pngDimensions(filename: string): Promise<{ width: number; height: number; bytes: number }> {
  const buffer = await fs.readFile(filename);
  assert.equal(buffer.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${filename} is not a PNG`);
  assert.equal(buffer.toString("ascii", 12, 16), "IHDR", `${filename} has no PNG IHDR`);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bytes: buffer.byteLength,
  };
}

async function inspectRenderedPages(directory: string, expectedPages: number): Promise<void> {
  const pages = (await fs.readdir(directory))
    .filter((filename) => filename.toLowerCase().endsWith(".png"))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
  assert.equal(pages.length, expectedPages, `expected ${expectedPages} rendered pages, got ${pages.length}`);
  for (const page of pages) {
    const dimensions = await pngDimensions(path.join(directory, page));
    // A deliberately blank second answer-sheet page is still a valid render;
    // use a low PNG-size floor to catch truncated files without rejecting it.
    assert.ok(dimensions.bytes > 1_000, `${page} is suspiciously empty`);
    assert.ok(dimensions.width >= 800 && dimensions.height >= 1_000, `${page} is too small`);
    const ratio = dimensions.height / dimensions.width;
    assert.ok(ratio > 1.25 && ratio < 1.6, `${page} is not A4-like: ${dimensions.width}x${dimensions.height}`);
  }
}

async function renderPdf(pdfPath: string, outputDirectory: string, prefix: string, expectedPages: number): Promise<void> {
  const pdftoppm = resolveCommand("PDFTOPPM", "pdftoppm");
  if (!pdftoppm) throw new Error("pdftoppm is required for render regression; set PDFTOPPM to its executable path.");
  await run(pdftoppm, ["-png", pdfPath, path.join(outputDirectory, prefix)], projectRoot);
  await inspectRenderedPages(outputDirectory, expectedPages);
}

async function renderDocx(docxPath: string, outputDirectory: string, expectedPages: number): Promise<"rendered" | "skipped"> {
  const renderer = process.env.DOCX_RENDERER;
  const python = process.env.PYTHON ?? resolveCommand("PYTHON", process.platform === "win32" ? "python.exe" : "python3");
  if (renderer && python) {
    await run(python, [renderer, docxPath, "--output_dir", outputDirectory, "--emit_pdf"], projectRoot);
    await inspectRenderedPages(outputDirectory, expectedPages);
    return "rendered";
  }

  const soffice = resolveCommand("SOFFICE", process.platform === "win32" ? "soffice.exe" : "soffice");
  const pdftoppm = resolveCommand("PDFTOPPM", "pdftoppm");
  if (!soffice || !pdftoppm) return "skipped";

  const profileDirectory = path.join(outputDirectory, "lo-profile");
  await fs.mkdir(profileDirectory, { recursive: true });
  const profileUri = `file://${profileDirectory.replaceAll(path.sep, "/")}`;
  await run(soffice, [
    "--headless",
    `-env:UserInstallation=${profileUri}`,
    "--convert-to",
    "pdf",
    "--outdir",
    outputDirectory,
    docxPath,
  ], projectRoot);
  const pdfPath = path.join(outputDirectory, `${path.basename(docxPath, ".docx")}.pdf`);
  await fs.access(pdfPath);
  await run(pdftoppm, ["-png", pdfPath, path.join(outputDirectory, "docx-page")], projectRoot);
  await inspectRenderedPages(outputDirectory, expectedPages);
  return "rendered";
}

async function main(): Promise<void> {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-render-regression-"));
  try {
    const templateRaw = await fs.readFile(path.join(projectRoot, "templates", "police_information_essay.json"), "utf8");
    const template = templateSchema.parse(JSON.parse(templateRaw));
    const answer = createAnswerDocument({
      templateId: template.id,
      title: "固定版面 render regression",
      question: "驗證中文、粗體、斜體、首行縮排、左右縮排與段落對齊。",
      sections: [
        {
          id: "intro",
          heading: "前言",
          headingStyle: { bold: true, alignment: "left" },
          paragraphs: [
            { text: "本測試驗證固定格線輸出的頁數、A4 比例與可讀性。", format: { firstLineIndent: 2, alignment: "justify" } },
            { text: "第二段包含 English 123、Tab\t與標點。", format: { leftIndent: 1, rightIndent: 1, italic: true } },
          ],
        },
        {
          id: "body",
          heading: "本文",
          text: "版面引擎先計算行數，再由 DOCX 與 PDF exporter 使用相同的格線指標輸出。",
          paragraphFormat: { firstLineIndent: 2, alignment: "distributed" },
        },
      ],
    });
    const report = layoutSections(template, answer.sections);
    assert.equal(report.fits, true);

    const docxPath = path.join(temporaryRoot, "render-regression.docx");
    const pdfPath = path.join(temporaryRoot, "render-regression.pdf");
    const docxRenderDirectory = path.join(temporaryRoot, "docx-pages");
    const pdfRenderDirectory = path.join(temporaryRoot, "pdf-pages");
    await Promise.all([
      fs.mkdir(docxRenderDirectory, { recursive: true }),
      fs.mkdir(pdfRenderDirectory, { recursive: true }),
    ]);

    const docx = await exportDocx(report, template, docxPath);
    const pdf = await exportPdf(report, template, pdfPath);
    assert.equal(docx.pages, template.pages);
    assert.equal(pdf.pages, template.pages);
    assert.equal((await fs.stat(docx.path)).isFile(), true);
    assert.equal((await fs.stat(pdf.path)).isFile(), true);

    await renderPdf(pdf.path, pdfRenderDirectory, "pdf-page", template.pages);
    const docxStatus = await renderDocx(docx.path, docxRenderDirectory, template.pages);
    if (docxStatus === "skipped" && process.env.REQUIRE_DOCX_RENDER === "true") {
      throw new Error("DOCX renderer unavailable; REQUIRE_DOCX_RENDER=true requires LibreOffice or DOCX_RENDERER/PYTHON.");
    }
    console.log(JSON.stringify({
      ok: true,
      pdf: { pages: pdf.pages, rendered: true },
      docx: { pages: docx.pages, rendered: docxStatus === "rendered", skipped: docxStatus === "skipped" },
      note: docxStatus === "skipped" ? "DOCX renderer unavailable; set DOCX_RENDERER/PYTHON or install LibreOffice." : undefined,
    }, null, 2));
  } finally {
    if (process.env.KEEP_RENDER_ARTIFACTS === "true") {
      console.log(`render artifacts kept at ${temporaryRoot}`);
    } else {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

await main();

