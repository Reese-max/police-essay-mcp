import {
  answerParagraphSchema,
  headingStyleSchema,
  paragraphFormatSchema,
  normalizeNewlines,
  type AnswerParagraph,
  type AnswerSection,
  type AnswerTemplate,
  type HeadingStyle,
  type LayoutLine,
  type LayoutOptions,
  type ParagraphFormat,
  type CompressionHint,
  type LayoutReport,
} from "./domain.js";

import { wrapOriginalPaper, originalPaperMeasure, originalPaperAvailableWidth } from "./original-paper.js";

const COMBINING_MARKS = /\p{Mark}/u;
const ZERO_WIDTH_CHARACTERS = /[\u200b-\u200d\ufe0e\ufe0f]/u;

type GraphemeSegmenter = {
  segment(text: string): Iterable<{ segment: string }>;
};

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" },
) => GraphemeSegmenter;

const GraphemeSegmenterClass = (Intl as unknown as {
  Segmenter?: GraphemeSegmenterConstructor;
}).Segmenter;
const graphemeSegmenter = GraphemeSegmenterClass
  ? new GraphemeSegmenterClass(undefined, { granularity: "grapheme" })
  : undefined;

const DEFAULT_PARAGRAPH_FORMAT: ParagraphFormat = {
  firstLineIndent: 0,
  hangingIndent: 0,
  leftIndent: 0,
  rightIndent: 0,
  alignment: "left",
  spaceBeforeLines: 0,
  spaceAfterLines: 0,
  tabSize: 4,
  bold: false,
  italic: false,
};

const DEFAULT_HEADING_STYLE: HeadingStyle = {
  bold: true,
  italic: false,
  numbered: false,
  numbering: "chinese",
  separator: "、",
  firstLineIndent: 0,
  hangingIndent: 0,
  leftIndent: 0,
  rightIndent: 0,
  alignment: "left",
  spaceBeforeLines: 0,
  spaceAfterLines: 0,
  tabSize: 4,
};

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

export function splitGraphemes(text: string): string[] {
  if (graphemeSegmenter) return Array.from(graphemeSegmenter.segment(text), (part) => part.segment);
  return Array.from(text);
}

