import type {
  AnswerSection,
  AnswerTemplate,
  CompressionHint,
  LayoutLine,
  LayoutReport,
} from "./domain.js";

const COMBINING_MARKS = /\p{Mark}/u;

function isWideCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2329 && codePoint <= 0x232a) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
    (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
    (codePoint >= 0xff00 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  );
}

export function characterDisplayWidth(character: string): number {
  if (character === "\t") return 4;
  if (character === "\r" || character === "\n") return 0;
  if (COMBINING_MARKS.test(character)) return 0;
  const codePoint = character.codePointAt(0) ?? 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

export function displayWidth(text: string): number {
  return Array.from(text).reduce(
    (width, character) => width + characterDisplayWidth(character),
    0,
  );
}

function wrapParagraph(paragraph: string, columns: number): string[] {
  if (paragraph.length === 0) return [""];

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const character of Array.from(paragraph)) {
    const width = characterDisplayWidth(character);
    if (current.length > 0 && currentWidth + width > columns) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += character;
    currentWidth += width;
  }

  if (current.length > 0 || lines.length === 0) lines.push(current);
  return lines;
}

function sectionLines(section: AnswerSection, columns: number): string[] {
  const source = section.heading
    ? `${section.heading}\n${section.text}`
    : section.text;
  return source
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")
    .flatMap((paragraph) => wrapParagraph(paragraph, columns));
}

function compressionHints(
  sections: AnswerSection[],
  sectionLineCounts: Map<string, number>,
  overflowLines: number,
): CompressionHint[] {
  if (overflowLines <= 0) return [];

  return sections
    .filter((section) => (sectionLineCounts.get(section.id) ?? 0) > 0)
    .sort((left, right) => {
      if (right.compressible !== left.compressible) {
        return right.compressible - left.compressible;
      }
      if (left.priority !== right.priority) return left.priority - right.priority;
      return (sectionLineCounts.get(right.id) ?? 0) - (sectionLineCounts.get(left.id) ?? 0);
    })
    .map((section) => ({
      sectionId: section.id,
      heading: section.heading,
      currentLines: sectionLineCounts.get(section.id) ?? 0,
      priority: section.priority,
      compressible: section.compressible,
      reason:
        section.required || section.priority >= 4
          ? "保留核心採點；若仍超出，僅做語句濃縮。"
          : "可優先濃縮前言、轉折或重複說明。",
    }));
}

export function layoutSections(
  template: AnswerTemplate,
  sections: AnswerSection[],
): LayoutReport {
  const lines: LayoutLine[] = [];
  const sectionLineCounts = new Map<string, number>();

  for (const section of [...sections].sort((a, b) => a.order - b.order)) {
    const wrapped = sectionLines(section, template.columns);
    sectionLineCounts.set(section.id, wrapped.length);
    for (const text of wrapped) {
      const globalLine = lines.length + 1;
      const page = Math.ceil(globalLine / template.linesPerPage);
      const lineOnPage = ((globalLine - 1) % template.linesPerPage) + 1;
      lines.push({
        globalLine,
        page,
        lineOnPage,
        text,
        sectionId: section.id,
        displayWidth: displayWidth(text),
      });
    }
  }

  const capacity = template.pages * template.linesPerPage;
  const totalLines = lines.length;
  const overflowLines = Math.max(0, totalLines - capacity);
  const pagesUsed = Math.max(1, Math.ceil(totalLines / template.linesPerPage));
  const pageUsage = Array.from({ length: Math.max(template.pages, pagesUsed) }, (_, index) => {
    const page = index + 1;
    return {
      page,
      linesUsed: lines.filter((line) => line.page === page).length,
      capacity: template.linesPerPage,
    };
  });

  return {
    templateId: template.id,
    pagesConfigured: template.pages,
    linesPerPage: template.linesPerPage,
    columns: template.columns,
    capacity,
    totalLines,
    pagesUsed,
    overflowLines,
    remainingLines: Math.max(0, capacity - totalLines),
    fits: overflowLines === 0,
    status: overflowLines === 0 ? "ok" : "overflow",
    pageUsage,
    lines,
    compressionHints: compressionHints(sections, sectionLineCounts, overflowLines),
  };
}

export function summarizeLayout(report: LayoutReport): string {
  const pages = report.pageUsage
    .slice(0, report.pagesConfigured)
    .map((page) => `第${page.page}頁 ${page.linesUsed}/${page.capacity}行`)
    .join("；");
  if (report.fits) {
    return `${pages}；總計 ${report.totalLines}/${report.capacity} 行，尚餘 ${report.remainingLines} 行，狀態：OK。`;
  }
  return `${pages}；總計 ${report.totalLines}/${report.capacity} 行，超出 ${report.overflowLines} 行，狀態：超出。`;
}
