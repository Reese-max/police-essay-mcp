import { randomUUID } from "node:crypto";
import { z } from "zod";

function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

export const overflowPolicySchema = z.enum(["compress", "report", "reject"]);

export const alignmentSchema = z.enum(["left", "right", "justify", "distributed"]);

export const paragraphFormatSchema = z.object({
  firstLineIndent: z.number().int().min(0).default(0),
  leftIndent: z.number().int().min(0).default(0),
  rightIndent: z.number().int().min(0).default(0),
  alignment: alignmentSchema.default("left"),
  spaceBeforeLines: z.number().int().min(0).default(0),
  spaceAfterLines: z.number().int().min(0).default(0),
  tabSize: z.number().int().positive().default(4),
  bold: z.boolean().default(false),
  italic: z.boolean().default(false),
});

export const paragraphFormatInputSchema = paragraphFormatSchema.partial();
export type ParagraphFormat = z.infer<typeof paragraphFormatSchema>;
export type ParagraphFormatInput = z.input<typeof paragraphFormatInputSchema>;

export const headingStyleSchema = z.object({
  bold: z.boolean().default(true),
  italic: z.boolean().default(false),
  numbered: z.boolean().default(false),
  numbering: z.enum(["chinese", "arabic"]).default("chinese"),
  separator: z.string().min(1).max(5).default("、"),
  firstLineIndent: z.number().int().min(0).default(0),
  leftIndent: z.number().int().min(0).default(0),
  rightIndent: z.number().int().min(0).default(0),
  alignment: alignmentSchema.default("left"),
  spaceBeforeLines: z.number().int().min(0).default(0),
  spaceAfterLines: z.number().int().min(0).default(0),
  tabSize: z.number().int().positive().default(4),
});

export const headingStyleInputSchema = headingStyleSchema.partial();
export type HeadingStyle = z.infer<typeof headingStyleSchema>;
export type HeadingStyleInput = z.input<typeof headingStyleInputSchema>;

export const answerParagraphSchema = z.object({
  text: z.string().max(100_000),
  format: paragraphFormatInputSchema.optional(),
});

export type AnswerParagraph = z.infer<typeof answerParagraphSchema>;
export type AnswerParagraphInput = z.input<typeof answerParagraphSchema>;

export const templateSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  paperSize: z.literal("A4"),
  paperProfile: z.literal("original_166").optional(),
  pages: z.number().int().positive(),
  linesPerPage: z.number().int().positive(),
  columns: z.number().int().positive(),
  overflowPolicy: overflowPolicySchema,
  fontFamily: z.string().min(1),
  fontSizePt: z.number().positive(),
  lineHeightPt: z.number().positive(),
  paragraphDefaults: paragraphFormatInputSchema.optional(),
  headingDefaults: headingStyleInputSchema.optional(),
  marginsMm: z.object({
    top: z.number().nonnegative(),
    right: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    left: z.number().nonnegative(),
  }),
});

export type AnswerTemplate = z.infer<typeof templateSchema>;

const answerSectionInputBaseSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
  heading: z.string().max(200).optional(),
  text: z.string().max(100_000).optional(),
  paragraphs: z.array(answerParagraphSchema).max(1_000).optional(),
  paragraphFormat: paragraphFormatInputSchema.optional(),
  headingStyle: headingStyleInputSchema.optional(),
  required: z.boolean().default(false),
  priority: z.number().int().min(1).max(5).default(3),
  compressible: z.number().int().min(0).max(5).default(2),
});

export const answerSectionInputSchema = answerSectionInputBaseSchema.superRefine((input, context) => {
  if (input.text === undefined && (input.paragraphs?.length ?? 0) === 0) {
    context.addIssue({
      code: "custom",
      path: ["text"],
      message: "必須提供 text，或提供至少一個 paragraphs 項目。",
    });
  }

  if (input.text !== undefined && input.paragraphs !== undefined) {
    const paragraphText = input.paragraphs.map((paragraph) => paragraph.text).join("\n");
    if (normalizeNewlines(input.text) !== normalizeNewlines(paragraphText)) {
      context.addIssue({
        code: "custom",
        path: ["paragraphs"],
        message: "text 與 paragraphs 內容不一致；請只提供其中一種，或讓兩者完全相同。",
      });
    }
  }
});

