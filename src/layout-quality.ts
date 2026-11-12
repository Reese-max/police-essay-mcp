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
  /** Departures from the two exam books' format; counted only for answers with layoutOptions.neatFormat. */
  bookFormatIssues: number;
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
  /** Body text after a compactPaper heading inlined into the first line. */
  lead?: string;
}

const firstText = (paragraph: Paragraph) => paragraph.lead ?? paragraph.lines[0]?.text ?? "";

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

type HierarchyIssue = { order: number; kind: "skip" | "family" | "gap" | "headless"; prefix: string; expectedLevel?: number };

function hierarchyIssueList(items: Array<{ numbering: Numbering; order: number; restart?: boolean }>): HierarchyIssue[] {
  const issues: HierarchyIssue[] = [];
  const stack: Array<{ level: number; key: number }> = [];
  const siblings = new Map<string, { family: string; value: number }>();
  let previousLevel: number | undefined;

  for (const item of items) {
    const { level, family, value, prefix } = item.numbering;
    if (previousLevel !== undefined && level > previousLevel + 1) issues.push({ order: item.order, kind: "skip", prefix, expectedLevel: previousLevel + 1 });
    previousLevel = level;
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    const parentKey = stack.at(-1)?.key ?? 0;
    const siblingKey = `${parentKey}:${level}`;
    const previous = siblings.get(siblingKey);
    if (previous) {
      if (previous.family !== family) issues.push({ order: item.order, kind: "family", prefix });
      if (value !== previous.value + 1) issues.push({ order: item.order, kind: item.restart && value === 1 ? "headless" : "gap", prefix });
    }
    siblings.set(siblingKey, { family, value });
    stack.push({ level, key: item.order + 1 });
  }
  return issues;
}

/** Scores observable layout output without changing the answer or its layout report. */
export function scoreLayout(template: AnswerTemplate, answer: AnswerDocument, report: LayoutReport): LayoutQuality {
  return analyzeLayout(template, answer, report).quality;
}

const LEVEL_NAMES = ["", "壹、", "一、", "(一)", "1.", "(1)", "甲、"];

/** Actionable zh-TW notes naming the paragraphs behind the structural metrics (for check_layout). */
export function layoutQualityNotes(template: AnswerTemplate, answer: AnswerDocument, report: LayoutReport): string[] {
  const { quality, paragraphs, embeddedHeadings, hierarchyIssues, offIndentParagraphs, usualIndent, bookNotes, bookHeadless } = analyzeLayout(template, answer, report);
  const start = (text: string) => `「${[...text.trim()].slice(0, 14).join("")}」`;
  const notes: string[] = [];
  if (quality.flattenedStructure) notes.push("結構提醒：整份只有一節而編號項目都寫在段落；建議每個大點各成一節，編號與標題放 heading。");
  for (const paragraph of embeddedHeadings) notes.push(`結構提醒：${start(paragraph.text)}像標題卻寫成段落文字；建議改為該節 heading 或另立一節。`);
  for (const issue of hierarchyIssues) {
    // The neat format's "no 大標" note already names these sections.
    if (issue.kind === "headless" && bookHeadless.has(paragraphs[issue.order].sectionId)) continue;
    const at = start(paragraphs[issue.order].text);
    notes.push(issue.kind === "skip"
      ? `結構提醒：${at}跳過中間層級（應依 (一)→1.→(1) 逐層往下；用到「一、」時其下接 (一)）；建議改用${LEVEL_NAMES[issue.expectedLevel ?? 0] || "上一層"}類編號或補上中間層。`
      : issue.kind === "family"
        ? `結構提醒：${at}與同層前一項的編號樣式不同；同層請用同一種編號。`
        : issue.kind === "headless"
          ? `結構提醒：${at}所在的節沒有標題，編號又從頭起算，看不出屬於哪一點；請補上該節 heading（如「二、○○」或名詞名稱），不必增加內文。`
          : `結構提醒：${at}與同層前一項不連號；請依序編號。`);
  }
  for (const paragraph of offIndentParagraphs) notes.push(`結構提醒：${start(paragraph.text)}首行起點 ${(paragraph.lines[0]?.format.leftIndent ?? 0) + (paragraph.lines[0]?.format.firstLineIndent ?? 0)}，與其他內文段落的 ${usualIndent} 不同；內文請統一（firstLineIndent 單位為顯示寬度，2 格＝4）。`);
  if (quality.misalignedContinuations) notes.push(answer.layoutOptions?.autoHangingIndent === false
    ? "結構提醒：編號段落的續行未對齊內文；建議以 update_answer_info 設定 layoutOptions.autoHangingIndent=true。"
    : "結構提醒：編號段落的續行未對齊內文；建議移除段落的 hangingIndent 讓引擎自動對齊。");
  notes.push(...bookNotes);
  // 50招 p.122 / 高分寫作 p.92: about 1.5 lines per point; allow 25% variation.
  const question = answer.question ?? "";
  const explicitTotal = question.match(/[（(]\s*(?:共|總分)\s*(\d+)\s*分\s*[）)]/u);
  const matches = [...question.matchAll(/[（(]\s*(\d+)\s*分\s*[）)]/gu)];
  const scores = matches.map(match => Number(match[1]));
  const sum = scores.reduce((total, score) => total + score, 0);
  const subquestion = question.search(/[（(][一二三四五六七八九十\d]+[）)]/u);
  // An overall score before the first numbered subquestion is not a sub-score.
  const leadingTotal = subquestion >= 0 && matches[0] && matches[0].index! < subquestion;
  const points = explicitTotal ? Number(explicitTotal[1]) : leadingTotal ? scores[0] : sum;
  const target = Math.min(report.capacity, points * 1.5);
  if (answer.layoutOptions?.neatFormat && target > 0 && report.totalLines < target * 0.75) {
    notes.push(`篇幅提醒：目前 ${report.totalLines} 行，明顯少於配分建議約 ${Math.round(target)} 行（配分×1.5，以容量 ${report.capacity} 行為上限）；自行撰寫的新答案建議補充論述或例證，勿加空白湊行；使用者提供的原稿仍須先取得擴寫授權。`);
  }
  return notes;
}

