import type { AnswerDocument, AnswerTemplate, LayoutLine, LayoutReport } from "./domain.js";
import { lineIndentColumns, displayWidth } from "./layout.js";
import { layoutWarnings } from "./planning.js";
import { originalPaperMeasure } from "./original-paper.js";

export interface LayoutQuality {
  fill: number;
  totalLines: number;
  capacity: number;
  flattenedStructure: boolean;
  embeddedHeadingParagraphs: number;
  misalignedContinuations: number;
  hierarchyIssues: number;
  indentInconsistency: number;
  shortTailLines: number;
  punctuationOnlyLines: number;
}

interface Numbering {
  level: number;
  family: string;
  value: number;
  prefix: string;
}

interface Paragraph {
  sectionId: string;
  paragraphIndex: number;
  isHeading: boolean;
  lines: LayoutLine[];
  text: string;
}

const CHINESE_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 貳: 2, 參: 3, 肆: 4, 伍: 5, 陸: 6, 柒: 7, 捌: 8, 玖: 9,
};

function parseChineseNumber(value: string): number | undefined {
  const tens = value.split(/[十拾]/u);
  if (tens.length > 2) return undefined;
  const digit = (text: string, empty: number) => text === "" ? empty : text.length === 1 ? CHINESE_DIGITS[text] : undefined;
  if (tens.length === 1) return digit(value, NaN);
  const high = digit(tens[0], 1), low = digit(tens[1], 0);
  return high === undefined || low === undefined ? undefined : high * 10 + low;
}

function asciiDigits(value: string): string {
  return value.replace(/[０-９]/gu, digit => String(digit.charCodeAt(0) - 0xff10));
}

function classifyNumbering(text: string): Numbering | undefined {
  const value = text.trimStart();
  let match = value.match(/^([壹貳參肆伍陸柒捌玖拾]+)、/u);
  if (match) {
    const number = parseChineseNumber(match[1]);
    if (number !== undefined) return { level: 1, family: "financial-chinese", value: number, prefix: match[0] };
  }

  match = value.match(/^([一二三四五六七八九十]+)、/u);
  if (match) {
    const number = parseChineseNumber(match[1]);
    if (number !== undefined) return { level: 2, family: "chinese", value: number, prefix: match[0] };
  }

  match = value.match(/^[（(]([壹貳參肆伍陸柒捌玖拾一二三四五六七八九十]+)[）)]/u);
  if (match) {
    const number = parseChineseNumber(match[1]);
    if (number !== undefined) return { level: 3, family: "parenthesized-chinese", value: number, prefix: match[0] };
  }

  match = value.match(/^([0-9０-９]+)([.．、])/u);
  if (match) {
    const separator = match[2] === "、" ? "comma" : "period";
    return {
      level: 4,
      family: `arabic-${separator}`,
      value: Number(asciiDigits(match[1])),
      prefix: match[0],
    };
  }

  match = value.match(/^[（(]([0-9０-９]+)[）)]/u);
  if (match) {
    return { level: 5, family: "parenthesized-arabic", value: Number(asciiDigits(match[1])), prefix: match[0] };
  }

  match = value.match(/^([甲乙丙丁戊己庚辛壬癸])、/u);
  if (match) return { level: 6, family: "heavenly-stem", value: "甲乙丙丁戊己庚辛壬癸".indexOf(match[1]) + 1, prefix: match[0] };
  return undefined;
}

function collectParagraphs(report: LayoutReport): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const line of report.lines) {
    if (line.isSpacer || line.isPadding) continue;
    const previous = paragraphs.at(-1);
    if (previous && previous.sectionId === line.sectionId
      && previous.paragraphIndex === line.paragraphIndex && previous.isHeading === line.isHeading) {
      previous.lines.push(line);
      previous.text += line.text;
    } else {
      paragraphs.push({
        sectionId: line.sectionId,
        paragraphIndex: line.paragraphIndex,
        isHeading: line.isHeading,
        lines: [line],
        text: line.text,
      });
    }
  }
  return paragraphs;
}

