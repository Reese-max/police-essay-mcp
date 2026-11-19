import { layoutText, type AnswerDocument, type AnswerTemplate, type LayoutLine, type LayoutReport } from "./domain.js";
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

  match = value.match(/^[⑴-⒇]/u);
  if (match) return { level: 5, family: "parenthesized-arabic", value: match[0].codePointAt(0)! - 0x2473, prefix: match[0] };

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

const LEVEL_NAMES = ["", "壹、", "一、", "(一)", "1.", "⑴", "甲、"];

/** Actionable zh-TW notes naming the paragraphs behind the structural metrics (for check_layout). */
export function layoutQualityNotes(template: AnswerTemplate, answer: AnswerDocument, report: LayoutReport): string[] {
  const { quality, paragraphs, embeddedHeadings, hierarchyIssues, offIndentParagraphs, usualIndent, bookNotes, bookHeadless } = analyzeLayout(template, answer, report);
  const start = (text: string) => `「${[...text.trim()].slice(0, 14).join("")}」`;
  const notes: string[] = [];
  // Keys are scoped per heading level and reset under a new parent: "(一)" legitimately restarts under each "一、".
  const seenByLevel = new Map<number, Set<string>>(), duplicateNumbers = new Set<string>();
  for (const [index, section] of answer.sections.entries()) {
    const heading = section.heading?.trim() ?? "";
    const numbering = classifyNumbering(heading);
    if (numbering && numbering.level <= 3) {
      for (const level of [...seenByLevel.keys()]) if (level > numbering.level) seenByLevel.delete(level);
      const seen = seenByLevel.get(numbering.level) ?? new Set<string>();
      seenByLevel.set(numbering.level, seen);
      const numberKey = `#${numbering.family}:${numbering.value}`;
      const title = heading.slice(numbering.prefix.length).replace(/[：:]\s*$/u, "").trim();
      if (seen.has(numberKey)) duplicateNumbers.add(section.id);
      if (seen.has(numberKey) || (title && seen.has(title)))
        notes.push(`格式提醒：第 ${index + 1} 節大標編號或標題重複；請合併重複節或改正編號、標題，保留獨立論點。`);
      seen.add(numberKey);
      if (title) seen.add(title);
    }
    const texts = section.paragraphs?.length ? section.paragraphs.map(p => p.text) : (section.text ?? "").split("\n");
    if ([heading, ...texts].some(text => text.includes("\\n")))
      notes.push(`格式提醒：第 ${index + 1} 節含字面反斜線 n；請改成真正分段（paragraphs 各一項），保留內容。`);
    for (const text of texts) {
      // A 1./(1) item after a sentence end, when the same level already had a smaller number in this paragraph.
      const lastByLevel = new Map<number, number>(), packed: string[] = [];
      for (const match of text.matchAll(/(^|[。；;：:][」』）)]*)\s*((?:[⑴-⒇]|[（(][0-9０-９]+[）)]|[0-9０-９]+[.．、](?![0-9０-９])))/gu)) {
        const item = classifyNumbering(match[2]);
        if (!item || item.level < 4) continue;
        const before = lastByLevel.get(item.level);
        if (/^[。；;]/u.test(match[1]) && before !== undefined && item.value > before) packed.push(match[2]);
        lastByLevel.set(item.level, item.value);
      }
      if (packed.length) notes.push(`格式提醒：第 ${index + 1} 節把「${packed.join("」「")}」併在同一段；各點另起一段（paragraphs 各一項），若因此超頁改精簡各點措辭，不要併段。`);
    }
  }

  if (quality.flattenedStructure) notes.push("結構提醒：整份只有一節而編號項目都寫在段落；建議每個大點各成一節，編號與標題放 heading。");
  for (const paragraph of embeddedHeadings) notes.push(`結構提醒：${start(paragraph.text)}像標題卻寫成段落文字；建議改為該節 heading 或另立一節。`);
  for (const issue of hierarchyIssues) {
    if (issue.kind === "gap" && paragraphs[issue.order].isHeading && duplicateNumbers.has(paragraphs[issue.order].sectionId)) continue;
    // The neat format's "no 大標" note already names these sections.
    if (issue.kind === "headless" && bookHeadless.has(paragraphs[issue.order].sectionId)) continue;
    const at = start(paragraphs[issue.order].text);
    notes.push(issue.kind === "skip"
      ? `結構提醒：${at}跳過中間層級（應依 一、→(一)→1.→⑴ 逐層往下）；建議改用${LEVEL_NAMES[issue.expectedLevel ?? 0] || "上一層"}類編號或補上中間層。`
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
  // Full-width digits and 國字 scores 「（二十五分）」 count like 「（25分）」.
  const question = asciiDigits(answer.question ?? "").replace(/([（(]\s*(?:共|總分)?\s*)([一二三四五六七八九十]+)(\s*分\s*[）)])/gu,
    (match, open: string, value: string, close: string) => { const score = parseChineseNumber(value); return score ? `${open}${score}${close}` : match; });
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
    notes.push(`篇幅提醒：目前 ${report.totalLines} 行，明顯少於配分建議約 ${Math.round(target)} 行（配分×1.5，以容量 ${report.capacity} 行為上限）；自行撰寫的新答案請先核對題目採分點是否齊備，已完整則不為填滿答題紙擴寫；使用者提供的原稿仍須先取得擴寫授權。`);
  }
  // Current writing rules: lead and closing each take one or two lines.
  // Full essays only; empty sections are skipped and a single-section answer is left to the flattened-structure note.
  const sectionText = (section: typeof answer.sections[number]) => (section.paragraphs?.length ? section.paragraphs.map(p => p.text).join("") : section.text ?? "").trim();
  const filled = [...answer.sections].sort((a, b) => a.order - b.order).filter(section => section.heading?.trim() || sectionText(section));
  if (answer.layoutOptions?.neatFormat && filled.length >= 2 && (points >= 15 || (!points && report.totalLines >= 20))) {
    // 「(四)結論與建議：」「(六)比較與結語：」「(四)本案結論：」 still mark the closing here (the label note itself stays exact-match).
    const edgeLabel = (heading: string) => {
      const rest = heading.slice(classifyNumbering(heading)?.prefix.length ?? 0).trim();
      return /^(前言|緒論|導論|引言|結論|結語|小結|總結)(?:[與及和暨].{0,6})?[：:]?$/u.test(rest) || /^.{1,8}(?:結論|結語|總結)[：:]?$/u.test(rest);
    };
    // Same edge rule as the layout: the first/last headless prose section; one opening with (一)/一、 is body,
    // unless a 「結論與建議」-style heading already marks it (its points may be listed as (一)(二)).
    const prose = (section: typeof filled[number]) => section.heading?.trim() ? edgeLabel(section.heading.trim()) && !!sectionText(section)
      : !!sectionText(section) && !((classifyNumbering(sectionText(section))?.level ?? 9) <= 3);
    const linesOf = (id: string) => report.lines.filter(line => line.sectionId === id && !line.isHeading && !line.isSpacer && line.text.trim()).length;
    const lead = prose(filled[0]) ? filled[0] : undefined;
    const last = filled.at(-1)!;
    const closing = prose(last) ? last : undefined;
    const own = "使用者提供的原稿或既有答案只向使用者建議，取得同意後才增寫。";
    const keep = "若因此超頁，開頭、結語各 1–2 行即可，其餘從本文的套話與重複精簡，不刪必要論證。";
    const exempt = "法科實例題、計算題、名詞解釋題可不寫前言";
    if (!lead) notes.push(`結構提醒：沒有前言（${exempt}，略過本則）；其他題型請用 insert_text 新增不帶 heading 的節，再以 move_section 移到第一節之前，寫一到兩行，用「」框出本題核心概念並說明依此進行的程序或分析，不重抄題目。${own}${keep}`);
    else if (linesOf(lead.id) > 2) notes.push(`結構提醒：前言 ${linesOf(lead.id)} 行；開頭一到兩行即可：用「」框出本題核心概念，說明依此進行的程序或分析。${own}${keep}`);
    const tail = (last.paragraphs?.length ? last.paragraphs.map(p => p.text) : (last.text ?? "").split("\n")).at(-1)?.trim() ?? "";
    const kinds = "法科實例題、計算題寫明本案結論或計算結果即可，不必加建議；名詞解釋題可略過本則。";
    if (!closing && /^(綜上|總之|綜合|總結|結論)/u.test(tail)) {
      notes.push(`結構提醒：最後一節末段${start(tail)}是結語，卻寫在${last.heading?.trim() ? `「${last.heading.trim()}」` : start(sectionText(last))}節內；請用 replace_text 從該節刪去這段，再以 insert_text（省略 afterSectionId）新增不帶 heading 的節放入原文（內容照舊），不要另寫第二段結語。使用者提供的原稿或既有答案只向使用者建議，取得同意後才調整。`);
    } else if (!closing) {
      notes.push(`結構提醒：沒有結語；請用 insert_text（省略 afterSectionId 即加在最後）新增不帶 heading 的節，寫一到兩行回扣題目所問、收束本文已論證的判斷，不新增論點；${kinds}${own}${keep}`);
    } else {
      const closingLines = linesOf(closing.id);
      if (closingLines > 2) notes.push(`結構提醒：結語 ${closingLines} 行；結語一到兩行即可，回扣題目所問，不新增論點。${own}${keep}`);
    }
  }
  return notes;
}

