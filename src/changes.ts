import type { AnswerParagraph, AnswerSection, AnswerSnapshot, LayoutLine, LayoutReport } from "./domain.js";

const CONTEXT_CHARS = 10;
const FRAGMENT_CHARS = 60;

function clip(chars: string[], max = FRAGMENT_CHARS): string {
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function paragraphsOf(section: AnswerSection): AnswerParagraph[] {
  return section.paragraphs?.length
    ? section.paragraphs
    : section.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((text) => ({ text }));
}

function label(section: AnswerSection): string {
  return `「${section.heading || section.id}」`;
}

/** Page/line span of one layout paragraph (0 = heading, n = paragraph n), spacer lines excluded. */
function locate(layout: LayoutReport, sectionId: string, paragraphIndex?: number): string {
  const lines = layout.lines.filter((line) => line.sectionId === sectionId && !line.isSpacer
    && (paragraphIndex === undefined || line.paragraphIndex === paragraphIndex));
  if (lines.length === 0) return "";
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === last) return `（第${first.page}頁第${first.lineOnPage}行）`;
  if (first.page === last.page) return `（第${first.page}頁第${first.lineOnPage}–${last.lineOnPage}行）`;
  return `（第${first.page}頁第${first.lineOnPage}行至第${last.page}頁第${last.lineOnPage}行）`;
}

/** The changed span between two versions of one paragraph, trimmed to the differing middle. */
export function describeTextChange(before: string, after: string): string {
  const a = Array.from(before);
  const b = Array.from(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  if (removed.length === 0) {
    const lead = a.slice(Math.max(0, prefix - CONTEXT_CHARS), prefix);
    return lead.length ? `在「${prefix > CONTEXT_CHARS ? "…" : ""}${lead.join("")}」之後加入「${clip(added)}」` : `在段首加入「${clip(added)}」`;
  }
  if (added.length === 0) return `刪除「${clip(removed)}」`;
  return `「${clip(removed)}」改為「${clip(added)}」`;
}

function describeFormat(before: object | undefined, after: object | undefined): string {
  const left = (before ?? {}) as Record<string, unknown>;
  const right = (after ?? {}) as Record<string, unknown>;
  const show = (value: unknown) => value === undefined ? "預設" : String(value);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]))
    .map((key) => `${key} ${show(left[key])}→${show(right[key])}`)
    .join("、");
}

type Step = { kind: "same"; before: number; after: number } | { kind: "removed"; before: number } | { kind: "added"; after: number };

/** Above this many table cells, paragraphs are compared by position instead of aligned. */
const MAX_ALIGNMENT_CELLS = 250_000;

