import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { exportDocx, exportPdf, exportText } from "../src/exporters.js";
import {
  createAnswerDocument,
  answerSectionInputSchema,
  headingStyleSchema,
  normalizeSection,
  updateSectionFormatting,
  type AnswerTemplate,
} from "../src/domain.js";
import { characterDisplayWidth, displayWidth, formatHeading, layoutSections, renderTextLine } from "../src/layout.js";
import { FileStore } from "../src/storage.js";
import { gridMetrics } from "../src/metrics.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = JSON.parse(
  await fs.readFile(path.join(projectRoot, "templates", "police_information_essay.json"), "utf8"),
) as AnswerTemplate;

test("display width counts CJK as two cells and ASCII as one", () => {
  assert.equal(characterDisplayWidth("中"), 2);
  assert.equal(characterDisplayWidth("A"), 1);
  assert.equal(characterDisplayWidth("\t", 4, 0), 4);
  assert.equal(characterDisplayWidth("\t", 4, 2), 2);
  assert.equal(displayWidth("中A文"), 5);
});

test("paragraph formatting controls indentation, spacing, alignment, tabs, and heading numbering", () => {
  const formattedTemplate: AnswerTemplate = {
    ...template,
    headingDefaults: {
      ...template.headingDefaults,
      bold: true,
      numbered: true,
      numbering: "chinese",
      separator: "、",
    },
  };
  const section = normalizeSection({
    id: "intro",
    heading: "壹、前言",
    text: "第一段\n第二\t段",
    headingStyle: { numbered: true },
    paragraphs: [
      { text: "第一段", format: { firstLineIndent: 2, alignment: "right", spaceAfterLines: 1 } },
      { text: "第二\t段", format: { leftIndent: 2, alignment: "distributed", tabSize: 4, bold: true } },
    ],
  }, 0);
  const report = layoutSections(formattedTemplate, [section]);
  const heading = report.lines[0];
  const firstParagraph = report.lines[1];
  const spacer = report.lines[2];
  const secondParagraph = report.lines[3];

  assert.equal(formatHeading("壹、前言", headingStyleSchema.parse({ numbered: true }), 2), "貳、前言");
  assert.equal(heading.text, "壹、前言");
  assert.equal(heading.isHeading, true);
  assert.equal(heading.format.bold, true);
  assert.equal(firstParagraph.format.firstLineIndent, 2);
  assert.equal(firstParagraph.format.alignment, "right");
  assert.equal(spacer.isSpacer, true);
  assert.equal(secondParagraph.format.leftIndent, 2);
  assert.equal(secondParagraph.format.alignment, "distributed");
  assert.match(renderTextLine(firstParagraph, formattedTemplate), /^ +第一段$/);
  assert.equal(report.totalLines, 4);
});

test("numbering starts at one for the first numbered heading", () => {
  const report = layoutSections(template, [
    normalizeSection({ id: "plain", heading: "說明", text: "內容" }, 0),
    normalizeSection({ id: "numbered", heading: "正式段落", headingStyle: { numbered: true }, text: "內容" }, 1),
  ]);
  assert.equal(report.lines.find((line) => line.isHeading && line.sectionId === "numbered")?.text, "壹、正式段落");
});

test("rejects conflicting text and paragraphs at the input boundary", () => {
  assert.throws(
    () => answerSectionInputSchema.parse({ text: "不同文字", paragraphs: [{ text: "段落文字" }] }),
    /text 與 paragraphs 內容不一致/,
  );
});

test("rejects a wide character that cannot fit after indentation", () => {
  const narrowTemplate = { ...template, columns: 3 };
  const section = normalizeSection({ id: "narrow", text: "字", paragraphFormat: { leftIndent: 2 } }, 0);
  assert.throws(() => layoutSections(narrowTemplate, [section]), /可用寬度只有/);
});

test("paragraphs can be supplied without duplicate text and formatting can be patched independently", () => {
  const section = normalizeSection({
    id: "body",
    paragraphs: [
      { text: "第一段" },
      { text: "第二段", format: { bold: true } },
    ],
  }, 0);
  assert.equal(section.text, "第一段\n第二段");
  assert.equal(section.paragraphs?.length, 2);

  const formatted = updateSectionFormatting(section, {
    paragraphFormat: { alignment: "justify", leftIndent: 1 },
    paragraphFormats: [{ index: 1, format: { italic: true } }],
  });
  assert.equal(formatted.paragraphFormat?.alignment, "justify");
  assert.equal(formatted.paragraphFormat?.leftIndent, 1);
  assert.equal(formatted.paragraphs?.[0]?.format, undefined);
  assert.equal(formatted.paragraphs?.[1]?.format?.bold, true);
  assert.equal(formatted.paragraphs?.[1]?.format?.italic, true);
});

test("exactly 44 full-width answer lines fit two pages", () => {
  const sections = [normalizeSection({ id: "body", text: Array(44).fill("字".repeat(21)).join("\n") }, 0)];
  const report = layoutSections(template, sections);
  assert.equal(report.totalLines, 44);
  assert.equal(report.overflowLines, 0);
  assert.equal(report.remainingLines, 0);
  assert.equal(report.fits, true);
  assert.deepEqual(report.pageUsage.slice(0, 2).map((page) => page.linesUsed), [22, 22]);
});

