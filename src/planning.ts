import type { AnswerDocument, AnswerSection, LayoutReport } from "./domain.js";

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
    const targetLines = targets[section.id];
    return { sectionId: section.id, heading: section.heading, lines,
      ...(targetLines === undefined ? {} : { targetLines, overTarget: lines - targetLines }) };
  });
  const notes: string[] = [];
  const targeted = sections.filter((section) => section.targetLines !== undefined);
  const plannedTotal = targeted.reduce((sum, section) => sum + section.targetLines!, 0);
  if (targeted.length === sections.length && plannedTotal > layout.capacity) {
    notes.push(`各節目標合計 ${plannedTotal} 行，超過答案紙容量 ${layout.capacity} 行；請下修目標。`);
  }
  const label = (section: SectionLines) => name({ id: section.sectionId, heading: section.heading });
  const over = targeted.filter((section) => section.overTarget! > 0).sort((a, b) => b.overTarget! - a.overTarget!);
  const under = targeted.filter((section) => section.overTarget! < 0).sort((a, b) => a.overTarget! - b.overTarget!);
  if (layout.overflowLines > 0) {
    const first = over.length ? over.map((section) => `${label(section)}超出目標 ${section.overTarget} 行`).join("、")
      : layout.compressionHints.slice(0, 3).map((hint) => `${name({ id: hint.sectionId, heading: hint.heading })}（${hint.currentLines} 行）`).join("、");
    notes.push(`超出答案紙 ${layout.overflowLines} 行；建議先壓縮：${first}。`);
  } else if (layout.remainingLines > 0) {
    notes.push(under.length
      ? `還可再寫 ${layout.remainingLines} 行；低於目標的區塊：${under.map((section) => `${label(section)}少 ${-section.overTarget!} 行`).join("、")}。`
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
  const left = before.lineTargets ?? {};
  const right = after.lineTargets ?? {};
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((id) => left[id] !== right[id])
    .map((id) => {
      const section = after.sections.find((item) => item.id === id) ?? before.sections.find((item) => item.id === id);
      const show = (value: number | undefined) => value === undefined ? "未設定" : `${value} 行`;
      return `${name(section ?? { id })}目標行數：${show(left[id])}→${show(right[id])}`;
    });
}