export function characterDisplayWidth(
  character: string,
  tabSize = 4,
  currentColumn = 0,
): number {
  if (character === "\t") {
    return tabSize - (currentColumn % tabSize);
  }
  if (character === "\r" || character === "\n") return 0;
  if (character.includes("\u200d")) return 2;
  let width = 0;
  for (const codePointText of Array.from(character)) {
    if (COMBINING_MARKS.test(codePointText) || ZERO_WIDTH_CHARACTERS.test(codePointText)) continue;
    const codePoint = codePointText.codePointAt(0) ?? 0;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

export function displayWidth(
  text: string,
  tabSize = 4,
  startColumn = 0,
): number {
  let currentColumn = startColumn;
  for (const character of splitGraphemes(text)) {
    currentColumn += characterDisplayWidth(character, tabSize, currentColumn);
  }
  return currentColumn - startColumn;
}

export function expandTabs(text: string, tabSize = 4, startColumn = 0): string {
  let currentColumn = startColumn;
  let expanded = "";
  for (const character of splitGraphemes(text)) {
    const width = characterDisplayWidth(character, tabSize, currentColumn);
    if (character === "\t") expanded += " ".repeat(width);
    else expanded += character;
    currentColumn += width;
  }
  return expanded;
}

function splitParagraphText(text: string): string[] {
  return normalizeNewlines(text).split("\n");
}

function sectionParagraphs(section: AnswerSection): AnswerParagraph[] {
  if (section.paragraphs?.length) return section.paragraphs.flatMap(paragraph =>
    splitParagraphText(paragraph.text).map(text => ({ ...paragraph, text })));
  return splitParagraphText(section.text).map((text) => ({ text }));
}

function mergeParagraphFormat(
  template: AnswerTemplate,
  section: AnswerSection,
  paragraphFormat: AnswerParagraph["format"],
): ParagraphFormat {
  return paragraphFormatSchema.parse({
    ...DEFAULT_PARAGRAPH_FORMAT,
    ...template.paragraphDefaults,
    ...section.paragraphFormat,
    ...paragraphFormat,
  });
}

function listNumberMarker(text: string): string | undefined {
  const match = /^(?:[壹貳參肆伍陸柒捌玖拾]、|(?:二十|十[一二三四五六七八九]?|[一二三四五六七八九])、|[（(](?:[一二三四五六七八九十]+|[0-9０-９]+)[）)]|[0-9０-９]+[.．、]|[甲乙丙丁戊己庚辛壬癸]、)/u.exec(text);
  return match?.[0];
}

function withAutomaticHangingIndent(
  text: string,
  format: ParagraphFormat,
  template: AnswerTemplate,
  options: LayoutOptions,
  explicitlySet: boolean,
): ParagraphFormat {
  if (!options.autoHangingIndent || explicitlySet) return format;
  const marker = listNumberMarker(text);
  if (!marker) return format;
  const markerWidth = template.paperProfile
    ? Math.round(originalPaperMeasure(template)(marker) / (template.fontSizePt / 2))
    : displayWidth(marker, format.tabSize);
  return { ...format, hangingIndent: format.firstLineIndent + markerWidth };
}

function mergeHeadingStyle(template: AnswerTemplate, section: AnswerSection): HeadingStyle {
  return headingStyleSchema.parse({
    ...DEFAULT_HEADING_STYLE,
    ...template.headingDefaults,
    ...section.headingStyle,
  });
}

function chineseNumber(value: number): string {
  const digits = ["零", "壹", "貳", "參", "肆", "伍", "陸", "柒", "捌", "玖"];
  if (value < 10) return digits[value] ?? String(value);
  if (value < 20) return value === 10 ? "拾" : `拾${digits[value - 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const units = value % 10;
    return `${digits[tens]}拾${units ? digits[units] : ""}`;
  }
  return String(value);
}

function stripHeadingNumber(text: string): string {
  return text.replace(
    /^\s*(?:[壹貳參肆伍陸柒捌玖拾佰仟零一二三四五六七八九十百千]+|\d+|[IVX]+)\s*[、．.。:：\-－)）]+\s*/iu,
    "",
  );
}

export function formatHeading(text: string, style: HeadingStyle, ordinal: number): string {
  if (!style.numbered) return text;
  const body = stripHeadingNumber(text);
  const number = style.numbering === "arabic" ? String(ordinal) : chineseNumber(ordinal);
  return `${number}${style.separator}${body}`;
}

function wrapParagraph(
  paragraph: string,
  format: ParagraphFormat,
  columns: number,
  options: LayoutOptions = {},
): string[] {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  let lineIndex = 0;
  let offset = 0;

  if (format.leftIndent + format.rightIndent + format.firstLineIndent >= columns
    || format.leftIndent + format.rightIndent + format.hangingIndent >= columns) {
    throw new Error("段落縮排總寬度必須小於模板欄寬。請降低 firstLineIndent、hangingIndent、leftIndent 或 rightIndent。");
  }

  for (const character of splitGraphemes(paragraph)) {
    offset += character.length;
    while (true) {
      const lineIndent = format.leftIndent + (lineIndex === 0 ? format.firstLineIndent : format.hangingIndent);
      const available = columns - lineIndent - format.rightIndent;
      const width = characterDisplayWidth(character, format.tabSize, lineIndent + currentWidth);
      if (current.length === 0 && width > available) {
        throw new Error(
          `段落包含寬度 ${width} 欄的字元，但目前可用寬度只有 ${available} 欄。請降低縮排或增加模板欄寬。`,
        );
      }
      if (current.length === 0 || currentWidth + width <= available) {
        current += character;
        currentWidth += width;
        break;
      }
      const trailing = options.wholeLatinWords && /^[A-Za-z0-9]$/.test(character)
        ? current.match(/[A-Za-z0-9]+$/)?.[0] ?? "" : "";
      const nextAvailable = columns - format.leftIndent - format.rightIndent - format.hangingIndent;
      const run = trailing ? trailing + character + (paragraph.slice(offset).match(/^[A-Za-z0-9]*/)?.[0] ?? "") : "";
      const carry = trailing && /\S/u.test(current.slice(0, -trailing.length))
        && displayWidth(run) <= nextAvailable ? trailing : "";
      lines.push(carry ? current.slice(0, -carry.length) : current);
      current = carry;
      currentWidth = carry.length;
      lineIndex += 1;
    }
  }

  if (current.length > 0 || lines.length === 0) lines.push(current);
  if (options.avoidPunctuationOnlyLines) {
    for (let index = 1; index < lines.length; index++) {
      if (!/^[，。！？、；：,.!?;:…」』）】〉》]+$/u.test(lines[index])) continue;
      const previous = lines[index - 1];
      const last = splitGraphemes(previous).at(-1);
      if (!last) continue;
      const word = options.wholeLatinWords ? previous.match(/[A-Za-z0-9]+$/)?.[0] : undefined;
      const carry = word && /\S/u.test(previous.slice(0, -word.length))
        && displayWidth(word + lines[index]) <= columns - format.leftIndent - format.rightIndent - format.hangingIndent ? word : last;
      if (!/\S/u.test(previous.slice(0, -carry.length))
        || displayWidth(carry + lines[index]) > columns - format.leftIndent - format.rightIndent - format.hangingIndent) continue;
      lines[index - 1] = previous.slice(0, -carry.length);
      lines[index] = carry + lines[index];
    }
  }
  return lines;
}

export function lineIndentColumns(line: LayoutLine): number {
  return line.format.leftIndent + (line.isFirstLineOfParagraph ? line.format.firstLineIndent : line.format.hangingIndent);
}

function makeLine(
  lines: LayoutLine[],
  sectionId: string,
  paragraphIndex: number,
  text: string,
  format: ParagraphFormat,
  flags: {
    isHeading?: boolean;
    isSpacer?: boolean;
    isFirstLineOfParagraph?: boolean;
    isLastLineOfParagraph?: boolean;
  } = {},
): void {
  const globalLine = lines.length + 1;
  const indent = format.leftIndent + (flags.isFirstLineOfParagraph ? format.firstLineIndent : format.hangingIndent);
  lines.push({
    globalLine,
    page: 0,
    lineOnPage: 0,
    text,
    sectionId,
    displayWidth: flags.isSpacer ? 0 : indent + displayWidth(text, format.tabSize, indent),
    paragraphIndex,
    isHeading: flags.isHeading ?? false,
    isSpacer: flags.isSpacer ?? false,
    isFirstLineOfParagraph: flags.isFirstLineOfParagraph ?? false,
    isLastLineOfParagraph: flags.isLastLineOfParagraph ?? false,
    format,
  });
}

function addParagraph(
  lines: LayoutLine[],
  sectionId: string,
  paragraphIndex: number,
  text: string,
  format: ParagraphFormat,
  options: { isHeading?: boolean } = {},
  template: AnswerTemplate,
  layoutOptions: LayoutOptions,
): void {
  for (let index = 0; index < format.spaceBeforeLines; index += 1) {
    makeLine(lines, sectionId, paragraphIndex, "", format, { isSpacer: true });
  }

  const wrapped = splitParagraphText(text).flatMap(part => template.paperProfile
    ? wrapOriginalPaper(part, format, template, layoutOptions)
    : wrapParagraph(part, format, template.columns, layoutOptions));
  wrapped.forEach((line, index) => {
    makeLine(lines, sectionId, paragraphIndex, line, format, {
      isHeading: options.isHeading,
      isFirstLineOfParagraph: index === 0,
      isLastLineOfParagraph: index === wrapped.length - 1,
    });
  });

  for (let index = 0; index < format.spaceAfterLines; index += 1) {
    makeLine(lines, sectionId, paragraphIndex, "", format, { isSpacer: true });
  }
}

function compressionHints(
  sections: AnswerSection[],
  sectionLineCounts: Map<string, number>,
  overflowLines: number,
): CompressionHint[] {
  if (overflowLines <= 0) return [];

  const sorted = [...sections]
    .filter((section) => (sectionLineCounts.get(section.id) ?? 0) > 0)
    .sort((left, right) => {
      if (right.compressible !== left.compressible) {
        return right.compressible - left.compressible;
      }
      if (left.priority !== right.priority) return left.priority - right.priority;
      return (sectionLineCounts.get(right.id) ?? 0) - (sectionLineCounts.get(left.id) ?? 0);
    })
    .map((section, index) => ({
      rank: index + 1,
      sectionId: section.id,
      heading: section.heading,
      currentLines: sectionLineCounts.get(section.id) ?? 0,
      priority: section.priority,
      compressible: section.compressible,
      protected: section.required || section.priority >= 4,
      reason:
        section.required || section.priority >= 4
          ? "保留核心採點；若仍超出，僅做語句濃縮。"
          : "可優先濃縮前言、轉折或重複說明。",
    }));
  return sorted;
}

/** Render-only view. Absent options preserve historical answers and explicit formats win. */
function compactPaperSection(template: AnswerTemplate, section: AnswerSection, options: LayoutOptions): AnswerSection & { sourceParagraphIndexes?: number[]; omitEmptySection?: boolean } {
  if (!template.paperProfile || !options.compactPaper) return section;
  const special = (format: object | undefined, defaults: object) => Object.entries(format ?? {})
    .some(([key, value]) => value !== undefined && value !== (defaults as Record<string, unknown>)[key]);
  const bodyDefaults = { ...DEFAULT_PARAGRAPH_FORMAT, ...template.paragraphDefaults };
  const headingDefaults = { ...DEFAULT_HEADING_STYLE, ...template.headingDefaults };
  if (special(section.headingStyle, headingDefaults) || special(section.paragraphFormat, bodyDefaults)
    || section.paragraphs?.some(p => special(p.format, bodyDefaults))) return section;
  const retained = sectionParagraphs(section).map((paragraph, index) => ({ paragraph, sourceIndex: index + 1 }))
    .filter(p => p.paragraph.text.trim() !== '');
  const paragraphs = retained.map(p => ({ ...p.paragraph }));
  // Retain source records for review. Only an entirely blank, unformatted render view disappears.
  // A meaningful heading with missing body remains visible instead of inventing prose.
  if (!paragraphs.length) return section.heading?.trim() ? section : { ...section, omitEmptySection: true };
  let heading = section.heading;
  if (heading?.trim() === '') heading = undefined;
  if (heading && displayWidth(heading) <= template.columns - 2 && !/[\r\n]/u.test(heading)) {
    const prefix = heading + (/[：:]$/u.test(heading) ? '' : '：');
    const spaces = paragraphs[0].text.match(/^\s*/u)![0];
    const firstBody = spaces + (splitGraphemes(paragraphs[0].text.slice(spaces.length))[0] ?? '');
    // Reserve room for a real body grapheme using the same font/Word width as wrapping.
    if (originalPaperMeasure(template)(prefix + firstBody)
      <= originalPaperAvailableWidth(paragraphFormatSchema.parse(bodyDefaults), template, 0)) {
      paragraphs[0].text = prefix + paragraphs[0].text;
      heading = undefined;
    }
  }
  return { ...section, heading, paragraphs, sourceParagraphIndexes: retained.map(p => p.sourceIndex) };
}

export function layoutSections(
  template: AnswerTemplate,
  sections: AnswerSection[],
  options: LayoutOptions = {},
): LayoutReport {
  const lines: LayoutLine[] = [];
  const sectionLineCounts = new Map<string, number>();
  let headingOrdinal = 0;

  for (const storedSection of [...sections].sort((a, b) => a.order - b.order)) {
    const section = compactPaperSection(template, storedSection, options);
    if (section.omitEmptySection) {
      sectionLineCounts.set(section.id, 0);
      continue;
    }
    const sectionStart = lines.length;
    const headingStyle = mergeHeadingStyle(template, section);
    if (section.heading) {
      if (headingStyle.numbered) headingOrdinal += 1;
      addParagraph(
        lines,
        section.id,
        0,
        formatHeading(section.heading, headingStyle, headingOrdinal),
        paragraphFormatSchema.parse(headingStyle),
        { isHeading: true },
        template,
        options,
      );
    }

    sectionParagraphs(section).forEach((paragraph, index) => {
      const format = mergeParagraphFormat(template, section, paragraph.format);
      const explicitHangingIndent = template.paragraphDefaults?.hangingIndent !== undefined
        || section.paragraphFormat?.hangingIndent !== undefined
        || paragraph.format?.hangingIndent !== undefined;
      addParagraph(
        lines,
        section.id,
        section.sourceParagraphIndexes?.[index] ?? index + 1,
        paragraph.text,
        withAutomaticHangingIndent(paragraph.text, format, template, options, explicitHangingIndent),
        {},
        template,
        options,
      );
    });
    sectionLineCounts.set(section.id, lines.length - sectionStart);
  }

  if (options.keepHeadingWithNext) {
    for (let index = 0; index < lines.length; index += 1) {
      const heading = lines[index];
      if (!heading.isHeading || (index > 0 && lines[index - 1].isHeading && lines[index - 1].sectionId === heading.sectionId)) continue;
      let bodyIndex = index + 1;
      while (bodyIndex < lines.length && lines[bodyIndex].sectionId === heading.sectionId
        && (lines[bodyIndex].isHeading || lines[bodyIndex].isSpacer)) {
        bodyIndex += 1;
      }
      if (bodyIndex === lines.length || lines[bodyIndex].sectionId !== heading.sectionId) continue;
      const offset = index % template.linesPerPage;
      const blockLines = bodyIndex - index + 1;
      if (offset === 0 || blockLines > template.linesPerPage
        || Math.floor(index / template.linesPerPage) === Math.floor(bodyIndex / template.linesPerPage)) continue;
      const count = template.linesPerPage - offset;
      const padding = Array.from({ length: count }, () => ({ ...heading, text: "", displayWidth: 0,
        isHeading: false, isSpacer: true, isPadding: true, isFirstLineOfParagraph: false, isLastLineOfParagraph: false }));
      lines.splice(index, 0, ...padding);
      sectionLineCounts.set(heading.sectionId, (sectionLineCounts.get(heading.sectionId) ?? 0) + count);
      index = bodyIndex + count;
    }
  }

  lines.forEach((line, index) => {
    const globalLine = index + 1;
    line.globalLine = globalLine;
    line.page = Math.ceil(globalLine / template.linesPerPage);
    line.lineOnPage = ((globalLine - 1) % template.linesPerPage) + 1;
  });

  const capacity = template.pages * template.linesPerPage;
  const totalLines = lines.length;
  const overflowLines = Math.max(0, totalLines - capacity);
  const pagesUsed = Math.max(1, Math.ceil(totalLines / template.linesPerPage));
  const pageLineCounts = new Map<number, number>();
  for (const line of lines) pageLineCounts.set(line.page, (pageLineCounts.get(line.page) ?? 0) + 1);
  const pageUsage = Array.from({ length: Math.max(template.pages, pagesUsed) }, (_, index) => {
    const page = index + 1;
    return {
      page,
      linesUsed: pageLineCounts.get(page) ?? 0,
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

function addJustificationSpaces(text: string, extra: number, distributed: boolean): string {
  if (extra <= 0) return text;
  const characters = splitGraphemes(text);
  const gapIndexes = distributed
    ? characters.slice(0, -1).map((_, index) => index)
    : characters.reduce<number[]>((indexes, character, index) => {
        if (character === " ") indexes.push(index);
        return indexes;
      }, []);
  if (gapIndexes.length === 0) return text;

  const base = Math.floor(extra / gapIndexes.length);
  let remainder = extra % gapIndexes.length;
  const gaps = new Map(gapIndexes.map((index) => {
    const amount = base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    return [index, amount];
  }));
  return characters.map((character, index) => `${character}${gaps.has(index) ? " ".repeat(gaps.get(index) ?? 0) : ""}`).join("");
}

export function renderTextLine(line: LayoutLine, template: AnswerTemplate): string {
  if (line.isSpacer) return "";
  const indent = lineIndentColumns(line);
  const available = Math.max(0, template.columns - indent - line.format.rightIndent);
  const expanded = expandTabs(line.text, line.format.tabSize, indent);
  const contentWidth = displayWidth(expanded, line.format.tabSize, indent);
  const extra = Math.max(0, available - contentWidth);
  let content = expanded;

  if (line.format.alignment === "distributed" || (line.format.alignment === "justify" && !line.isLastLineOfParagraph)) {
    content = addJustificationSpaces(content, extra, line.format.alignment === "distributed");
  } else if (line.format.alignment === "right") {
    content = `${" ".repeat(extra)}${content}`;
  }

  return `${" ".repeat(indent)}${content}`;
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

// Runtime validation remains at the domain boundary; these imports also make
// the intended formatting schemas explicit for future layout extensions.
void answerParagraphSchema;


