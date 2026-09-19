import { randomUUID } from "node:crypto";
import { z } from "zod";

export const overflowPolicySchema = z.enum(["compress", "report", "reject"]);

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
  marginsMm: z.object({
    top: z.number().nonnegative(),
    right: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    left: z.number().nonnegative(),
  }),
});

export type AnswerTemplate = z.infer<typeof templateSchema>;

export const answerSectionInputSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/).optional(),
  heading: z.string().max(200).optional(),
  text: z.string().max(100_000),
  required: z.boolean().default(false),
  priority: z.number().int().min(1).max(5).default(3),
  compressible: z.number().int().min(0).max(5).default(2),
});

export const answerSectionSchema = answerSectionInputSchema.extend({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  order: z.number().int().nonnegative(),
});

export type AnswerSection = z.infer<typeof answerSectionSchema>;
export type AnswerSectionInput = z.input<typeof answerSectionInputSchema>;

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
  return answerSectionSchema.parse({
    id: input.id ?? createId("sec"),
    heading: input.heading,
    text: input.text,
    required: input.required ?? false,
    priority: input.priority ?? 3,
    compressible: input.compressible ?? 2,
    order,
  });
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
