import { replaceSectionContent, type AnswerParagraph, type AnswerSection } from "./domain.js";

const FORMAL_DIGITS = ["", "壹", "貳", "參", "肆", "伍", "陸", "柒", "捌", "玖"];
const CHINESE_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

/** 1 → 一, 10 → 十, 12 → 十二, 20 → 二十 (and the formal 壹/拾 forms); up to 99. */
function spelled(value: number, digits: string[], ten: string): string {
  if (value < 10) return digits[value];
  const tens = Math.floor(value / 10);
  return `${tens === 1 ? "" : digits[tens]}${ten}${digits[value % 10]}`;
}

function arabic(value: number, original: string): string {
  const text = String(value);
  // Keep full-width digits when the marker used them.
  return /[０-９]/.test(original) ? text.replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0)) : text;
}

/** Item markers from the highest level to the lowest, as in Taiwanese exam answers: 壹、 一、 （一） 1. （1） */
const LEVELS: Array<{ pattern: RegExp; number: (value: number, original: string) => string }> = [
  { pattern: /^(\s*)([壹貳參肆伍陸柒捌玖拾]+)(、)/u, number: (value) => spelled(value, FORMAL_DIGITS, "拾") },
  { pattern: /^(\s*)([一二三四五六七八九十]+)(、)/u, number: (value) => spelled(value, CHINESE_DIGITS, "十") },
  { pattern: /^(\s*[（(])([一二三四五六七八九十]+)([）)])/u, number: (value) => spelled(value, CHINESE_DIGITS, "十") },
  { pattern: /^(\s*)([0-9０-９]{1,2})([.．、](?![0-9０-９]))/u, number: arabic },
  { pattern: /^(\s*[（(])([0-9０-９]{1,2})([）)])/u, number: arabic },
];

/** Numbers one sequence of texts: each level counts up and restarts under a higher-level item. */
function renumberSequence(texts: string[]): { texts: string[]; changed: number } {
  const counters = LEVELS.map(() => 0);
  let changed = 0;
  const result = texts.map((text) => {
    const level = LEVELS.findIndex(({ pattern }) => pattern.test(text));
    if (level < 0) return text;
    counters[level] += 1;
    counters.fill(0, level + 1);
    if (counters[level] > 99) return text;
    const [, lead, original, tail] = LEVELS[level].pattern.exec(text)!;
    const renumbered = `${lead}${LEVELS[level].number(counters[level], original)}${tail}${text.slice(lead.length + original.length + tail.length)}`;
    if (renumbered !== text) changed += 1;
    return renumbered;
  });
  return { texts: result, changed };
}

function paragraphsOf(section: AnswerSection): AnswerParagraph[] {
  return section.paragraphs?.length
    ? section.paragraphs
    : section.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((text): AnswerParagraph => ({ text }));
}

/**
 * Rewrites the item numbers written at the start of headings and paragraphs so each list counts 1, 2, 3…
 * Headings form one list across the answer; the paragraphs of each section form their own list.
 * With sectionId only that section's paragraphs are renumbered. Text after the marker and all formats are kept.
 */
export function renumberItems(sections: AnswerSection[], sectionId?: string): { sections: AnswerSection[]; renumbered: number } {
  if (sectionId && !sections.some((section) => section.id === sectionId)) throw new Error(`找不到 sectionId ${sectionId}。`);
  const headings = sectionId ? undefined : renumberSequence(sections.map((section) => section.heading ?? ""));
  let renumbered = headings?.changed ?? 0;
  const updated = sections.map((section, index) => {
    const heading = headings ? headings.texts[index] || undefined : section.heading;
    const paragraphs = paragraphsOf(section);
    const body = !sectionId || section.id === sectionId ? renumberSequence(paragraphs.map((paragraph) => paragraph.text)) : undefined;
    renumbered += body?.changed ?? 0;
    if (heading === section.heading && !body?.changed) return section;
    return replaceSectionContent(section, {
      heading,
      paragraphs: paragraphs.map((paragraph, at) => ({ text: body?.texts[at] ?? paragraph.text, format: paragraph.format })),
    });
  });
  if (renumbered === 0) throw new Error("編號已經是連續的，沒有需要重新編號的項目。");
  return { sections: updated, renumbered };
}