/** compactPaper inlines a short heading into the first body line ("一、標題：內文"); split it back out. */
function splitInlinedHeadings(paragraphs: Paragraph[], answer: AnswerDocument): Paragraph[] {
  const headings = new Map(answer.sections.map(section => [section.id, section.heading?.trim()]));
  const done = new Set(paragraphs.filter(paragraph => paragraph.isHeading).map(paragraph => paragraph.sectionId));
  return paragraphs.flatMap(paragraph => {
    const heading = headings.get(paragraph.sectionId);
    if (paragraph.isHeading || !heading || done.has(paragraph.sectionId) || !paragraph.text.startsWith(heading)) return [paragraph];
    done.add(paragraph.sectionId);
    const rest = paragraph.text.slice(heading.length).replace(/^[：:]/u, "");
    return [{ ...paragraph, isHeading: true, text: heading },
      ...(rest.trim() ? [{ ...paragraph, text: rest, lead: rest }] : [])];
  });
}

function analyzeLayout(template: AnswerTemplate, answer: AnswerDocument, report: LayoutReport) {
  const paragraphs = splitInlinedHeadings(collectParagraphs(report), answer);
  const measure = template.paperProfile
    ? (() => {
        const paperMeasure = originalPaperMeasure(template);
        return (text: string) => paperMeasure(text) / (template.fontSizePt / 2);
      })()
    : (text: string) => displayWidth(text);
  const bodyParagraphs = paragraphs.filter(paragraph => !paragraph.isHeading);
  const numberedParagraphs = bodyParagraphs.filter(paragraph => classifyNumbering(firstText(paragraph)));

  // A title-like numbered paragraph leading deeper-numbered items in its section is a legitimate sub-heading:
  // sections carry only one heading level.
  const embeddedHeadings = bodyParagraphs.filter((paragraph, index) => {
    const numbering = classifyNumbering(firstText(paragraph));
    if (!numbering || /[。！？][」』）)]*\s*$/u.test(paragraph.text)) return false;
    // 「1.取得搜索票：票面載明……」 is a list item with content, not a title.
    if (/[：:，；].*\S/u.test(paragraph.text.slice(paragraph.text.indexOf(numbering.prefix) + numbering.prefix.length))) return false;
    const near = (offset: number) => {
      const other = bodyParagraphs[index + offset];
      return other?.sectionId === paragraph.sectionId ? classifyNumbering(firstText(other)) : undefined;
    };
    // Neat format (50招 p.9): 「1.○○：」 alone on its line is a 中標 over the body below it.
    const following = bodyParagraphs[index + 1];
    if (answer.layoutOptions?.neatFormat && /[：:]\s*$/u.test(paragraph.text) && following?.sectionId === paragraph.sectionId
      && !classifyNumbering(firstText(following))) return false;
    const nextNumbering = near(1);
    // Consecutive same-family siblings ("一、CPU暫存器", "二、路由表") are a short list, not headings.
    const sibling = (other: Numbering | undefined, step: number) => other?.family === numbering.family && other.value === numbering.value + step;
    if (sibling(near(-1), -1) || sibling(nextNumbering, 1)) return false;
    return !(nextNumbering && nextNumbering.level > numbering.level);
  });

  let misalignedContinuations = 0;
  for (const paragraph of numberedParagraphs) {
    if (paragraph.lead !== undefined) continue; // the marker sits after an inlined heading, not at the line start
    const numbering = classifyNumbering(paragraph.lines[0]?.text ?? "");
    if (!numbering) continue;
    const requiredStart = lineIndentColumns(paragraph.lines[0]) + Math.round(measure(numbering.prefix)); // columns are whole display units
    for (const line of paragraph.lines.slice(1)) {
      if (lineIndentColumns(line) < requiredStart) misalignedContinuations += 1;
    }
  }

  // Body items count too: list items ending in 。 are the common case, and skipping them hid restarts.
  const headed = new Set(paragraphs.filter(paragraph => paragraph.isHeading).map(paragraph => paragraph.sectionId));
  const seenSections = new Set<string>(), numberedSections = new Set<string>();
  const hierarchyItems = paragraphs.flatMap((paragraph, index) => {
    const numbering = classifyNumbering(firstText(paragraph));
    const laterSection = seenSections.size > (seenSections.has(paragraph.sectionId) ? 1 : 0);
    seenSections.add(paragraph.sectionId);
    if (!numbering) return [];
    // A later section without a heading that starts its list over (after any lead-in prose) leaves the reader without the point it belongs to.
    const restart = laterSection && !numberedSections.has(paragraph.sectionId) && !headed.has(paragraph.sectionId);
    numberedSections.add(paragraph.sectionId);
    return [{ numbering, order: index, restart }];
  });

  const proseParagraphs = bodyParagraphs.filter(paragraph => paragraph.text.trim() && !classifyNumbering(firstText(paragraph)));
  // Where the first line starts: a leftIndent moves it as much as a firstLineIndent does.
  const indentOf = (paragraph: Paragraph) => (paragraph.lines[0]?.format.leftIndent ?? 0) + (paragraph.lines[0]?.format.firstLineIndent ?? 0);
  const bodyIndents = new Set(proseParagraphs.map(indentOf));
  const counts = new Map<number, number>();
  for (const paragraph of proseParagraphs) counts.set(indentOf(paragraph), (counts.get(indentOf(paragraph)) ?? 0) + 1);
  const usualIndent = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  const offIndentParagraphs = proseParagraphs.filter(paragraph => indentOf(paragraph) !== usualIndent);

  let shortTailLines = 0;
  for (const paragraph of bodyParagraphs) {
    const tail = paragraph.lines.at(-1)?.text ?? "";
    if (paragraph.lines.length > 1 && tail.trim() && measure(tail) <= 4) shortTailLines += 1;
  }

  const capacity = report.capacity;
  const fill = capacity > 0 ? Math.round((report.totalLines / capacity) * 100) / 100 : 0;
  const hierarchyIssues = hierarchyIssueList(hierarchyItems);

  // The exam books (50招 p.9/p.16, 高分寫作 p.87): lead and closing prose carry no heading, numbering runs
  // (一)→1.→(1) with at most three levels, and 壹、 is not used. Only new-format answers are held to it.
  const bookNotes: string[] = [];
  const bookHeadless = new Set<string>();
  const start = (text: string) => `「${[...text.trim()].slice(0, 14).join("")}」`;
  if (answer.layoutOptions?.neatFormat) {
    const labels = answer.sections.filter(section => {
      const heading = section.heading?.trim() ?? "";
      const rest = heading.slice(classifyNumbering(heading)?.prefix.length ?? 0).trim();
      return /^(前言|緒論|導論|引言|結論|結語|小結|本文)[：:]?$/u.test(rest);
    });
    if (labels.length) bookNotes.push(`格式提醒：${labels.map(section => `「${section.heading!.trim()}」`).join("、")}是功能標籤；前言、結語不下標題，請移除該節 heading（null），內文保留，引擎會首行空兩格。`);
    const levels = new Set(hierarchyItems.map(item => item.numbering.level));
    if (levels.has(1)) bookNotes.push("格式提醒：答案內標號從 (一) 起算（題號已在題號欄），不用「壹、」；請改為 (一)→1.→(1)，只改編號不改內容。");
    if (levels.size > 3) bookNotes.push(`格式提醒：編號用了 ${levels.size} 層；一般申論最多三層 (一)→1.→(1)，請合併最深一層或改寫成句子。`);
    // 50招 p.8: one 大標 per point. Body text between the lead and closing sections needs its own heading.
    const ordered = [...answer.sections].sort((a, b) => a.order - b.order);
    const bodyText = (section: typeof ordered[number]) => (section.paragraphs?.length ? section.paragraphs.map(p => p.text).join("") : section.text ?? "").trim();
    // A section opening with its own (一)/一、 item carries the 大標 inline (50招 p.204 「最充實」 format).
    const headless = ordered.slice(1, -1).filter(section => !section.heading?.trim() && bodyText(section)
      && !((classifyNumbering(bodyText(section))?.level ?? 9) <= 3));
    for (const section of headless) bookHeadless.add(section.id);
    if (headless.length) bookNotes.push(`格式提醒：${headless.map(section => start(bodyText(section))).join("、")}在本文中卻沒有大標；本文每個考點請下「(一)○○：」標題：用 replace_text 對該節帶 heading 即可（內文照舊，不必新增或搬移節）；若只是上一點的延續就併入上一節。標題獨佔一行會多佔行，因此超頁時精簡該節內文，不要為了省行而不下標題。`);
    // Several numbered items run together in one paragraph ("(1)…。(2)…") should each start their own paragraph.
    const packed = paragraphs.filter(paragraph => !paragraph.isHeading && classifyNumbering(firstText(paragraph))
      && /[。；;]\s*(?:[（(](?:[0-9０-９]+|[一二三四五六七八九十]+)[）)]|[0-9０-９]+[.．、](?![0-9０-９]))/u.test(paragraph.text));
    if (packed.length) bookNotes.push(`格式提醒：${packed.map(paragraph => start(paragraph.text)).join("、")}一段內有多個編號項；請每項各成一段（paragraphs），不改內容。`);
    // Full-width brackets are wider than the two cells left of the text line, so their text cannot align there.
    if (hierarchyItems.some(item => item.numbering.prefix.trimStart().startsWith("（"))) bookNotes.push("格式提醒：括號編號請用半形「(一)」「(1)」；全形「（一）」太寬，內文無法對齊第 3 格。只改括號，不改內容。");
  }
  const quality: LayoutQuality = {
    fill,
    totalLines: report.totalLines,
    capacity,
    flattenedStructure: report.totalLines >= 20 && answer.sections.length <= 1 && numberedParagraphs.length >= 2,
    embeddedHeadingParagraphs: embeddedHeadings.length,
    misalignedContinuations,
    hierarchyIssues: hierarchyIssues.length,
    indentInconsistency: Math.max(0, bodyIndents.size - 1),
    shortTailLines,
    punctuationOnlyLines: layoutWarnings(report, template).filter(warning => warning.code === "PUNCTUATION_ONLY_LINE").length,
    bookFormatIssues: bookNotes.length,
  };
  return { quality, paragraphs, embeddedHeadings, hierarchyIssues, offIndentParagraphs, usualIndent, bookNotes, bookHeadless };
}
