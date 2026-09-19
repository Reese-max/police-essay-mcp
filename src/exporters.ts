import { promises as fs, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import type { AnswerTemplate, LayoutLine, LayoutReport } from "./domain.js";

const A4_WIDTH_PT = 595.28;
const A4_HEIGHT_PT = 841.89;
const TWIPS_PER_MM = 56.6929133858;

function mmToTwips(mm: number): number {
  return Math.round(mm * TWIPS_PER_MM);
}

function mmToPoints(mm: number): number {
  return mm * 72 / 25.4;
}

function pageLines(report: LayoutReport, page: number): LayoutLine[] {
  return report.lines.filter((line) => line.page === page);
}

function outputPageCount(report: LayoutReport, template: AnswerTemplate, allowOverflow: boolean): number {
  if (!report.fits && !allowOverflow) {
    throw new Error(
      `答案超出模板容量 ${report.overflowLines} 行；請先修改答案或以 allowOverflow=true 明確輸出溢出版。`,
    );
  }
  return allowOverflow ? Math.max(template.pages, report.pagesUsed) : template.pages;
}

function makeLineParagraph(template: AnswerTemplate, text: string): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: {
      before: 0,
      after: 0,
      line: Math.round(template.lineHeightPt * 20),
    },
    children: [
      new TextRun({
        text,
        size: Math.round(template.fontSizePt * 2),
        font: {
          ascii: template.fontFamily,
          hAnsi: template.fontFamily,
          eastAsia: template.fontFamily,
        },
      }),
    ],
  });
}

function makeDocxPageTable(template: AnswerTemplate, lines: LayoutLine[], page: number): Table {
  const rows = Array.from({ length: template.linesPerPage }, (_, index) => {
    const line = lines[index];
    const cell = new TableCell({
      verticalAlign: VerticalAlign.CENTER,
      margins: { top: 0, bottom: 0, left: 80, right: 80 },
      children: [makeLineParagraph(template, line?.text ?? "")],
    });
    return new TableRow({
      cantSplit: true,
      height: {
        value: Math.round(
          ((A4_HEIGHT_PT - mmToPoints(template.marginsMm.top) - mmToPoints(template.marginsMm.bottom)) /
            template.linesPerPage) * 20,
        ),
        rule: HeightRule.EXACT,
      },
      children: [cell],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [
      mmToTwips(210 - template.marginsMm.left - template.marginsMm.right),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: "A0A0A0" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "A0A0A0" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "A0A0A0" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "A0A0A0" },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: "C8C8C8" },
      insideVertical: { style: BorderStyle.SINGLE, size: 4, color: "A0A0A0" },
    },
    rows,
  });
}

export async function exportDocx(
  report: LayoutReport,
  template: AnswerTemplate,
  outputPath: string,
  allowOverflow = false,
): Promise<{ path: string; pages: number; format: "docx" }> {
  const pages = outputPageCount(report, template, allowOverflow);
  const children: Array<Table | Paragraph> = [];
  for (let page = 1; page <= pages; page += 1) {
    if (page > 1) children.push(new Paragraph({ pageBreakBefore: true, children: [] }));
    children.push(makeDocxPageTable(template, pageLines(report, page), page));
  }

  const document = new Document({
    creator: "police-essay-mcp",
    title: "國考申論答題紙",
    description: "由警察資訊申論答題紙 MCP 產生的固定版面文件",
    sections: [
      {
        properties: {
          page: {
            size: {
              width: mmToTwips(210),
              height: mmToTwips(297),
            },
            margin: {
              top: mmToTwips(template.marginsMm.top),
              right: mmToTwips(template.marginsMm.right),
              bottom: mmToTwips(template.marginsMm.bottom),
              left: mmToTwips(template.marginsMm.left),
            },
          },
        },
        children,
      },
    ],
  });

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, await Packer.toBuffer(document));
  return { path: outputPath, pages, format: "docx" };
}