export const answerSectionSchema = answerSectionInputBaseSchema.extend({
  text: z.string().max(100_000),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  order: z.number().int().nonnegative(),
});

export type AnswerSection = z.infer<typeof answerSectionSchema>;
export type AnswerSectionInput = z.input<typeof answerSectionInputSchema>;

export const paragraphFormatPatchSchema = z.object({
  index: z.number().int().nonnegative(),
  format: paragraphFormatInputSchema,
});

export type ParagraphFormatPatch = z.input<typeof paragraphFormatPatchSchema>;

export const answerDocumentSchema = z.object({
  id: z.string().regex(/^ans_[A-Za-z0-9-]+$/),
  templateId: z.string().min(1),
  title: z.string().min(1).max(300),
  question: z.string().max(10_000).optional(),
  sections: z.array(answerSectionSchema).max(100),
  version: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type AnswerDocument = z.infer<typeof answerDocumentSchema>;

export interface LayoutLine {
  globalLine: number;
  page: number;
  lineOnPage: number;
  text: string;
  sectionId: string;
  displayWidth: number;
  paragraphIndex: number;
  isHeading: boolean;
  isSpacer: boolean;
  isFirstLineOfParagraph: boolean;
  isLastLineOfParagraph: boolean;
  format: ParagraphFormat;
}

export interface PageLayout {
  page: number;
  linesUsed: number;
  capacity: number;
  lines: LayoutLine[];
}

export interface CompressionHint {
  rank: number;
  sectionId: string;
  heading?: string;
  currentLines: number;
  priority: number;
  compressible: number;
  protected: boolean;
  reason: string;
}

export interface LayoutReport {
  templateId: string;
  pagesConfigured: number;
  linesPerPage: number;
  columns: number;
  capacity: number;
  totalLines: number;
  pagesUsed: number;
  overflowLines: number;
  remainingLines: number;
  fits: boolean;
  status: "ok" | "overflow";
  pageUsage: Array<{ page: number; linesUsed: number; capacity: number }>;
  lines: LayoutLine[];
  compressionHints: CompressionHint[];
}

export const layoutLineSchema = z.object({
  globalLine: z.number().int().positive(),
  page: z.number().int().positive(),
  lineOnPage: z.number().int().positive(),
  text: z.string(),
  sectionId: z.string(),
  displayWidth: z.number().int().nonnegative(),
  paragraphIndex: z.number().int().nonnegative(),
  isHeading: z.boolean(),
  isSpacer: z.boolean(),
  isFirstLineOfParagraph: z.boolean(),
  isLastLineOfParagraph: z.boolean(),
  format: paragraphFormatSchema,
});

export const layoutReportSchema = z.object({
  templateId: z.string(),
  pagesConfigured: z.number().int().positive(),
  linesPerPage: z.number().int().positive(),
  columns: z.number().int().positive(),
  capacity: z.number().int().positive(),
  totalLines: z.number().int().nonnegative(),
  pagesUsed: z.number().int().positive(),
  overflowLines: z.number().int().nonnegative(),
  remainingLines: z.number().int().nonnegative(),
  fits: z.boolean(),
  status: z.enum(["ok", "overflow"]),
  pageUsage: z.array(z.object({
    page: z.number().int().positive(),
    linesUsed: z.number().int().nonnegative(),
    capacity: z.number().int().positive(),
  })),
  lines: z.array(layoutLineSchema),
  compressionHints: z.array(z.object({
    rank: z.number().int().positive(),
    sectionId: z.string(),
    heading: z.string().optional(),
    currentLines: z.number().int().nonnegative(),
    priority: z.number().int().min(1).max(5),
    compressible: z.number().int().min(0).max(5),
    protected: z.boolean(),
    reason: z.string(),
  })),
});

export interface AnswerSnapshot {
  [key: string]: unknown;
  answer: AnswerDocument;
  layout: LayoutReport;
}

export function createId(prefix: "ans" | "sec"): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeSection(
  input: AnswerSectionInput,
  order: number,
): AnswerSection {
  const sourceText = input.text ?? input.paragraphs?.map((paragraph) => paragraph.text).join("\n") ?? "";
  const sourceParagraphs = input.paragraphs?.length
    ? input.paragraphs
    : sourceText.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((text): AnswerParagraphInput => ({ text }));
  const paragraphs = sourceParagraphs.flatMap((paragraph) =>
    paragraph.text
      .replaceAll("\r\n", "\n")
      .replaceAll("\r", "\n")
      .split("\n")
      .map((text) => ({ text, format: paragraph.format })),
  );
  return answerSectionSchema.parse({
    id: input.id ?? createId("sec"),
    heading: input.heading,
    text: paragraphs.map((paragraph) => paragraph.text).join("\n"),
    paragraphs,
    paragraphFormat: input.paragraphFormat,
    headingStyle: input.headingStyle,
    required: input.required ?? false,
    priority: input.priority ?? 3,
    compressible: input.compressible ?? 2,
    order,
  });
}

export function replaceSectionContent(
  section: AnswerSection,
  input: {
    text?: string;
    paragraphs?: AnswerParagraphInput[];
    heading?: string;
  },
): AnswerSection {
  return normalizeSection(
    {
      id: section.id,
      heading: input.heading,
      text: input.text,
      paragraphs: input.paragraphs,
      paragraphFormat: section.paragraphFormat,
      headingStyle: section.headingStyle,
      required: section.required,
      priority: section.priority,
      compressible: section.compressible,
    },
    section.order,
  );
}

export function updateSectionFormatting(
  section: AnswerSection,
  input: {
    paragraphFormat?: ParagraphFormatInput;
    headingStyle?: HeadingStyleInput;
    paragraphFormats?: ParagraphFormatPatch[];
  },
): AnswerSection {
  const sourceParagraphs = section.paragraphs?.length
    ? section.paragraphs
    : section.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((text): AnswerParagraph => ({ text }));
  const overrides = new Map<number, ParagraphFormatInput>();
  for (const patch of input.paragraphFormats ?? []) {
    if (patch.index >= sourceParagraphs.length) {
      throw new Error(`paragraphFormats index ${patch.index} 超出段落數量 ${sourceParagraphs.length}。`);
    }
    if (overrides.has(patch.index)) {
      throw new Error(`paragraphFormats index ${patch.index} 重複。`);
    }
    overrides.set(patch.index, patch.format);
  }

  const paragraphs = sourceParagraphs.map((paragraph, index) => {
    const override = overrides.get(index);
    return override
      ? { text: paragraph.text, format: { ...paragraph.format, ...override } }
      : { text: paragraph.text, format: paragraph.format };
  });

  return normalizeSection(
    {
      id: section.id,
      heading: section.heading,
      text: section.text,
      paragraphs,
      paragraphFormat: input.paragraphFormat === undefined
        ? section.paragraphFormat
        : { ...section.paragraphFormat, ...input.paragraphFormat },
      headingStyle: input.headingStyle === undefined
        ? section.headingStyle
        : { ...section.headingStyle, ...input.headingStyle },
      required: section.required,
      priority: section.priority,
      compressible: section.compressible,
    },
    section.order,
  );
}

export const textEditSchema = z.object({
  find: z.string().min(1).max(2_000).refine((value) => !/[\r\n]/.test(value), "find 不可包含換行；跨段落的修改請改用 replace_text。"),
  replace: z.string().max(10_000),
  sectionId: z.string().min(1).optional(),
  occurrence: z.number().int().positive().optional(),
  replaceAll: z.boolean().optional(),
}).refine((edit) => !(edit.occurrence !== undefined && edit.replaceAll), {
  path: ["occurrence"],
  message: "occurrence 與 replaceAll 只能擇一。",
});

export type TextEdit = z.input<typeof textEditSchema>;

/** Upper bound for an answer's heading and paragraph text after edit_text, in UTF-16 units. */
export const MAX_EDITED_TEXT_LENGTH = 300_000;

function clipText(text: string, max = 40): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

/** Spaces and half-width punctuation removed or widened, to explain a near miss. */
function looseText(text: string): string {
  const wide: Record<string, string> = { ",": "，", ";": "；", ":": "：", "?": "？", "!": "！", "(": "（", ")": "）" };
  return text.replace(/\s+/g, "").replace(/[,;:?!()]/g, (char) => wide[char]);
}

/**
 * Applies exact find/replace edits to headings and paragraphs, in order and all-or-nothing.
 * A find that matches more than once must name occurrence or replaceAll; a newline in replace
 * splits the paragraph (each part keeps its format) and emptying a paragraph removes it.
 */
export function applyTextEdits(sections: AnswerSection[], edits: TextEdit[]): { sections: AnswerSection[]; replacements: number[] } {
  const working = sections.map((section) => ({
    section,
    heading: section.heading,
    paragraphs: (section.paragraphs?.length
      ? section.paragraphs
      : section.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n").map((text): AnswerParagraph => ({ text })))
      .map((paragraph) => ({ ...paragraph, original: paragraph.text })),
    changed: false,
  }));
  let totalLength = working.reduce((sum, item) => sum + (item.heading?.length ?? 0)
    + item.paragraphs.reduce((count, paragraph) => count + paragraph.text.length, 0), 0);
  const replacements = edits.map((edit, editIndex) => {
    const label = `第 ${editIndex + 1} 項修改`;
    const scope = working.filter((item) => edit.sectionId === undefined || item.section.id === edit.sectionId);
    if (scope.length === 0) throw new Error(`${label}：找不到 sectionId ${edit.sectionId}。`);
    const matches: Array<{ item: typeof working[number]; paragraph: number | "heading"; start: number; text: string }> = [];
    for (const item of scope) {
      const scan = (text: string, paragraph: number | "heading") => {
        for (let at = text.indexOf(edit.find); at >= 0; at = text.indexOf(edit.find, at + edit.find.length)) {
          matches.push({ item, paragraph, start: at, text });
        }
      };
      if (item.heading) scan(item.heading, "heading");
      item.paragraphs.forEach((paragraph, index) => scan(paragraph.text, index));
    }
    if (matches.length === 0) {
      const near = scope.some((item) => [item.heading ?? "", ...item.paragraphs.map((paragraph) => paragraph.text)]
        .some((text) => looseText(text).includes(looseText(edit.find))));
      throw new Error(`${label}：找不到「${clipText(edit.find)}」${edit.sectionId ? `（限區塊 ${edit.sectionId}）` : ""}。`
        + (near ? "忽略空白與全形／半形標點後可以找到，請照原文的空白與標點填寫 find。" : "find 必須與目前內容逐字相同；請先 read_answer 確認原文。"));
    }
    let selected = matches;
    if (edit.occurrence !== undefined) {
      if (edit.occurrence > matches.length) throw new Error(`${label}：「${clipText(edit.find)}」只出現 ${matches.length} 次，沒有第 ${edit.occurrence} 處。`);
      selected = [matches[edit.occurrence - 1]];
    } else if (!edit.replaceAll && matches.length > 1) {
      const places = matches.slice(0, 5).map((match, index) => {
        const where = match.paragraph === "heading" ? "標題" : `第 ${match.paragraph + 1} 段`;
        const chars = Array.from(match.text);
        const start = Array.from(match.text.slice(0, match.start)).length;
        const length = Array.from(edit.find).length;
        const before = chars.slice(Math.max(0, start - 10), start).join("");
        const after = chars.slice(start + length, start + length + 10).join("");
        return `${index + 1}) 「${match.item.heading ?? match.item.section.id}」${where}：…${before}【${clipText(edit.find, 20)}】${after}…`;
      });
      throw new Error(`${label}：「${clipText(edit.find)}」出現 ${matches.length} 次：${places.join("；")}${matches.length > 5 ? "；…" : ""}。`
        + "請加長 find 讓它只對應一處，或指定 occurrence（第幾處，依上列順序）或 replaceAll=true。");
    }
    // Chained replaceAll edits could otherwise grow the text geometrically before any save limit applies.
    totalLength += selected.length * (edit.replace.length - edit.find.length);
    if (totalLength > MAX_EDITED_TEXT_LENGTH) {
      throw new Error(`${label}：修改後全文會超過 ${MAX_EDITED_TEXT_LENGTH} 字元的上限。`);
    }
    // Later matches first, so earlier offsets in the same text stay valid.
    for (const match of [...selected].reverse()) {
      const { item, paragraph, start } = match;
      const replaceIn = (text: string) => text.slice(0, start) + edit.replace + text.slice(start + edit.find.length);
      if (paragraph === "heading") {
        if (/[\r\n]/.test(edit.replace)) throw new Error(`${label}：標題的 replace 不可包含換行。`);
        const heading = replaceIn(item.heading ?? "");
        item.changed ||= heading !== item.heading;
        item.heading = heading;
      } else {
        const text = replaceIn(item.paragraphs[paragraph].text);
        item.changed ||= text !== item.paragraphs[paragraph].text;
        item.paragraphs[paragraph].text = text;
      }
    }
    return selected.length;
  });

  const updated = working.map((item) => {
    if (!item.changed) return item.section;
    const paragraphs = item.paragraphs
      .filter((paragraph) => paragraph.text !== "" || paragraph.original === "")
      .flatMap((paragraph) => paragraph.text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n")
        .map((text) => ({ text, format: paragraph.format })));
    if (paragraphs.length === 0) {
      throw new Error(`修改會清空區塊「${item.heading || item.section.heading || item.section.id}」的全部內容；要刪除整個區塊請用 delete_text。`);
    }
    return normalizeSection({
      id: item.section.id,
      heading: item.heading || undefined,
      paragraphs,
      paragraphFormat: item.section.paragraphFormat,
      headingStyle: item.section.headingStyle,
      required: item.section.required,
      priority: item.section.priority,
      compressible: item.section.compressible,
    }, item.section.order);
  });
  if (!working.some((item) => item.changed) || JSON.stringify(updated) === JSON.stringify(sections)) {
    throw new Error("修改後的內容與原文相同，沒有需要儲存的變更。");
  }
  return { sections: updated, replacements };
}

export function createAnswerDocument(input: {
  templateId: string;
  title: string;
  question?: string;
  sections?: AnswerSectionInput[];
}): AnswerDocument {
  const createdAt = nowIso();
  return answerDocumentSchema.parse({
    id: createId("ans"),
    templateId: input.templateId,
    title: input.title,
    question: input.question,
    sections: (input.sections ?? []).map(normalizeSection),
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

export function withUpdatedSections(
  answer: AnswerDocument,
  sections: AnswerSection[],
): AnswerDocument {
  return answerDocumentSchema.parse({
    ...answer,
    sections: sections.map((section, index) => ({ ...section, order: index })),
    version: answer.version + 1,
    updatedAt: nowIso(),
  });
}

export function assertExpectedVersion(
  answer: AnswerDocument,
  expectedVersion: number | undefined,
): void {
  if (expectedVersion !== undefined && expectedVersion !== answer.version) {
    throw new Error(
      `Version conflict: expected ${expectedVersion}, current version is ${answer.version}. Read the answer again before editing.`,
    );
  }
}


