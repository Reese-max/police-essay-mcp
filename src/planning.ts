import type { AnswerDocument, AnswerSection, AnswerTemplate, LayoutLine, LayoutReport } from "./domain.js";
import { displayWidth } from "./layout.js";
import { originalPaperAvailableWidth, originalPaperMeasure } from "./original-paper.js";

export interface SectionLines {
  sectionId: string;
  heading?: string;
  /** Rendered lines, the heading and spacing included. */
  lines: number;
  targetLines?: number;
  /** lines − targetLines: positive means over the target. */
  overTarget?: number;
}

const name = (section: Pick<AnswerSection, "id" | "heading">) => `「${section.heading || section.id}」`;

/** Lines each section uses against its target, and what to do to fit or fill the sheet. */
export function planLines(answer: AnswerDocument, layout: LayoutReport): { sections: SectionLines[]; notes: string[] } {
  const counts = new Map<string, number>();
  for (const line of layout.lines) counts.set(line.sectionId, (counts.get(line.sectionId) ?? 0) + 1);
  const targets = answer.lineTargets ?? {};
  const sections = [...answer.sections].sort((a, b) => a.order - b.order).map((section): SectionLines => {
    const lines = counts.get(section.id) ?? 0;
    // Own keys only: a section id such as "constructor" must not read Object.prototype.
    const targetLines = Object.hasOwn(targets, section.id) ? targets[section.id] : undefined;
    return { sectionId: section.id, heading: section.heading, lines,
      ...(targetLines === undefined ? {} : { targetLines, overTarget: lines - targetLines }) };
  });
  const notes: string[] = [];
  const targeted = sections.filter((section) => section.targetLines !== undefined);
  // Sections without a target count with the lines they use now.
  const plannedTotal = sections.reduce((sum, section) => sum + (section.targetLines ?? section.lines), 0);
  if (targeted.length && plannedTotal > layout.capacity) {
    notes.push(`各節目標合計 ${plannedTotal} 行${targeted.length < sections.length ? "（未設定目標的區塊以目前行數計）" : ""}，`
      + `超過答案紙容量 ${layout.capacity} 行；請下修目標。`);
  }
  const label = (section: SectionLines) => name({ id: section.sectionId, heading: section.heading });
  const over = targeted.filter((section) => section.overTarget! > 0).sort((a, b) => b.overTarget! - a.overTarget!);
  const under = targeted.filter((section) => section.overTarget! < 0).sort((a, b) => a.overTarget! - b.overTarget!);
  // Sections that layout keeps as core: a suggestion to compress them first is wrong.
  // Same rule as compressionHints in layout.ts: required or priority >= 4.
  const protectedIds = new Set(answer.sections.filter((section) => section.required || section.priority >= 4).map((section) => section.id));
  const overSum = over.reduce((sum, section) => sum + section.overTarget!, 0);
  // Trust the over-target list only when amending those targets could actually clear
  // the overflow (their amounts reach overflowLines) and none of them is protected;
  // otherwise the page truly exceeds its capacity elsewhere, so fall back to
  // compressionHints, which ranks the most compressible sections first.
  const targetsExplainOverflow = over.length > 0 && overSum >= layout.overflowLines
    && over.every((section) => !protectedIds.has(section.sectionId));
  if (layout.overflowLines > 0) {
    const unprotected = layout.compressionHints.filter(hint => !hint.protected);
    const fallback = unprotected.length ? unprotected : layout.compressionHints;
    const first = targetsExplainOverflow
      ? over.map((section) => `${label(section)}超出目標 ${section.overTarget} 行`).join("、")
      : fallback.slice(0, 3).map((hint) => `${name({ id: hint.sectionId, heading: hint.heading })}（${hint.currentLines} 行）`).join("、");
    notes.push(`超出答案紙 ${layout.overflowLines} 行；建議先壓縮：${first}。`);
  } else if (layout.remainingLines > 0) {
    notes.push(under.length
      ? `還可再寫 ${layout.remainingLines} 行；低於目標的區塊：${under.map((section) => `${label(section)}少 ${-section.overTarget!} 行`).join("、")}。`
      : over.length
        // Room still exists, but a target is already exceeded: expansion would be misleading.
        ? `還可再寫 ${layout.remainingLines} 行。`
        : `還可再寫 ${layout.remainingLines} 行${layout.remainingLines >= 2 ? "；若要寫滿兩頁，可擴充論述最核心的區塊" : ""}。`);
  } else {
    notes.push("剛好寫滿答案紙。");
  }
  if (over.length && layout.overflowLines === 0) {
    notes.push(`超過目標：${over.map((section) => `${label(section)}多 ${section.overTarget} 行`).join("、")}。`);
  }
  return { sections, notes };
}