test("the 45th line is reported as overflow with compression hints", () => {
  const sections = [
    normalizeSection({ id: "intro", text: Array(23).fill("甲".repeat(21)).join("\n"), compressible: 5, priority: 1 }, 0),
    normalizeSection({ id: "core", text: Array(22).fill("乙".repeat(21)).join("\n"), required: true, compressible: 1, priority: 5 }, 1),
  ];
  const report = layoutSections(template, sections);
  assert.equal(report.totalLines, 45);
  assert.equal(report.overflowLines, 1);
  assert.equal(report.fits, false);
  assert.equal(report.compressionHints[0]?.sectionId, "intro");
  assert.equal(report.compressionHints[1]?.sectionId, "core");
  assert.equal(report.compressionHints[0]?.rank, 1);
  assert.equal(report.compressionHints[1]?.protected, true);
});

test("template line height is used consistently by grid metrics", () => {
  const metrics = gridMetrics(template);
  assert.equal(metrics.rowHeightPt, template.lineHeightPt);
  assert.equal(metrics.contentHeightPt, template.lineHeightPt * template.linesPerPage);
});

test("FileStore persists versioned answers and exporters create fixed-grid files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-mcp-"));
  const store = new FileStore({
    templateDir: path.join(projectRoot, "templates"),
    answerDir: path.join(root, "answers"),
    exportDir: path.join(root, "exports"),
  });
  try {
    const answer = createAnswerDocument({
      templateId: template.id,
      title: "測試答案",
      sections: [{
        id: "intro",
        heading: "壹、前言",
        headingStyle: { numbered: true, bold: true },
        text: "這是一段測試文字。\n第二段補充。",
        paragraphs: [
          { text: "這是一段測試文字。", format: { firstLineIndent: 2, alignment: "justify" } },
          { text: "第二段補充。\tTab", format: { leftIndent: 2, alignment: "distributed", tabSize: 4, italic: true } },
        ],
      }],
    });
    await store.saveAnswer(answer);
    const loaded = await store.getAnswer(answer.id);
    assert.equal(loaded.version, 1);

    const updateA = { ...loaded, title: "更新 A", version: 2, updatedAt: new Date().toISOString() };
    const updateB = { ...loaded, title: "更新 B", version: 2, updatedAt: new Date().toISOString() };
    const concurrent = await Promise.allSettled([
      store.saveAnswer(updateA, { expectedVersion: 1 }),
      store.saveAnswer(updateB, { expectedVersion: 1 }),
    ]);
    assert.equal(concurrent.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((item) => item.status === "rejected").length, 1);
    const winner = concurrent[0]?.status === "fulfilled" ? updateA : updateB;
    const loser = concurrent.find((item) => item.status === "rejected");
    assert.ok(loser?.status === "rejected");
    assert.match(String(loser.reason), /Version conflict: expected 1, current version is 2/);
    const persisted = await store.getAnswer(answer.id);
    assert.equal(persisted.version, 2);
    assert.equal(persisted.title, winner.title);
    assert.deepEqual(await fs.readdir(store.answerDir), [`${answer.id}.json`]);

    const report = layoutSections(template, loaded.sections);
    const docxPath = store.resolveExportPath("test-answer.docx", "docx");
    const pdfPath = store.resolveExportPath("test-answer.pdf", "pdf");
    const textPath = store.resolveExportPath("test-answer.txt", "txt");
    const docx = await exportDocx(report, template, docxPath);
    const pdf = await exportPdf(report, template, pdfPath);
    const text = await exportText(report, template, textPath);
    assert.equal(docx.pages, 2);
    assert.equal(pdf.pages, 2);
    assert.equal(text.pages, 2);
    assert.ok((await fs.stat(docxPath)).size > 1000);
    assert.ok((await fs.stat(pdfPath)).size > 1000);
    assert.match(await fs.readFile(textPath, "utf8"), /\f/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FileStore does not block a different answer while one write is paused", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-independent-"));
  const makeAnswer = (title: string) => createAnswerDocument({
    templateId: template.id,
    title,
    sections: [{ id: "intro", heading: "壹、前言", text: "初稿" }],
  });
  const first = makeAnswer("答案 A");
  const second = makeAnswer("答案 B");
  let releaseFirst!: () => void;
  let signalFirstEntered!: () => void;
  const firstEntered = new Promise<void>((resolve) => { signalFirstEntered = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let pauseFirst = false;
  class PausingStore extends FileStore {
    override async getAnswer(answerId: string) {
      if (pauseFirst && answerId === first.id) {
        signalFirstEntered();
        await firstGate;
      }
      return super.getAnswer(answerId);
    }
  }
  const store = new PausingStore({
    templateDir: path.join(projectRoot, "templates"),
    answerDir: path.join(root, "answers"),
    exportDir: path.join(root, "exports"),
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let firstPending: Promise<void> | undefined;
  try {
    await Promise.all([store.saveAnswer(first), store.saveAnswer(second)]);
    pauseFirst = true;
    firstPending = store.saveAnswer(
      { ...first, title: "答案 A 更新", version: 2, updatedAt: new Date().toISOString() },
      { expectedVersion: 1 },
    );
    await firstEntered;

    const secondPending = store.saveAnswer(
      { ...second, title: "答案 B 更新", version: 2, updatedAt: new Date().toISOString() },
      { expectedVersion: 1 },
    );
    await Promise.race([
      secondPending,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Unrelated answer was blocked by the first write.")), 5000);
      }),
    ]);
    const persistedSecond = await store.getAnswer(second.id);
    assert.equal(persistedSecond.version, 2);
    assert.equal(persistedSecond.title, "答案 B 更新");
  } finally {
    if (timeout) clearTimeout(timeout);
    pauseFirst = false;
    releaseFirst();
    if (firstPending) await firstPending;
    await fs.rm(root, { recursive: true, force: true });
  }
});