function countHierarchyIssues(items: Array<{ numbering: Numbering; order: number }>): number {
  let issues = 0;
  const stack: Array<{ level: number; key: number }> = [];
  const siblings = new Map<string, { family: string; value: number }>();
  let previousLevel: number | undefined;

  for (const item of items) {
    const { level, family, value } = item.numbering;
    if (previousLevel !== undefined && level > previousLevel + 1) issues += 1;
    previousLevel = level;
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    const parentKey = stack.at(-1)?.key ?? 0;
    const siblingKey = `${parentKey}:${level}`;
    const previous = siblings.get(siblingKey);
    if (previous) {
      if (previous.family !== family) issues += 1;
      if (value !== previous.value + 1) issues += 1;
    }
    siblings.set(siblingKey, { family, value });
    stack.push({ level, key: item.order + 1 });
  }
  return issues;
}

/** Scores observable layout output without changing the answer or its layout report. */
export function scoreLayout(
  template: AnswerTemplate,
  answer: AnswerDocument,
  report: LayoutReport,
): LayoutQuality {
  const paragraphs = collectParagraphs(report);
  const measure = template.paperProfile
    ? (() => {
        const paperMeasure = originalPaperMeasure(template);
        return (text: string) => paperMeasure(text) / (template.fontSizePt / 2);
      })()
    : (text: string) => displayWidth(text);
  const bodyParagraphs = paragraphs.filter(paragraph => !paragraph.isHeading);
  const numberedParagraphs = bodyParagraphs.filter(paragraph => classifyNumbering(paragraph.lines[0]?.text ?? ""));

  const embeddedHeadings = bodyParagraphs.filter(paragraph =>
    classifyNumbering(paragraph.lines[0]?.text ?? "") && !/[。！？][」』）)]*\s*$/u.test(paragraph.text));

  let misalignedContinuations = 0;
  for (const paragraph of numberedParagraphs) {
    const numbering = classifyNumbering(paragraph.lines[0]?.text ?? "");
    if (!numbering) continue;
    const requiredStart = lineIndentColumns(paragraph.lines[0]) + Math.round(measure(numbering.prefix)); // columns are whole display units
    for (const line of paragraph.lines.slice(1)) {
      if (lineIndentColumns(line) < requiredStart) misalignedContinuations += 1;
    }
  }

  const hierarchyItems = paragraphs.flatMap((paragraph, index) => {
    if (!paragraph.isHeading && /[。！？][」』）)]*\s*$/u.test(paragraph.text)) return [];
    const numbering = classifyNumbering(paragraph.lines[0]?.text ?? "");
    return numbering ? [{ numbering, order: index }] : [];
  });

  const bodyIndents = new Set(bodyParagraphs
    .filter(paragraph => paragraph.text.trim() && !classifyNumbering(paragraph.lines[0]?.text ?? ""))
    .map(paragraph => paragraph.lines[0]?.format.firstLineIndent ?? 0));

  let shortTailLines = 0;
  for (const paragraph of bodyParagraphs) {
    const tail = paragraph.lines.at(-1)?.text ?? "";
    if (paragraph.lines.length > 1 && tail.trim() && measure(tail) <= 4) shortTailLines += 1;
  }

  const capacity = report.capacity;
  const fill = capacity > 0 ? Math.round((report.totalLines / capacity) * 100) / 100 : 0;
  return {
    fill,
    totalLines: report.totalLines,
    capacity,
    flattenedStructure: report.totalLines >= 20 && answer.sections.length <= 1 && numberedParagraphs.length >= 2,
    embeddedHeadingParagraphs: embeddedHeadings.length,
    misalignedContinuations,
    hierarchyIssues: countHierarchyIssues(hierarchyItems),
    indentInconsistency: Math.max(0, bodyIndents.size - 1),
    shortTailLines,
    punctuationOnlyLines: layoutWarnings(report, template).filter(warning => warning.code === "PUNCTUATION_ONLY_LINE").length,
  };
}
