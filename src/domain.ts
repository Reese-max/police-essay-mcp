import { randomUUID } from "node:crypto";
import { z } from "zod";

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

export const answerSectionInputSchema = answerSectionInputBaseSchema.refine(
  (input) => input.text !== undefined || (input.paragraphs?.length ?? 0) > 0,
  { message: "必須提供 text，或提供至少一個 paragraphs 項目。" },
);

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
  sections: z.array(answerSectionSchema),
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
  sectionId: string;
  heading?: string;
  currentLines: number;
  priority: number;
  compressible: number;
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
    sectionId: z.string(),
    heading: z.string().optional(),
    currentLines: z.number().int().nonnegative(),
    priority: z.number().int().min(1).max(5),
    compressible: z.number().int().min(0).max(5),
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
    text: string;
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