/** compactPaper inlines a short heading into the first body line ("一、標題：內文"); split it back out. */
function splitInlinedHeadings(paragraphs: Paragraph[], answer: AnswerDocument, template: AnswerTemplate): Paragraph[] {
  // Compare against the heading as laid out, not as stored.
  const headings = new Map(answer.sections.map(section => [section.id, section.heading === undefined ? undefined : layoutText(template, section.heading).trim()]));
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
  const paragraphs = splitInlinedHeadings(collectParagraphs(report), answer, template);
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
  // 一、→(一)→1.→⑴ with at most four levels, and 壹、 is not used. Only new-format answers are held to it.
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
    if (levels.has(1)) bookNotes.push("格式提醒：整份答案不加總標題編號，不用「壹、」；子題大標請改為「一、」，其下 (一)→1.→⑴，只改編號不改內容。");
    // User style: each numbered point ((一)/1./⑴) takes one or two lines; a longer point should become more points.
    const pointLines = new Map<string, { start: string; lines: number }>();
    for (const line of report.lines) {
      if (line.isHeading || line.isSpacer || line.isPadding || !line.text.trim()) continue;
      const key = `${line.sectionId}\u0000${line.paragraphIndex}`;
      const point = pointLines.get(key);
      if (point) point.lines++;
      else if (line.isFirstLineOfParagraph && (classifyNumbering(line.text.trim())?.level ?? 0) >= 3) pointLines.set(key, { start: start(line.text), lines: 1 });
    }
    const longPoints = [...pointLines.values()].filter(point => point.lines > 2);
    if (longPoints.length) bookNotes.push(`格式提醒：${longPoints.slice(0, 3).map(point => point.start).join("、")}${longPoints.length > 3 ? `等 ${longPoints.length} 項` : ""}重點項超過 2 行；每個重點項寫一到兩行（含編號約 35 字以內），內容多就拆成更多重點項（各自編號、各成一段），不刪採分點。`);
    // A level split into one lone sub-item ("(四)…" over a single "1.") is not a list: merge it up or add a second item.
    const children = new Map<number, { level: number; count: number; first: number }>();
    const parents: Array<{ level: number; order: number }> = [];
    for (const item of hierarchyItems) {
      const { level } = item.numbering;
      while (parents.length && parents.at(-1)!.level >= level) parents.pop();
      const parent = parents.at(-1);
      const entry = parent && children.get(parent.order);
      if (parent && !entry) children.set(parent.order, { level, count: 1, first: item.order });
      else if (entry && entry.level === level) entry.count++;
      parents.push({ level, order: item.order });
    }
    const lone = [...children.values()].filter(entry => entry.count === 1);
    if (lone.length) bookNotes.push(`格式提醒：${lone.slice(0, 3).map(entry => start(firstText(paragraphs[entry.first]))).join("、")}${lone.length > 3 ? `等 ${lone.length} 處` : ""}是上一層底下唯一的子項；子項至少兩項才分層，只有一項就併回上一層的內文或再補一項。`);
    if (levels.size > 4) bookNotes.push(`格式提醒：編號用了 ${levels.size} 層；最多四層 一、→(一)→1.→⑴，儘量不寫到 a.b.c.，請合併最深一層或改寫成句子。`);
    // 50招 p.8: one 大標 per point. Body text between the lead and closing sections needs its own heading.
    const bodyText = (section: typeof answer.sections[number]) => (section.paragraphs?.length ? section.paragraphs.map(p => p.text).join("") : section.text ?? "").trim();
    // Empty sections are skipped so a trailing blank one does not turn the real closing into "middle" body text.
    const ordered = [...answer.sections].sort((a, b) => a.order - b.order).filter(section => section.heading?.trim() || bodyText(section));
    // A section opening with its own (一)/一、 item carries the 大標 inline (50招 p.204 「最充實」 format).
    const headless = ordered.slice(1, -1).filter(section => !section.heading?.trim() && bodyText(section)
      && !((classifyNumbering(bodyText(section))?.level ?? 9) <= 3));
    for (const section of headless) bookHeadless.add(section.id);
    if (headless.length) bookNotes.push(`格式提醒：${headless.map(section => start(bodyText(section))).join("、")}在本文中卻沒有大標；本文每個考點請下「一、○○：」標題：用 replace_text 對該節帶 heading 即可（內文照舊，不必新增或搬移節）；若只是上一點的延續就併入上一節。標題獨佔一行會多佔行，因此超頁時精簡該節內文，不要為了省行而不下標題。`);
    // Several numbered items run together in one paragraph ("(1)…。(2)…") should each start their own paragraph.
    // Arabic 1./(1) peers are reported by layoutQualityNotes' "併在同一段" note; this one covers (一)-level peers.
    const packed = paragraphs.filter(paragraph => !paragraph.isHeading && classifyNumbering(firstText(paragraph))
      && /[。；;][」』）)]*\s*[（(][一二三四五六七八九十]+[）)]/u.test(paragraph.text));
    if (packed.length) bookNotes.push(`格式提醒：${packed.map(paragraph => start(paragraph.text)).join("、")}一段內有多個編號項；請每項各成一段（paragraphs），不改內容。`);
    // Full-width brackets are wider than the two cells left of the text line, so their text cannot align there.
    if (hierarchyItems.some(item => item.numbering.prefix.trimStart().startsWith("（"))) bookNotes.push("格式提醒：括號編號請用半形「(一)」與「⑴」；全形「（一）」太寬，內文無法對齊第 3 格。只改括號，不改內容。");
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
