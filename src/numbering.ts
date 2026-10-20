import { replaceSectionContent, type AnswerParagraph, type AnswerSection } from "./domain.js";

const FORMAL_DIGITS = ["", "壹", "貳", "參", "肆", "伍", "陸", "柒", "捌", "玖"];
const CHINESE_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
/** Chinese-numeral markers are spelled up to 99; arabic ones have no limit. */
const MAX_SPELLED = 99;

/** 1 → 一, 10 → 十, 12 → 十二, 20 → 二十 (and the formal 壹/拾 forms). */
function spelled(value: number, digits: string[], ten: string): string | undefined {
  if (value > MAX_SPELLED) return undefined;
  if (value < 10) return digits[value];
  const tens = Math.floor(value / 10);
  return `${tens === 1 ? "" : digits[tens]}${ten}${digits[value % 10]}`;
}

function arabic(value: number, original: string): string {
  const text = String(value);
  // Keep full-width digits when the marker used them.
  return /[０-９]/.test(original) ? text.replace(/[0-9]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) + 0xfee0)) : text;
}

/**
 * Item markers from the highest level to the lowest, as in Taiwanese exam answers: 壹、 一、 （一） 1. （1）
 * A numeral and 、 directly followed by another numeral ("二、三級機關", "1、2 年") is a list of numbers in the
 * prose, not a marker; `ambiguous` catches the numeral-led cases so they are left alone and reported.
 */
const LEVELS: Array<{ pattern: RegExp; ambiguous?: RegExp; number: (value: number, original: string) => string | undefined }> = [
  { pattern: /^(\s*)([壹貳參肆伍陸柒捌玖拾]+)(、)/u, ambiguous: /^\s*[壹貳參肆伍陸柒捌玖拾]+、[壹貳參肆伍陸柒捌玖拾一二三四五六七八九十]/u,
    number: (value) => spelled(value, FORMAL_DIGITS, "拾") },
  { pattern: /^(\s*)([一二三四五六七八九十]+)(、)/u, ambiguous: /^\s*[一二三四五六七八九十]+、[一二三四五六七八九十壹貳參肆伍陸柒捌玖拾]/u,
    number: (value) => spelled(value, CHINESE_DIGITS, "十") },
  { pattern: /^(\s*[（(])([一二三四五六七八九十]+)([）)])/u, number: (value) => spelled(value, CHINESE_DIGITS, "十") },
  { pattern: /^(\s*)([0-9０-９]{1,4})([.．、](?![0-9０-９]))/u, number: arabic },
  { pattern: /^(\s*[（(])([0-9０-９]{1,4})([）)])/u, number: arabic },
];

/** Numbers one sequence of texts: each level counts up and restarts under a higher-level item. */
function renumberSequence(texts: string[], where: (index: number) => string): { texts: string[]; changed: number; skipped: string[] } {
  const counters = LEVELS.map(() => 0);
  let changed = 0;
  const skipped: string[] = [];
  const result = texts.map((text, index) => {
    const level = LEVELS.findIndex(({ pattern }) => pattern.test(text));
    if (level < 0) return text;
    if (LEVELS[level].ambiguous?.test(text)) {
      skipped.push(`${where(index)}「${Array.from(text.trim()).slice(0, 12).join("")}…」`);
      return text;
    }
    counters[level] += 1;
    counters.fill(0, level + 1);
    const [, lead, original, tail] = LEVELS[level].pattern.exec(text)!;
    const number = LEVELS[level].number(counters[level], original);
    if (number === undefined) throw new Error(`${where(index)}是同一層的第 ${counters[level]} 項，超過中文數字編號的上限 ${MAX_SPELLED}；沒有修改任何內容。`);
    const renumbered = `${lead}${number}${tail}${text.slice(lead.length + original.length + tail.length)}`;
    if (renumbered !== text) changed += 1;
    return renumbered;
  });
  return { texts: result, changed, skipped };
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
 * `skipped` lists openings that look like a marker but read as numbers in the prose; they are neither counted nor changed.
 */
export function renumberItems(sections: AnswerSection[], sectionId?: string): { sections: AnswerSection[]; renumbered: number; skipped: string[] } {
  if (sectionId && !sections.some((section) => section.id === sectionId)) throw new Error(`找不到 sectionId ${sectionId}。`);
  const label = (section: AnswerSection) => `「${section.heading || section.id}」`;
  const headings = sectionId ? undefined
    : renumberSequence(sections.map((section) => section.heading ?? ""), (index) => `${label(sections[index])}標題`);
  let renumbered = headings?.changed ?? 0;
  const skipped = [...headings?.skipped ?? []];
  const updated = sections.map((section, index) => {
    const heading = headings ? headings.texts[index] || undefined : section.heading;
    const paragraphs = paragraphsOf(section);
    const body = !sectionId || section.id === sectionId
      ? renumberSequence(paragraphs.map((paragraph) => paragraph.text), (at) => `${label(section)}第${at + 1}段`) : undefined;
    renumbered += body?.changed ?? 0;
    skipped.push(...body?.skipped ?? []);
    if (heading === section.heading && !body?.changed) return section;
    return replaceSectionContent(section, {
      heading,
      paragraphs: paragraphs.map((paragraph, at) => ({ text: body?.texts[at] ?? paragraph.text, format: paragraph.format })),
    });
  });
  if (renumbered === 0) {
    throw new Error("編號已經是連續的，沒有需要重新編號的項目。" + (skipped.length ? `未計入（開頭的數字像是內文）：${skipped.join("、")}。` : ""));
  }
  return { sections: updated, renumbered, skipped };
}
