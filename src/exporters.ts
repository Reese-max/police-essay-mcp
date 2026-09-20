import { promises as fs, createWriteStream, existsSync } from "node:fs";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeightRule,
  LineRuleType,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  VerticalAlign,
  WidthType,
} from "docx";
import PDFDocument from "pdfkit";
import * as fontkit from "fontkit";
import type { AnswerTemplate, LayoutLine, LayoutReport } from "./domain.js";
import { expandTabs, lineIndentColumns, renderTextLine } from "./layout.js";
import {
  gridMetrics,
  mmToTwips,
  pointsToTwips,
} from "./metrics.js";

function pageLines(report: LayoutReport, page: number): LayoutLine[] {
  return report.lines.filter((line) => line.page === page);
}

function outputPageCount(report: LayoutReport, template: AnswerTemplate, allowOverflow: boolean): number {
  if (!report.fits && !allowOverflow && template.overflowPolicy !== "report") {
    throw new Error(
      `答案超出模板容量 ${report.overflowLines} 行；模板策略為 ${template.overflowPolicy}，請先修改答案或以 allowOverflow=true 明確輸出溢出版。`,
    );
  }
  return report.fits && !allowOverflow ? template.pages : Math.max(template.pages, report.pagesUsed);
}

function docxAlignment(alignment: LayoutLine["format"]["alignment"]): (typeof AlignmentType)[keyof typeof AlignmentType] {
  switch (alignment) {
    case "right":
      return AlignmentType.RIGHT;
    case "justify":
      return AlignmentType.JUSTIFIED;
    case "distributed":
      return AlignmentType.DISTRIBUTE;
    default:
      return AlignmentType.LEFT;
  }
}

function gridColumnTwips(template: AnswerTemplate): number {
  return pointsToTwips(gridMetrics(template).columnWidthPt);
}

function makeTabStops(template: AnswerTemplate, tabSize: number): Array<{ type: (typeof TabStopType)[keyof typeof TabStopType]; position: number }> {
  const columnTwips = gridColumnTwips(template);
  const stops: Array<{ type: (typeof TabStopType)[keyof typeof TabStopType]; position: number }> = [];
  for (let column = tabSize; column <= template.columns; column += tabSize) {
    stops.push({ type: TabStopType.LEFT, position: column * columnTwips });
  }
  return stops;
}