function findPdfFont(): string | undefined {
  const configured = process.env.ESSAY_MCP_PDF_FONT;
  const candidates = [
    configured,
    "C:\\Windows\\Fonts\\msjhl.ttc",
    "C:\\Windows\\Fonts\\msjh.ttc",
    "C:\\Windows\\Fonts\\mingliu.ttc",
    "C:\\Windows\\Fonts\\simsun.ttc",
    "C:\\Windows\\Fonts\\simsunb.ttf",
    "C:\\Windows\\Fonts\\SimsunExtG.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => {
    return existsSync(candidate);
  });
}

function openPdfFont(fontPath: string): unknown {
  const opened = fontkit.openSync(fontPath);
  if ("fonts" in opened && Array.isArray(opened.fonts)) return opened.fonts[0];
  return opened;
}

function drawPdfPage(
  document: PDFKit.PDFDocument,
  template: AnswerTemplate,
  lines: LayoutLine[],
): void {
  const left = mmToPoints(template.marginsMm.left);
  const right = A4_WIDTH_PT - mmToPoints(template.marginsMm.right);
  const top = mmToPoints(template.marginsMm.top);
  const bottom = A4_HEIGHT_PT - mmToPoints(template.marginsMm.bottom);
  const rowHeight = (bottom - top) / template.linesPerPage;

  document.lineWidth(0.5).strokeColor("#a0a0a0");
  for (let row = 0; row <= template.linesPerPage; row += 1) {
    const y = top + row * rowHeight;
    document.moveTo(left, y).lineTo(right, y).stroke();
  }
  document.moveTo(left, top).lineTo(left, bottom).stroke();
  document.moveTo(right, top).lineTo(right, bottom).stroke();

  document.fontSize(template.fontSizePt).fillColor("#111111");
  for (let row = 0; row < template.linesPerPage; row += 1) {
    const line = lines[row];
    if (!line?.text) continue;
    document.text(line.text, left + 4, top + row * rowHeight + (rowHeight - template.fontSizePt) / 2, {
      width: right - left - 8,
      height: rowHeight,
      lineBreak: false,
    });
  }
}

export async function exportPdf(
  report: LayoutReport,
  template: AnswerTemplate,
  outputPath: string,
  allowOverflow = false,
): Promise<{ path: string; pages: number; format: "pdf"; font: string; fontWarning?: string }> {
  const pages = outputPageCount(report, template, allowOverflow);
  let fontPath = findPdfFont();
  const document = new PDFDocument({ autoFirstPage: false, size: "A4", margin: 0 });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const result = new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(outputPath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    document.pipe(stream);
  });

  if (fontPath) {
    try {
      document.font(openPdfFont(fontPath) as never);
    } catch {
      fontPath = undefined;
      document.font("Helvetica");
    }
  } else {
    document.font("Helvetica");
  }

  for (let page = 1; page <= pages; page += 1) {
    document.addPage({ size: "A4", margin: 0 });
    drawPdfPage(document, template, pageLines(report, page));
  }
  document.end();
  await result;

  return {
    path: outputPath,
    pages,
    format: "pdf",
    font: fontPath ?? "Helvetica",
    ...(fontPath ? {} : { fontWarning: "找不到可用的中文字型，PDF 以 Helvetica 輸出；可設定 ESSAY_MCP_PDF_FONT。" }),
  };
}

export async function exportText(
  report: LayoutReport,
  template: AnswerTemplate,
  outputPath: string,
  allowOverflow = false,
): Promise<{ path: string; pages: number; format: "txt" }> {
  const pages = outputPageCount(report, template, allowOverflow);
  const pageTexts = Array.from({ length: pages }, (_, pageIndex) => {
    const lines = pageLines(report, pageIndex + 1).map((line) => line.text);
    while (lines.length < template.linesPerPage) lines.push("");
    return lines.join("\n");
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${pageTexts.join("\n\f\n")}\n`, "utf8");
  return { path: outputPath, pages, format: "txt" };
}