/** One line per section, e.g. 「一、前言」3 行（目標 3）. */
export function describeLines(sections: SectionLines[]): string {
  return sections.map((section) => `${name({ id: section.sectionId, heading: section.heading })}${section.lines} 行`
    + (section.targetLines === undefined ? "" : `（目標 ${section.targetLines}）`)).join("、");
}

/** What changed in the line targets between two versions. */
export function describeTargetChanges(before: AnswerDocument, after: AnswerDocument): string[] {
  const own = (targets: Record<string, number> | undefined, id: string) => targets && Object.hasOwn(targets, id) ? targets[id] : undefined;
  const left = before.lineTargets;
  const right = after.lineTargets;
  return [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])]
    .filter((id) => own(left, id) !== own(right, id))
    .map((id) => {
      const section = after.sections.find((item) => item.id === id) ?? before.sections.find((item) => item.id === id);
      const show = (value: number | undefined) => value === undefined ? "未設定" : `${value} 行`;
      return `${name(section ?? { id })}目標行數：${show(own(left, id))}→${show(own(right, id))}`;
    });
}

export interface LayoutWarning {
  code: "ORPHAN_HEADING" | "SPLIT_LATIN_WORD" | "PUNCTUATION_ONLY_LINE";
  page: number;
  line: number;
  sectionId: string;
  message: string;
}

/** Detection only; the authoritative wrapping and answer remain untouched. */
export function layoutWarnings(layout: LayoutReport, template?: AnswerTemplate): LayoutWarning[] {
  const warnings: LayoutWarning[] = [];
  const headings = new Map<string, LayoutReport["lines"][number]>();
  const bodies = new Set<string>();
  const lines = layout.lines.filter(line => !line.isSpacer);
  const continues = (left: LayoutLine, right: LayoutLine) => !left.isLastLineOfParagraph
    && left.sectionId === right.sectionId && left.paragraphIndex === right.paragraphIndex && left.isHeading === right.isHeading;
  const measure = template?.paperProfile ? originalPaperMeasure(template) : displayWidth;
  for (const [index, line] of lines.entries()) {
    const previous = lines[index - 1];
    if (previous && continues(previous, line) && /^[，。！？、；：,.!?;:…」』）】〉》]+$/u.test(line.text)) {
      warnings.push({ code: "PUNCTUATION_ONLY_LINE", page: line.page, line: line.lineOnPage, sectionId: line.sectionId,
        message: "自然換行後只剩結尾標點；不阻擋匯出，建議以 update_answer_info 設定 layoutOptions.avoidPunctuationOnlyLines=true，或調整換行。" });
    }
    if (line.isHeading) headings.set(line.sectionId, line);
    else if (!bodies.has(line.sectionId)) {
      bodies.add(line.sectionId);
      const heading = headings.get(line.sectionId);
      if (heading && heading.page < line.page) warnings.push({ code: "ORPHAN_HEADING", page: heading.page,
        line: heading.lineOnPage, sectionId: line.sectionId,
        message: "標題與內文分處兩頁；不阻擋匯出，建議移動區塊或改寫前文，讓標題與內文同頁。" });
    }
    if (previous && continues(previous, line)
      && /[A-Za-z0-9]$/.test(previous.text) && /^[A-Za-z0-9]/.test(line.text)) {
      let run = previous.text.match(/[A-Za-z0-9]+$/)![0];
      for (let cursor = index - 2; cursor >= 0 && /^[A-Za-z0-9]+$/.test(lines[cursor + 1].text)
        && continues(lines[cursor], lines[cursor + 1]); cursor -= 1) {
        run = (lines[cursor].text.match(/[A-Za-z0-9]+$/)?.[0] ?? "") + run;
      }
      for (let cursor = index; cursor < lines.length && continues(lines[cursor - 1], lines[cursor]); cursor += 1) {
        const prefix = lines[cursor].text.match(/^[A-Za-z0-9]+/)?.[0] ?? "";
        run += prefix;
        if (prefix.length !== lines[cursor].text.length) break;
      }
      const available = template?.paperProfile ? originalPaperAvailableWidth(line.format, template)
        : (template?.columns ?? layout.columns) - line.format.leftIndent - line.format.rightIndent;
      warnings.push({ code: "SPLIT_LATIN_WORD", page: previous.page, line: previous.lineOnPage, sectionId: line.sectionId,
        message: measure(run) <= available
          ? "英數字詞跨行斷開；字詞可容納於一行，僅因未啟用整字換行而拆開，不阻擋匯出，建議用 update_answer_info 設定 layoutOptions.wholeLatinWords=true，或改寫字句。"
          : "英文字詞跨行斷開；字詞長於一行時仍須斷行，不阻擋匯出，建議縮短字詞或調整縮排。" });
    }
  }
  return warnings;
}