/** Longest-common-subsequence alignment of two paragraph lists by text. */
function alignParagraphs(before: string[], after: string[]): Step[] {
  const rows = before.length;
  const columns = after.length;
  if (rows * columns > MAX_ALIGNMENT_CELLS) {
    const positional: Step[] = [];
    for (let index = 0; index < Math.max(rows, columns); index++) {
      if (index < rows && index < columns && before[index] === after[index]) {
        positional.push({ kind: "same", before: index, after: index });
        continue;
      }
      if (index < rows) positional.push({ kind: "removed", before: index });
      if (index < columns) positional.push({ kind: "added", after: index });
    }
    return positional;
  }
  const table = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = columns - 1; j >= 0; j--) {
      table[i][j] = before[i] === after[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const steps: Step[] = [];
  let i = 0;
  let j = 0;
  while (i < rows || j < columns) {
    if (i < rows && j < columns && before[i] === after[j]) steps.push({ kind: "same", before: i++, after: j++ });
    else if (i < rows && (j === columns || table[i + 1][j] >= table[i][j + 1])) steps.push({ kind: "removed", before: i++ });
    else steps.push({ kind: "added", after: j++ });
  }
  return steps;
}

function describeSection(before: AnswerSection, after: AnswerSection, beforeLayout: LayoutReport, afterLayout: LayoutReport): string[] {
  const lines: string[] = [];
  const name = label(after);
  if ((before.heading ?? "") !== (after.heading ?? "")) {
    lines.push(`${name}標題${locate(afterLayout, after.id, 0)}：${describeTextChange(before.heading ?? "", after.heading ?? "")}`);
  }
  const sectionFormat = describeFormat(before.paragraphFormat, after.paragraphFormat);
  if (sectionFormat) lines.push(`${name}全區塊段落格式：${sectionFormat}`);
  const headingFormat = describeFormat(before.headingStyle, after.headingStyle);
  if (headingFormat) lines.push(`${name}標題樣式：${headingFormat}`);

  const oldParagraphs = paragraphsOf(before);
  const newParagraphs = paragraphsOf(after);
  const steps = alignParagraphs(oldParagraphs.map((item) => item.text), newParagraphs.map((item) => item.text));
  // A removed run directly followed by an added run is one rewritten stretch: pair them up.
  for (let index = 0; index < steps.length;) {
    const step = steps[index];
    if (step.kind === "same") {
      const format = describeFormat(oldParagraphs[step.before].format, newParagraphs[step.after].format);
      if (format) lines.push(`${name}第${step.after + 1}段${locate(afterLayout, after.id, step.after + 1)}格式：${format}`);
      index++;
      continue;
    }
    const removed: number[] = [];
    const added: number[] = [];
    while (index < steps.length && steps[index].kind !== "same") {
      const current = steps[index++];
      if (current.kind === "removed") removed.push(current.before);
      else if (current.kind === "added") added.push(current.after);
    }
    const paired = Math.min(removed.length, added.length);
    for (let k = 0; k < paired; k++) {
      const position = added[k];
      lines.push(`${name}第${position + 1}段${locate(afterLayout, after.id, position + 1)}：`
        + describeTextChange(oldParagraphs[removed[k]].text, newParagraphs[position].text));
    }
    for (const position of added.slice(paired)) {
      lines.push(`${name}新增第${position + 1}段${locate(afterLayout, after.id, position + 1)}：「${clip(Array.from(newParagraphs[position].text))}」`);
    }
    for (const position of removed.slice(paired)) {
      lines.push(`${name}刪除原第${position + 1}段${locate(beforeLayout, before.id, position + 1)}：「${clip(Array.from(oldParagraphs[position].text))}」`);
    }
  }
  return lines;
}

function lineKey(line: LayoutLine | undefined): string {
  return line ? JSON.stringify([line.text, line.displayWidth, line.isHeading, line.isSpacer, line.format]) : "";
}

/**
 * Human-readable differences between two snapshots: changed sections and paragraphs with their
 * page/line position, and where the rendered grid starts to differ.
 */
export function describeChanges(before: AnswerSnapshot, after: AnswerSnapshot, maxLines = 30): string[] {
  const lines: string[] = [];
  const oldSections = new Map(before.answer.sections.map((section) => [section.id, section]));
  const newIds = new Set(after.answer.sections.map((section) => section.id));
  for (const section of after.answer.sections) {
    const previous = oldSections.get(section.id);
    if (!previous) lines.push(`新增區塊${label(section)}${locate(after.layout, section.id)}`);
    else lines.push(...describeSection(previous, section, before.layout, after.layout));
  }
  for (const section of before.answer.sections) {
    if (!newIds.has(section.id)) lines.push(`刪除區塊${label(section)}${locate(before.layout, section.id).replace("（", "（原")}`);
  }
  const kept = before.answer.sections.filter((section) => newIds.has(section.id)).map((section) => section.id);
  const keptAfter = after.answer.sections.filter((section) => oldSections.has(section.id)).map((section) => section.id);
  if (kept.join("\n") !== keptAfter.join("\n")) lines.push("區塊順序改變：" + after.answer.sections.map(label).join("、"));

  const listed = lines.length > maxLines ? [...lines.slice(0, maxLines), `…另有 ${lines.length - maxLines} 項變更未列出。`] : lines;
  const total = Math.max(before.layout.lines.length, after.layout.lines.length);
  let first = 0;
  while (first < total && lineKey(before.layout.lines[first]) === lineKey(after.layout.lines[first])) first++;
  if (first === total) {
    listed.push("版面沒有改變。");
  } else {
    const start = after.layout.lines[first] ?? before.layout.lines[first];
    const used = (layout: LayoutReport, page: number) => layout.pageUsage.find((item) => item.page === page)?.linesUsed ?? 0;
    const usage = [...new Set([...before.layout.pageUsage, ...after.layout.pageUsage].map((item) => item.page))].sort((x, y) => x - y)
      .filter((page) => used(before.layout, page) !== used(after.layout, page))
      .map((page) => `第${page}頁 ${used(before.layout, page)}→${used(after.layout, page)} 行`);
    listed.push(`版面自第${start.page}頁第${start.lineOnPage}行起改變${usage.length ? "；" + usage.join("、") : ""}。`);
  }
  return listed;
}