function makeLineParagraph(template: AnswerTemplate, line?: LayoutLine): Paragraph {
  const format = line?.format ?? {
    firstLineIndent: 0,
    leftIndent: 0,
    rightIndent: 0,
    alignment: "left" as const,
    spaceBeforeLines: 0,
    spaceAfterLines: 0,
    tabSize: 4,
    bold: false,
    italic: false,
  };
  return new Paragraph({
    alignment: docxAlignment(format.alignment),
    indent: {
      left: gridColumnTwips(template) * format.leftIndent,
      right: gridColumnTwips(template) * format.rightIndent,
      firstLine: line?.isFirstLineOfParagraph ? gridColumnTwips(template) * format.firstLineIndent : 0,
    },
    tabStops: makeTabStops(template, format.tabSize),
    spacing: {
      before: 0,
      after: 0,
      line: Math.round(template.lineHeightPt * 20),
      lineRule: LineRuleType.EXACT,
    },
    children: [
      new TextRun({
        text: line?.text ?? "",
        size: Math.round(template.fontSizePt * 2),
        bold: format.bold,
        italics: format.italic,
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
      children: [makeLineParagraph(template, line)],
    });
    return new TableRow({
      cantSplit: true,
      height: {
        value: pointsToTwips(gridMetrics(template).rowHeightPt),
        rule: HeightRule.EXACT,
      },
      children: [cell],
    });
  });

  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
      columnWidths: [pointsToTwips(gridMetrics(template).contentWidthPt)],
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

function findPdfFont(bold = false): string | undefined {
  const configured = bold ? process.env.ESSAY_MCP_PDF_BOLD_FONT : process.env.ESSAY_MCP_PDF_FONT;
  const candidates = bold
    ? [
        configured,
        "C:\\Windows\\Fonts\\msjhbd.ttc",
        "C:\\Windows\\Fonts\\mingliub.ttc",
        "C:\\Windows\\Fonts\\simsunb.ttf",
        "C:\\Windows\\Fonts\\SimsunExtB.ttf",
      ]
    : [
        configured,
        "C:\\Windows\\Fonts\\msjhl.ttc",
        "C:\\Windows\\Fonts\\msjh.ttc",
        "C:\\Windows\\Fonts\\mingliu.ttc",
        "C:\\Windows\\Fonts\\simsun.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
      ];
  return candidates.filter((candidate): candidate is string => Boolean(candidate)).find((candidate) => existsSync(candidate));
}

function findPdfItalicFont(): string | undefined {
  const configured = process.env.ESSAY_MCP_PDF_ITALIC_FONT;
  return configured && existsSync(configured) ? configured : undefined;
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
  regularFont: unknown,
  boldFont: unknown,
  italicFont: unknown,
): void {
  const metrics = gridMetrics(template);
  const left = metrics.leftPt;
  const right = left + metrics.contentWidthPt;
  const top = metrics.topPt;
  const bottom = metrics.bottomPt;
  const rowHeight = metrics.rowHeightPt;

  document.lineWidth(0.5).strokeColor("#a0a0a0");
  for (let row = 0; row <= template.linesPerPage; row += 1) {
    const y = top + row * rowHeight;
    document.moveTo(left, y).lineTo(right, y).stroke();
  }
  document.moveTo(left, top).lineTo(left, bottom).stroke();
  document.moveTo(right, top).lineTo(right, bottom).stroke();

  const gridWidth = metrics.columnWidthPt;
  for (let row = 0; row < template.linesPerPage; row += 1) {
    const line = lines[row];
    if (!line?.text || line.isSpacer) continue;
    if (line.format.italic && italicFont) document.font(italicFont as never);
    else if (line.format.bold && boldFont) document.font(boldFont as never);
    else if (regularFont) document.font(regularFont as never);
    else document.font("Helvetica");
    document.fontSize(template.fontSizePt).fillColor("#111111");
    const indent = lineIndentColumns(line);
    const x = left + gridWidth * indent + 4;
    const width = Math.max(1, gridWidth * (template.columns - indent - line.format.rightIndent) - 8);
    const alignment = line.format.alignment === "distributed" ? "justify" : line.format.alignment;
    const text = expandTabs(line.text, line.format.tabSize, indent);
    document.text(text, x, top + row * rowHeight + (rowHeight - template.fontSizePt) / 2, {
      width,
      height: rowHeight,
      lineBreak: false,
      align: alignment === "justify" ? "justify" : alignment,
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
  let boldFontPath = findPdfFont(true);
  let italicFontPath = findPdfItalicFont();
  let regularFont: unknown;
  let boldFont: unknown;
  let italicFont: unknown;
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
      regularFont = openPdfFont(fontPath);
      document.font(regularFont as never);
    } catch {
      fontPath = undefined;
      document.font("Helvetica");
    }
  } else {
    document.font("Helvetica");
  }

  if (boldFontPath) {
    try {
      boldFont = openPdfFont(boldFontPath);
    } catch {
      boldFontPath = undefined;
    }
  }

  if (italicFontPath) {
    try {
      italicFont = openPdfFont(italicFontPath);
    } catch {
      italicFontPath = undefined;
    }
  }

  for (let page = 1; page <= pages; page += 1) {
    document.addPage({ size: "A4", margin: 0 });
    drawPdfPage(document, template, pageLines(report, page), regularFont, boldFont, italicFont);
  }
  document.end();
  await result;

  const warnings: string[] = [];
  if (!fontPath) warnings.push("找不到可用的中文字型，PDF 以 Helvetica 輸出；可設定 ESSAY_MCP_PDF_FONT。");
  if (fontPath && !boldFontPath) warnings.push("找不到粗體中文字型；粗體段落將以一般中文字型輸出，可設定 ESSAY_MCP_PDF_BOLD_FONT。");
  if (fontPath && report.lines.some((line) => line.format.italic) && !italicFontPath) {
    warnings.push("答案含斜體但找不到斜體中文字型；可設定 ESSAY_MCP_PDF_ITALIC_FONT。");
  }
  return {
    path: outputPath,
    pages,
    format: "pdf",
    font: fontPath ?? "Helvetica",
    ...(warnings.length ? { fontWarning: warnings.join(" ") } : {}),
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
    const lines = pageLines(report, pageIndex + 1).map((line) => renderTextLine(line, template));
    while (lines.length < template.linesPerPage) lines.push("");
    return lines.join("\n");
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${pageTexts.join("\n\f\n")}\n`, "utf8");
  return { path: outputPath, pages, format: "txt" };
}

