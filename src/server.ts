import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isRetryableExportError, publicExportMessage } from "./export-errors.js";
import { z } from "zod";
import {
  answerDocumentSchema, examQuestionSchema, examFormatsSchema, type ExamPlan,
  MAX_ANSWER_BYTES,
  layoutOptionsSchema,
  answerParagraphSchema,
  answerSectionInputSchema,
  answerSectionSchema as storedSectionSchema,
  applyTextEdits,
  createAnswerDocument,
  assertExpectedVersion,
  normalizeSection,
  paragraphFormatPatchSchema,
  replaceSectionContent,
  updateSectionFormatting,
  type AnswerDocument,
  type AnswerSection,
  type AnswerSectionInput,
  type AnswerSnapshot,
  type AnswerTemplate,
  layoutReportSchema,
  headingStyleInputSchema,
  paragraphFormatInputSchema,
  templateSchema,
  textEditSchema,
} from "./domain.js";
import { describeChanges } from "./changes.js";
import { renumberItems } from "./numbering.js";
import { describeLines, describeTargetChanges, planLines, layoutWarnings } from "./planning.js";
import { answerFileName, describeAnswerList, describeInfoChanges, encodeStrict, sortAnswers, type ExportFormat } from "./answer-info.js";
import { exportDocx, exportPdf, exportText, exportPdfBundle, exportDocxBundle, exportParagraphTextBundle, outputPageCount, withTemporaryExport } from "./exporters.js";
import { layoutSections, summarizeLayout } from "./layout.js";
import { FileStore, isStoreNotFound, isStoreConflict, conflictBackoff, safeId, type EssayStore } from "./storage.js";
import { originalPaperPreview } from "./original-paper.js";
import { ANSWER_SHEET_WIDGET_URI, POLICE_ESSAY_WIDGET_HTML } from "./widget.js";

import { examProgress } from "./exam-progress.js";
import { reviewPlanSchema } from "./review-schema.js";
import { reviewAnswer, reviewFingerprint } from "./review.js";
import { toolScope } from "./oauth.js";

export const DEFAULT_TEMPLATE_ID = "police_information_essay_165";

const responseDetailSchema = z.enum(["summary", "full"]).default("summary").describe("Full snapshot or compact summary.");
const expectedVersionSchema = z.number().int().positive().optional();
const answerIdSchema = z.string().regex(/^ans_[A-Za-z0-9-]+$/);

// tools/list sends every outputSchema on each connection; inlining the full nested answer/layout
// schemas made it ~262 KB. Output schemas keep the key fields typed and let nested detail
// (paragraphs, formats, rendered lines) pass through unchanged in structuredContent.
const answerSummarySchema = answerDocumentSchema.pick({ id: true, templateId: true, title: true, version: true }).loose();
const layoutSummarySchema = layoutReportSchema.pick({
  capacity: true, totalLines: true, pagesUsed: true, overflowLines: true, remainingLines: true, fits: true, status: true,
}).loose();
const sectionSummarySchema = storedSectionSchema.pick({ id: true, heading: true, order: true }).loose();
const templateSummarySchema = templateSchema.pick({ id: true, name: true, pages: true, linesPerPage: true, paperProfile: true }).loose();

const snapshotOutputSchema = z.object({
  answer: answerSummarySchema,
  layout: layoutSummarySchema,
}).loose();

// Loose: check_layout also returns the lines each section uses against its target.
const layoutOutputSchema = z.object({
  answerId: answerIdSchema,
  version: z.number().int().positive(),
  layout: layoutSummarySchema,
}).loose();

const sectionOutputSchema = z.object({
  section: sectionSummarySchema,
  answer: answerSummarySchema,
  layout: layoutSummarySchema,
}).loose();

const replacementContentSchema = z.object({
  newText: z.string().max(100_000).optional(),
  paragraphs: z.array(answerParagraphSchema).max(1_000).optional(),
  heading: z.string().max(200).nullable().optional(),
}).superRefine((input, context) => {
  if (input.newText === undefined && (input.paragraphs?.length ?? 0) === 0) {
    context.addIssue({ code: "custom", path: ["newText"], message: "必須提供 newText，或提供至少一個 paragraphs 項目。" });
  }
  if (input.newText !== undefined && input.paragraphs !== undefined) {
    const paragraphText = input.paragraphs.map((paragraph) => paragraph.text).join("\n");
    const normalize = (value: string) => value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    if (normalize(input.newText) !== normalize(paragraphText)) {
      context.addIssue({ code: "custom", path: ["paragraphs"], message: "newText 與 paragraphs 內容不一致。" });
    }
  }
});

const formattingPayloadSchema = z.object({
  paragraphFormat: paragraphFormatInputSchema.optional(),
  headingStyle: headingStyleInputSchema.optional(),
  paragraphFormats: z.array(paragraphFormatPatchSchema).max(1_000).optional(),
}).superRefine((input, context) => {
  if (input.paragraphFormat === undefined && input.headingStyle === undefined && (input.paragraphFormats?.length ?? 0) === 0) {
    context.addIssue({ code: "custom", path: [], message: "至少提供一項格式修改。" });
  }
});

/** The write tools preview_change can preview; their own argument names are reused unchanged. */
const PREVIEW_OPERATIONS = ["write_answer", "replace_text", "format_section", "insert_text", "delete_text", "edit_text",
  "move_section", "renumber_items"] as const;
type PreviewOperation = typeof PREVIEW_OPERATIONS[number];

const sectionIdSchema = z.string().min(1);
const textEditsSchema = z.array(textEditSchema).min(1).max(50);
const textModeSchema = z.enum(["paper", "paragraphs"]).default("paper").describe("TXT only: paper grid or unwrapped paragraphs.");
const examIdSchema = z.string().regex(/^exam_[A-Za-z0-9-]+$/);
const createFields = {
  examId: examIdSchema.optional(),
  layoutOptions: layoutOptionsSchema.optional().describe("Whole-word Latin wrapping and keeping headings with their first body line; new answers default to on."),
  templateId: z.string().default(DEFAULT_TEMPLATE_ID), title: z.string().min(1).max(300),
  question: z.string().max(10_000).optional(), exam: z.string().min(1).max(100).optional(),
  questionNo: z.number().int().min(1).max(20).optional(),
  lineTargets: z.array(z.object({ sectionId: sectionIdSchema, lines: z.number().int().min(1).max(200) })).max(100).optional()
    .describe("sectionId must equal an explicit id given in sections."),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{8,128}$/).optional()
    .describe("Retry-safe: the same key and request return the existing answer"),
};
const createRequestSchema = z.strictObject({ ...createFields, sections: z.array(answerSectionInputSchema).max(100).default([]) });
const batchCreateSchema = z.strictObject({ ...createFields,
  sections: z.array(z.record(z.string(), z.unknown())).max(100).default([]).describe("Same section objects as create_answer.sections."),
});
// Preserve the received JSON for hashing and indexed validation; prepareCreate applies the real schema.
function rawCreateInput<T extends z.ZodType>(schema: T) {
  const { $schema: _schema, ...json } = z.toJSONSchema(schema, { io: "input" });
  return z.unknown().meta(json) as z.ZodType<z.input<T>>;
}
type CreateRequest = z.infer<typeof createRequestSchema>;
type PreparedCreate = { current: AnswerSnapshot; replayed?: true; examId?: string; examQuestionNo?: number; keyHash?: string; requestHash?: string; linkPending?: true; message?: string };
class CreateError extends Error {
  constructor(readonly code: "INVALID_INPUT" | "TEMPLATE_NOT_FOUND" | "LAYOUT_INVALID" | "IDEMPOTENCY_KEY_REUSED", message: string) {
    super(`${code}：${message}`);
  }
}
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

async function createReplay(store: EssayStore, answer: AnswerDocument): Promise<PreparedCreate | undefined> {
  if (!answer.createRequestHash) return;
  let existing: AnswerDocument;
  try { existing = await store.getAnswer(answer.id); }
  catch (error) { if (isStoreNotFound(error)) return; throw error; }
  if (existing.createRequestHash !== answer.createRequestHash) {
    throw new CreateError("IDEMPOTENCY_KEY_REUSED", `此 idempotencyKey 已用於不同的建立請求（${answer.id}）。要建立另一份答案請換新的 idempotencyKey；要取回原答案請用 read_answer ${answer.id}。`);
  }
  let template: AnswerTemplate;
  try { template = await store.getTemplate(existing.templateId); }
  catch (error) {
    if (isStoreNotFound(error)) throw new CreateError("TEMPLATE_NOT_FOUND", `此 idempotencyKey 的既有答案 ${existing.id}：${errorMessage(error)}`);
    throw error;
  }
  try { return { current: snapshot({ ...existing, sections: inLayoutOrder(existing.sections) }, template), replayed: true }; }
  catch (error) { throw new CreateError("LAYOUT_INVALID", `此 idempotencyKey 的既有答案 ${existing.id}：${errorMessage(error)}`); }
}

async function prepareCreate(store: EssayStore, input: unknown, defaultQuestionNo?: number): Promise<PreparedCreate> {
  const parsed = createRequestSchema.safeParse(input);
  if (!parsed.success) throw new CreateError("INVALID_INPUT", parsed.error.issues.map(issue => `${issue.path.join(".") || "輸入"}：${issue.message}`).join("；"));
  const request = parsed.data;
  const keyHash = request.examId && request.idempotencyKey ? sha256(request.idempotencyKey) : undefined;
  let savedCreate: AnswerDocument | undefined;
  // An omitted template on a retry follows the saved answer, even if the default changed.
  // The full request hash below still rejects a changed payload or explicit template.
  if ((input as CreateRequest).templateId === undefined && request.idempotencyKey) {
    let savedId = request.examId ? undefined : `ans_idem-${sha256(request.idempotencyKey).slice(0, 40)}`;
    if (request.examId && keyHash) {
      const plan = await store.getExam(request.examId);
      const entry = plan.createRequests?.[keyHash];
      savedId = entry && plan.questions.find(q => q.questionNo === entry.questionNo)?.answerId;
    }
    if (savedId) try {
      savedCreate = await store.getAnswer(savedId);
      if (request.examId) request.templateId = savedCreate.templateId;
    }
    catch (error) { if (!isStoreNotFound(error)) throw error; }
  }
  const createRequestHash = (templateId = request.templateId) => {
    const { title, question, exam, questionNo, lineTargets } = request;
    const received = input as CreateRequest;
    return sha256(canonicalJson({ templateId, title, question, exam, questionNo, lineTargets,
      sections: received.sections ?? [], ...(received.layoutOptions === undefined ? {} : { layoutOptions: received.layoutOptions }) }));
  };
  if (savedCreate && !request.examId) {
    // The former default also lets a damaged stored template reach the existing replay diagnostics.
    const replayTemplate = [request.templateId, savedCreate.templateId, "police_information_essay"]
      .find(templateId => savedCreate!.createRequestHash === createRequestHash(templateId));
    if (replayTemplate) request.templateId = replayTemplate;
    const replay = await createReplay(store, { ...savedCreate, createRequestHash: createRequestHash() });
    if (replay) return replay;
  }
  const requestHash = keyHash ? sha256(canonicalJson({ ...(input as CreateRequest), templateId: request.templateId, sections: (input as CreateRequest).sections ?? [] })) : undefined;
  if (keyHash) for (const exam of await store.listExams()) {
    if (exam.createRequests?.[keyHash] && exam.createRequests[keyHash].requestHash !== requestHash)
      throw new CreateError("IDEMPOTENCY_KEY_REUSED", "此 idempotencyKey 已用於不同的建立請求；請換新的 key 或 read_answer 取回既有答案。");
  }
  if (request.examId) {
    const plan = await store.getExam(request.examId);
    if (keyHash && plan.createRequests?.[keyHash]) request.questionNo ??= plan.createRequests[keyHash].questionNo;
    request.questionNo ??= defaultQuestionNo;
    const ordered = [...plan.questions].sort((a, b) => a.questionNo - b.questionNo);
    let question = ordered.find(q => q.questionNo === request.questionNo);
    if (request.questionNo === undefined) {
      for (const q of ordered) {
        if (!q.answerId) { question = q; break; }
        try { await store.getAnswer(q.answerId); } catch (error) { if (!isStoreNotFound(error)) throw error; question = q; break; }
      }
      question ??= ordered[0];
    }
    if (!question) throw new CreateError("INVALID_INPUT", "questionNo 不在考試計畫中。");
    request.exam ??= plan.title; request.questionNo ??= question.questionNo; request.question ??= question.question;
    if (question.answerId) {
      try { return { current: await loadSnapshot(store, question.answerId), replayed: true, examId: plan.id, examQuestionNo: question.questionNo, keyHash, requestHash }; }
      catch (error) { if (!isStoreNotFound(error)) throw error; }
    }
  }
  const { templateId, title, question, exam, questionNo, lineTargets, sections, idempotencyKey, layoutOptions } = request;
  try { safeId(templateId); }
  catch { throw new CreateError("INVALID_INPUT", "templateId 不是有效的識別碼。"); }
  let template: AnswerTemplate;
  try { template = await store.getTemplate(templateId); }
  catch (error) { if (isStoreNotFound(error)) throw new CreateError("TEMPLATE_NOT_FOUND", `找不到模板 ${templateId}。`); throw error; }
  let answer: AnswerDocument;
  try {
    answer = { ...createAnswerDocument({ templateId, title, question, sections }), exam, questionNo,
      layoutOptions: { wholeLatinWords: true, keepHeadingWithNext: true, avoidPunctuationOnlyLines: true, ...layoutOptions },
      ...(lineTargets ? { lineTargets: Object.fromEntries(lineTargets.map(({ sectionId, lines }) => [sectionId, lines])) } : {}) };
    const targetIds = new Set<string>();
    for (const { sectionId } of lineTargets ?? []) {
      if (!sections.some(section => section.id === sectionId)) throw new Error(`找不到 sectionId：${sectionId}；lineTargets 必須參照 sections 明確提供的 id。`);
      if (targetIds.has(sectionId)) throw new Error(`重複的 lineTargets sectionId：${sectionId}。`);
      targetIds.add(sectionId);
    }
    ensureUniqueSectionIds(answer.sections);
  } catch (error) { throw new CreateError("INVALID_INPUT", errorMessage(error)); }
  let current: AnswerSnapshot;
  try { current = snapshot(answer, template); }
  catch (error) { throw new CreateError("LAYOUT_INVALID", errorMessage(error)); }
  if (idempotencyKey && !request.examId) {
    answer.id = `ans_idem-${sha256(idempotencyKey).slice(0, 40)}`;
    // Only templateId gets its default before hashing; sections retain input fields and newlines.
    current.answer = { ...answer, createRequestHash: createRequestHash() };
    const replay = await createReplay(store, current.answer);
    if (replay) return replay;
  }
  if (Buffer.byteLength(JSON.stringify(current.answer)) > MAX_ANSWER_BYTES) throw new CreateError("INVALID_INPUT", "答案超過 700 KiB 文件上限。");
  if (request.examId) {
    current.answer.id = `ans_exam-${sha256(`${request.examId}:${request.questionNo}`).slice(0, 40)}`;
    try { return { current: await loadSnapshot(store, current.answer.id), replayed: true, examId: request.examId, examQuestionNo: request.questionNo, keyHash, requestHash }; }
    catch (error) { if (!isStoreNotFound(error)) throw error; }
  }
  return { current, examId: request.examId, examQuestionNo: request.questionNo, keyHash, requestHash };
}

async function linkExamAnswer(store: EssayStore, examId: string, answer: AnswerDocument, keyHash?: string, requestHash?: string, questionNo = answer.questionNo): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const plan = await store.getExam(examId);
    const question = plan.questions.find(q => q.questionNo === questionNo);
    if (!question) throw new CreateError("INVALID_INPUT", "questionNo 不在考試計畫中。");
    if (keyHash && plan.createRequests?.[keyHash] && plan.createRequests[keyHash].requestHash !== requestHash)
      throw new CreateError("IDEMPOTENCY_KEY_REUSED", "此 idempotencyKey 已用於不同的建立請求。");
    if (question.answerId === answer.id && (!keyHash || plan.createRequests?.[keyHash])) return;
    const updated = { ...plan, ...(keyHash ? { createRequests: { ...plan.createRequests, [keyHash]: { requestHash: requestHash!, questionNo: question.questionNo } } } : {}), updatedAt: new Date().toISOString(), questions: plan.questions.map(q => q === question ? { ...q, answerId: answer.id } : q) };
    try { await store.saveExam(updated, { expectedVersion: plan.version }); return; }
    catch (error) { if (attempt >= 4 || !isStoreConflict(error)) throw error; await conflictBackoff(attempt); }
  }
}

async function linkSavedCreate(store: EssayStore, prepared: PreparedCreate): Promise<PreparedCreate> {
  if (prepared.examId) try {
    await linkExamAnswer(store, prepared.examId, prepared.current.answer, prepared.keyHash, prepared.requestHash, prepared.examQuestionNo);
  } catch (error) {
    if (!isStoreConflict(error)) throw error;
    return { ...prepared, linkPending: true, message: "答案已保存；考試連結待完成。請呼叫 get_exam_progress 或以相同請求重試 create_answer。" };
  }
  return prepared;
}

async function commitCreate(store: EssayStore, prepared: PreparedCreate): Promise<PreparedCreate> {
  if (prepared.examId && prepared.keyHash) {
    for (let attempt = 0; ; attempt++) {
      const plan = await store.getExam(prepared.examId);
      const entry = plan.createRequests?.[prepared.keyHash];
      if (entry) {
        if (entry.requestHash !== prepared.requestHash) throw new CreateError("IDEMPOTENCY_KEY_REUSED", "此 idempotencyKey 已用於不同的建立請求。");
        break;
      }
      try {
        await store.saveExam({ ...plan, updatedAt: new Date().toISOString(), createRequests: { ...plan.createRequests,
          [prepared.keyHash]: { requestHash: prepared.requestHash!, questionNo: prepared.examQuestionNo! } } }, { expectedVersion: plan.version }); break;
      } catch (error) { if (!isStoreConflict(error)) throw error;
        if (attempt >= 4) { if (prepared.replayed) return linkSavedCreate(store, prepared); throw error; }
        await conflictBackoff(attempt); }
    }
  }
  if (prepared.replayed) {
    return linkSavedCreate(store, prepared);
  }
  try { await store.saveAnswer(prepared.current.answer); }
  catch (error) {
    // A concurrent create may win after preflight, or a successful write may lose its response.
    if (prepared.examId) {
      try {
        const current = await loadSnapshot(store, prepared.current.answer.id);
        return linkSavedCreate(store, { ...prepared, current, replayed: true });
      } catch (lookupError) { if (!isStoreNotFound(lookupError)) throw lookupError; }
    }
    const replay = await createReplay(store, prepared.current.answer);
    if (replay) return replay;
    throw error;
  }
  const current = await loadSnapshot(store, prepared.current.answer.id);
  return linkSavedCreate(store, { ...prepared, current });
}

/** Arguments each previewed write tool takes besides answerId and expectedVersion. */
const previewArgumentSchemas = {
  write_answer: z.object({ sections: z.array(answerSectionInputSchema).max(100) }),
  replace_text: replacementContentSchema.extend({ sectionId: sectionIdSchema }),
  format_section: formattingPayloadSchema.extend({ sectionId: sectionIdSchema }),
  insert_text: z.object({ afterSectionId: sectionIdSchema.optional(), section: answerSectionInputSchema }),
  delete_text: z.object({ sectionId: sectionIdSchema }),
  edit_text: z.object({ edits: textEditsSchema }),
  move_section: z.object({ sectionId: sectionIdSchema, beforeSectionId: sectionIdSchema.optional(), afterSectionId: sectionIdSchema.optional() }),
  renumber_items: z.object({ sectionId: sectionIdSchema.optional() }),
} satisfies Record<PreviewOperation, z.ZodObject>;

// Output schemas of the tools added after the base contract stay minimal to fit the tools/list
// budget; before/after snapshots and the remaining answer/layout fields pass through untyped.
const compactSnapshotShape = {
  answer: z.object({ id: answerIdSchema, version: z.number().int().positive() }).loose(),
  layout: layoutReportSchema.pick({ totalLines: true, overflowLines: true, fits: true }).loose(),
};

const changePreviewOutputSchema = z.object({
  operation: z.enum(PREVIEW_OPERATIONS),
  answerId: answerIdSchema,
  baseVersion: z.number().int().positive(),
  applied: z.literal(false),
  summary: z.array(z.string()),
}).loose();

const editOutputSchema = z.object({
  ...compactSnapshotShape,
  replacements: z.number().int().positive(),
  changes: z.array(z.string()),
}).loose();

const revisionListOutputSchema = z.object({
  answerId: answerIdSchema,
  currentVersion: z.number().int().positive(),
  // Entries carry layout metrics when calculable, or layoutError for a legacy invalid revision.
  revisions: z.array(z.object({ version: z.number().int().positive(), changes: z.array(z.string()) }).loose()),
  olderVersions: z.number().int().nonnegative(),
});

// Loose: the export tools also return the readable fileName and, when configured, a downloadUrl.
const exportOutputSchema = z.object({
  answerId: answerIdSchema,
  version: z.number().int().positive(),
  format: z.enum(["docx", "pdf", "txt"]),
  path: z.string(),
  exportUri: z.string(),
  exportExpiresAt: z.string(),
  pages: z.number().int().positive(),
  layout: layoutSummarySchema,
  font: z.string().optional(),
  fontWarning: z.string().optional(),
}).loose();

const ANSWER_SHEET_UI_META = {
  ui: { resourceUri: ANSWER_SHEET_WIDGET_URI, visibility: ["model", "app"] },
  "openai/outputTemplate": ANSWER_SHEET_WIDGET_URI,
} as const;

function textContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

function assertExportVersion(answer: AnswerDocument, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && answer.version !== expectedVersion) {
    throw new Error(`VERSION_CONFLICT ${answer.id}：目前版本 ${answer.version}，預期 ${expectedVersion}；請用 read_answer/check_layout 重新讀取。`);
  }
}

type ExportIssue = {
  code: "ANSWER_NOT_FOUND" | "VERSION_CONFLICT" | "LAYOUT_OVERFLOW" | "LAYOUT_INVALID" | "EXPORT_FAILED";
  answerId?: string; questionNo?: number; format?: ExportFormat; retryable: boolean; message: string;
};
function exportIssue(code: ExportIssue["code"], message: unknown, answer?: Partial<Pick<AnswerDocument, "id" | "questionNo">>, format?: ExportFormat, cause: unknown = message): ExportIssue {
  return { code, ...(answer ? { answerId: answer.id, ...(answer.questionNo === undefined ? {} : { questionNo: answer.questionNo }) } : {}),
    ...(format ? { format } : {}), retryable: code === "EXPORT_FAILED" && isRetryableExportError(cause), message: publicExportMessage(errorMessage(message)) };
}
class ExportFailure extends Error {
  constructor(readonly errors: ExportIssue[], message = errors.map(error => error.message).join("\n")) { super(message); }
}
// SDK clients validate structured error content too: require either the success fields or errors.
function exportResultSchema<T extends z.ZodObject>(success: T) {
  return success.partial().extend({ errors: z.array(z.record(z.string(), z.unknown())).min(1).optional() })
    .meta({ anyOf: [{ required: Object.keys(success.shape) }, { required: ["errors"] }] });
}
function renderSummary(current: AnswerSnapshot, warningCount: number) {
  const { id, templateId, title, version } = current.answer;
  const { totalLines, capacity, fits, overflowLines, pagesUsed, remainingLines, status } = current.layout;
  return { answer: { id, templateId, title, version }, layout: { totalLines, capacity, fits, overflowLines, pagesUsed, remainingLines, status }, warningCount };
}

function exportArtifactLink(name: string, uri: string, mimeType: string) {
  return {
    type: "resource_link" as const,
    uri,
    name,
    mimeType,
    description: `下載已匯出的 ${name}`,
  };
}

function ensureUniqueSectionIds(sections: AnswerSection[]): void {
  const ids = new Set<string>();
  for (const section of sections) {
    if (ids.has(section.id)) throw new Error(`Duplicate section id: ${section.id}`);
    ids.add(section.id);
  }
}

function snapshot(answer: AnswerDocument, template: AnswerTemplate): AnswerSnapshot {
  return { answer, layout: layoutSections(template, answer.sections, answer.layoutOptions) };
}

/** `order`, not the array position, decides the layout; changes start from that order so renumbering keeps it. */
function inLayoutOrder(sections: AnswerSection[]): AnswerSection[] {
  return [...sections].sort((a, b) => a.order - b.order);
}

async function loadSnapshot(store: EssayStore, answerId: string): Promise<AnswerSnapshot> {
  const stored = await store.getAnswer(answerId);
  const template = await store.getTemplate(stored.templateId);
  return snapshot({ ...stored, sections: inLayoutOrder(stored.sections) }, template);
}

function writeResponse(current: AnswerSnapshot, detail: "summary" | "full") {
  if (detail === "full") return current;
  const { id, templateId, title, version, exam, questionNo } = current.answer;
  const { capacity, totalLines, pagesUsed, overflowLines, remainingLines, fits, status, pageUsage } = current.layout;
  const section = current.section as AnswerSection | undefined;
  return { ...current,
    answer: { id, templateId, title, version, ...(exam === undefined ? {} : { exam }), ...(questionNo === undefined ? {} : { questionNo }) },
    layout: { capacity, totalLines, pagesUsed, overflowLines, remainingLines, fits, status, pageUsage },
    ...(section ? { section: { id: section.id, heading: section.heading, order: section.order } } : {}),
    sections: planLines(current.answer, current.layout).sections, detail: "summary" as const,
  };
}

function sectionFromInput(input: AnswerSectionInput, order: number): AnswerSection {
  return normalizeSection(input, order);
}

function hypotheticalAnswer(answer: AnswerDocument, sections: AnswerSection[]): AnswerDocument {
  const ids = new Set(sections.map((section) => section.id));
  return answerDocumentSchema.parse({
    ...answer,
    lineTargets: answer.lineTargets ? Object.fromEntries(Object.entries(answer.lineTargets).filter(([id]) => ids.has(id))) : undefined,
    sections: sections.map((section, index) => ({ ...section, order: index })),
    version: answer.version + 1,
    updatedAt: new Date().toISOString(),
  });
}

/** The change list appended to a write tool's text result. */
function changeText(before: AnswerSnapshot, after: AnswerSnapshot): string {
  return describeChanges(before, after).map((line) => `
・${line}`).join("");
}

function findSection(answer: AnswerDocument, sectionId: string): AnswerSection {
  const target = answer.sections.find((section) => section.id === sectionId);
  if (!target) throw new Error(`找不到 sectionId ${sectionId}。`);
  return target;
}

// Each write tool and preview_change derive the proposed sections through the same function,
// so a preview always shows exactly what the write tool would save.
function writtenSections(inputs: AnswerSectionInput[]): AnswerSection[] {
  const normalized = inputs.map(sectionFromInput);
  ensureUniqueSectionIds(normalized);
  return normalized;
}

function replacedSections(answer: AnswerDocument, sectionId: string,
  { newText, paragraphs, heading }: z.infer<typeof replacementContentSchema>): AnswerSection[] {
  findSection(answer, sectionId);
  return answer.sections.map((section) => section.id === sectionId
    ? replaceSectionContent(section, { text: newText, paragraphs, heading: heading === undefined ? section.heading : heading ?? undefined })
    : section);
}

function formattedSections(answer: AnswerDocument, sectionId: string,
  { paragraphFormat, headingStyle, paragraphFormats }: z.infer<typeof formattingPayloadSchema>): AnswerSection[] {
  findSection(answer, sectionId);
  return answer.sections.map((section) => section.id === sectionId
    ? updateSectionFormatting(section, { paragraphFormat, headingStyle, paragraphFormats })
    : section);
}

function insertedSections(answer: AnswerDocument, afterSectionId: string | undefined, input: AnswerSectionInput) {
  if (afterSectionId && !answer.sections.some((item) => item.id === afterSectionId)) {
    throw new Error(`找不到 afterSectionId ${afterSectionId}。`);
  }
  const inserted = sectionFromInput(input, 0);
  if (answer.sections.some((item) => item.id === inserted.id)) throw new Error(`Duplicate section id: ${inserted.id}`);
  const index = afterSectionId ? answer.sections.findIndex((item) => item.id === afterSectionId) + 1 : answer.sections.length;
  const sections = [...answer.sections];
  sections.splice(index, 0, inserted);
  return { sections, inserted };
}

function deletedSections(answer: AnswerDocument, sectionId: string): AnswerSection[] {
  findSection(answer, sectionId);
  return answer.sections.filter((item) => item.id !== sectionId);
}

function movedSections(answer: AnswerDocument, sectionId: string,
  { beforeSectionId, afterSectionId }: { beforeSectionId?: string; afterSectionId?: string }): AnswerSection[] {
  const moving = findSection(answer, sectionId);
  if ((beforeSectionId === undefined) === (afterSectionId === undefined)) throw new Error("beforeSectionId 與 afterSectionId 須擇一提供。");
  const anchorId = (beforeSectionId ?? afterSectionId)!;
  if (anchorId === sectionId) throw new Error("不能把區塊移到自己的前面或後面。");
  findSection(answer, anchorId);
  const sections = answer.sections.filter((item) => item.id !== sectionId);
  sections.splice(sections.findIndex((item) => item.id === anchorId) + (afterSectionId ? 1 : 0), 0, moving);
  if (sections.every((item, index) => item.id === answer.sections[index].id)) throw new Error("區塊已經在這個位置，不需要移動。");
  return sections;
}

/** A nudge appended to structural edits when the written item numbers are no longer consecutive. */
function numberingHint(sections: AnswerSection[]): string {
  try {
    renumberItems(sections);
    return "\n編號已不連續；可先用 preview_change（operation: renumber_items）預覽，再呼叫 renumber_items 重新編號。";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.startsWith("編號已經是連續的") ? "" : `\n編號已不連續，但無法自動重新編號：${message}`;
  }
}

/** The renumber_items note about openings that were left alone because they read as numbers in the prose. */
function skippedNote(skipped: string[]): string {
  return skipped.length ? `未計入、也未修改（開頭的數字像是內文，例如「二、三級」，請確認）：${skipped.join("、")}` : "";
}

/** Checks preview_change arguments against the previewed tool, naming the fields that tool expects. */
function previewArguments<Schema extends z.ZodObject>(operation: PreviewOperation, schema: Schema, args: Record<string, unknown>): z.infer<Schema> {
  const stray = Object.keys(args).filter((key) => args[key] !== undefined && !(key in schema.shape));
  if (stray.length) throw new Error(`${operation} 不使用 ${stray.join("、")}；它的參數是 ${Object.keys(schema.shape).join("、")}。`);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    throw new Error(`${operation} 的參數不正確：${parsed.error.issues.map((issue) => `${issue.path.join(".") || "參數"} ${issue.message}`).join("；")}`);
  }
  return parsed.data;
}

/** The sections the previewed write tool would save. */
function previewedSections(answer: AnswerDocument, operation: PreviewOperation, args: Record<string, unknown>): { sections: AnswerSection[]; notes: string[] } {
  if (operation === "renumber_items") {
    const { sections, skipped } = renumberItems(answer.sections, previewArguments(operation, previewArgumentSchemas.renumber_items, args).sectionId);
    return { sections, notes: skipped.length ? [skippedNote(skipped)] : [] };
  }
  return { sections: proposedSections(answer, operation, args), notes: [] };
}

function proposedSections(answer: AnswerDocument, operation: Exclude<PreviewOperation, "renumber_items">, args: Record<string, unknown>): AnswerSection[] {
  const schemas = previewArgumentSchemas;
  switch (operation) {
    case "write_answer": return writtenSections(previewArguments(operation, schemas.write_answer, args).sections);
    case "replace_text": {
      const value = previewArguments(operation, schemas.replace_text, args);
      return replacedSections(answer, value.sectionId, value);
    }
    case "format_section": {
      const value = previewArguments(operation, schemas.format_section, args);
      return formattedSections(answer, value.sectionId, value);
    }
    case "insert_text": {
      const value = previewArguments(operation, schemas.insert_text, args);
      return insertedSections(answer, value.afterSectionId, value.section).sections;
    }
    case "delete_text": return deletedSections(answer, previewArguments(operation, schemas.delete_text, args).sectionId);
    case "edit_text": return applyTextEdits(answer.sections, previewArguments(operation, schemas.edit_text, args).edits).sections;
    case "move_section": {
      const value = previewArguments(operation, schemas.move_section, args);
      return movedSections(answer, value.sectionId, value);
    }
  }
}

async function makeChangePreview<Operation extends PreviewOperation>(
  store: EssayStore,
  operation: Operation,
  before: AnswerSnapshot,
  afterAnswer: AnswerDocument,
) {
  const template = await store.getTemplate(before.answer.templateId);
  const after = snapshot(afterAnswer, template);
  const lineDelta = after.layout.totalLines - before.layout.totalLines;
  const summary = [
    `版本 ${before.answer.version} → ${after.answer.version}（尚未套用）`,
    `總行數 ${before.layout.totalLines} → ${after.layout.totalLines}（${lineDelta >= 0 ? "+" : ""}${lineDelta}）`,
    after.layout.fits ? "修改後符合模板容量。" : `修改後超出 ${after.layout.overflowLines} 行。`,
    ...describeChanges(before, after),
  ];
  return {
    changeId: randomUUID(),
    operation,
    answerId: before.answer.id,
    baseVersion: before.answer.version,
    applied: false,
    before,
    after: { answer: after.answer, layout: after.layout },
    summary,
  };
}

/** Formatting tools state the 165 paper limits up front so the model explains them instead of retrying. */
export const PAPER_FORMAT_NOTE = " The 165 original-paper template (police_information_essay_165) accepts only left-aligned text without bold or italic; tell the user so instead of attempting that formatting.";
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  create_answer: "Create an editable answer. examId resumes existing planned questions; use idempotencyKey for retries.",
  write_answer: "Replace all sections; expectedVersion protects edits. Prefer edit_text for phrases.",
  replace_text: "Replace one section's text or paragraphs, preserving other sections.",
  format_section: "Change section/paragraph formatting without rewriting content.",
  insert_text: "Insert a section after afterSectionId, or append when omitted.",
  delete_text: "Delete one section; preview_change can preview first.",
  render_answer_sheet: "Show one answer canvas with authoritative layout and editing controls.",
  check_layout: "Read exact line usage, overflow, targets and quality warnings (not content verification).",
  read_answer: "Read the complete answer and rendered lines; no canvas.",
  load_exam_paper: "Load template geometry and formatting rules.",
  list_templates: "List available answer-sheet templates.",
  list_answers: "List saved answers grouped by exam, ordered by question number.",
  reflow_answer: "Recalculate saved content with the authoritative layout engine.",
  update_answer_info: "Edit title, exam, question number, question or layout options.",
  duplicate_answer: "Copy content, formatting and targets into an independent version-1 answer.",
  export_docx: "Export DOCX at expectedVersion; rejects overflow unless explicitly allowed (never for 165).",
  export_pdf: "Export PDF at expectedVersion; rejects overflow unless explicitly allowed (never for 165).",
  export_text: "Export grid TXT at expectedVersion; rejects overflow unless explicitly allowed (never for 165).",
  export_answer: "Export pinned answers as Word and PDF by default; legacy TXT remains available.",
  export_exam_bundle: "Export all planned questions via examId or ordered pinned answers as PDF and Word by default; all-or-nothing. Give both links without asking to export.",
  move_section: "Move a section before or after another section.",
  renumber_items: "Renumber written heading/paragraph numbers by hierarchy.",
  set_line_targets: "Set section line targets for check_layout; targets include headings and spacing.",
  preview_change: "Preview a write operation with its arguments; saves nothing.",
  edit_text: "Replace matching phrases; select occurrence or all matches, optionally within a section.",
  list_revisions: "Read recent committed versions and change summaries.",
  restore_revision: "Restore historical content as a new version, guarded by expectedVersion.",
  delete_answer: "Explicit permanent deletion only: removes answer, revisions, export files and exam bundles containing it; requires expectedVersion.",
};
const FORMATTING_TOOLS = new Set(["create_answer", "write_answer", "replace_text", "format_section", "insert_text", "preview_change"]);
const PAPER_FORMAT_INSTRUCTION = "165 原稿紙模板（police_information_essay_165）只接受靠左、非粗體、非斜體的標準楷書；使用者要求粗體、斜體、置中、靠右或分散對齊時，直接說明不支援，不要嘗試寫入。舊代碼 police_information_essay_166 保留為相容別名；既有答案沿用儲存的代碼，不遷移，兩者版面相同。";
const REVIEW_INSTRUCTION = "起草前先從原題列出所有必要小問，為每小問指定穩定 id、sectionIds、來源 sourceIds；具體證據須說明用途，定義與分類軸須逐項核對，不可只列名詞。依配分／重要性設定 lineTargets，先補必要小問再刪補充。建立後先讀 essay://schemas/review-plan，再用 set_answer_review(expectedVersion, plan) 保存清單，再 review_answer。配分只有明確可相加才設 additive；包含關係不明用 unknown，不自行改分。來源 locator 不是已核證據，required 與 supplemental 分開；只在實際對照來源後記錄 review 的方法、核對者、時間與具體結論，沒有證據留空。掃描逐頁記錄 content/blank/unreadable/missing，缺頁或空白不能算完整。review_answer 只檢查結構與紀錄狀態，mapped 不代表答對，semantic/sourceVerification=not_checked；review_recorded 也不代表軟體查證。核對清單完整性、語義、來源與逐頁視覺後才記錄各自 review。修改答案後舊紀錄 stale，須重核再保存。匯出前呼叫 review_answer 並處理／揭露待核項；此檢查不改變既有匯出或 done 合約。";

const EDIT_INSTRUCTION = "多題最短流程：start_exam → create_answers(examId) → 修正版面 → render_exam_overview(examId) → export_exam_bundle(examId)。使用者說繼續或前次中斷，先呼叫 get_exam_progress，依 nextStep 接續，將 summary 告知使用者一次；不要重做已完成題目或逐步旁白。fits 僅代表容量符合，絕不可稱答案已查證。匯出成功只代表檔案產出；get_exam_progress 的 done 保留為匯出流程終點，delivery.status=awaiting_review 表示內容、來源與逐頁視覺驗收待完成，不可稱成品已驗收或因此重複匯出。新答案預設整字換行、標題不落頁尾（layoutOptions）；舊答案可用 update_answer_info 開啟，補入的空白行計入行數與容量。單題用 create_answer 一次帶 exam、questionNo、lineTargets（sectionId 必須等於 sections 明確提供的 id）；重試使用相同 idempotencyKey 與請求，重送回傳目前版本，不同請求會拒絕。多題用 create_answers（1–10 題），全部驗證才開始儲存，逐題給不同 key；中途失敗依錯誤列出的已建立項目處理。只修改需要變更的內容。寫入預設回傳摘要，完整文字用 read_answer 或 responseDetail=full。read_answer 只回傳資料，不顯示畫板；單題畫板用 render_answer_sheet；多題只呼叫一次 render_exam_overview，以分頁切換，不要逐題開畫板。修改字句用 edit_text，只送 find/replace；整段改寫用 replace_text，整份重寫才用 write_answer；只改格式用 format_section。修改時帶 expectedVersion，可先用 preview_change 預覽，套用後回報變更清單。check_layout 檢查行數、目標與品質 warnings（僅提醒、不阻擋匯出）；單題用 export_answer(expectedVersion)，多題版面皆通過後必須呼叫一次 export_exam_bundle(examId)，預設輸出 PDF 與 Word；同一則訊息直接提供兩個下載連結，不要詢問是否匯出。可逐題指定 expectedVersion。合輯隨任一成員答案刪除；handle 建立失敗會回收先前 handle，回收失敗會列出遺留 handle。搬移用 move_section，編號不連續用 renumber_items；調整各節目標用 set_line_targets。list_revisions 查歷史，restore_revision 另存還原版本。update_answer_info 修改考試／題號等資訊，duplicate_answer 複製試寫。";

function noAnswerFoundMessage(answerId: string): string {
  return `找不到答案 ${answerId}。先呼叫 create_answer 建立答案，或確認 answerId。`;
}

/**
 * downloadBaseUrl: public https origin of this server; export results then carry a direct download link
 * (served by the HTTP handler at /downloads/<handle>/<file name>).
 */
export function createEssayMcpServer(store: EssayStore = new FileStore(),
  options: { readOnly?: boolean; scopes?: string[]; downloadBaseUrl?: string } = {}): McpServer {
  const server = new McpServer(
    {
      name: "police-essay-answer-sheet",
      version: "0.1.0",
    },
    {
      instructions:
        "新建答案及全卷建立省略 templateId 時使用 police_information_essay_165；須配置已校驗教育部標準楷書，字型缺少時明確失敗。明確選其他模板及既有答案沿用原模板。這是一個固定版面國考申論答題紙 MCP。多題先呼叫 start_exam；單題先呼叫 load_exam_paper 或 create_answer；所有答案都必須透過版面引擎計算行數。使用者要求觀看、建立後顯示或編輯時，單題呼叫 render_answer_sheet；多題只呼叫一次 render_exam_overview 顯示同一畫板的題目分頁。修改後呼叫 check_layout，只有 fits=true 才可視為符合兩頁限制。" + EDIT_INSTRUCTION + PAPER_FORMAT_INSTRUCTION + REVIEW_INSTRUCTION,
    },
  );

  const registerTool: typeof server.registerTool = (name, base, callback) => {
    const description = TOOL_DESCRIPTIONS[name] ?? base.description;
    const config = { ...base, description: FORMATTING_TOOLS.has(name) ? (description ?? "") + PAPER_FORMAT_NOTE : description };
    return server.registerTool(name, options.scopes ? { ...config, _meta: { ...config._meta,
      securitySchemes: [{ type: "oauth2", scopes: [...new Set(["essay.read", toolScope(name)])] }],
    } } : config, (async (...args: unknown[]) => {
      try {
        const result = await (callback as (...args: unknown[]) => unknown)(...args);
        // Storage-only idempotency state must never leave a tool, including full previews and widget metadata.
        return JSON.parse(JSON.stringify(result, (key, value) => ["createRequestHash", "createRequests"].includes(key) ? undefined : value));
      } catch (error) {
        if (name !== "export_answer" && name !== "export_exam_bundle") throw error;
        const errors = error instanceof ExportFailure ? error.errors : [exportIssue("EXPORT_FAILED", error)];
        return { isError: true, structuredContent: { errors }, content: textContent(publicExportMessage(errorMessage(error))) };
      }
    }) as typeof callback);
  };

  server.registerResource(
    "police-information-essay-answer-sheet-widget",
    ANSWER_SHEET_WIDGET_URI,
    {
      title: "警察資訊申論答題紙畫板",
      description: "在 ChatGPT 內顯示可檢查版面、定位區塊與預覽／套用修改的互動答題紙。",
      mimeType: "text/html;profile=mcp-app",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/html;profile=mcp-app",
        text: POLICE_ESSAY_WIDGET_HTML,
        _meta: { ui: { prefersBorder: true } },
      }],
    }),
  );

  server.registerResource(
    "police-information-essay-template",
    "essay://templates/police_information_essay",
    {
      title: "警察資訊三等申論格紙模板",
      description: "A4、2頁、每頁22行的固定版面設定與計算規則。",
      mimeType: "application/json",
    },
    async (uri) => {
      const template = await store.getTemplate("police_information_essay");
      return {
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(template, null, 2) }],
      };
    },
  );

  server.registerResource(
    "answer-sheet-workflow",
    "essay://instructions/workflow",
    {
      title: "申論答題紙工作流程",
      description: "模型操作申論答案時應遵循的讀取、修改、排版與匯出順序。",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: [
          "# 申論答題紙工作流程",
          "1. create_answer 一次帶 exam、questionNo、lineTargets 與 sections；lineTargets.sectionId 必須等於 sections 明確提供的 id，在版本 1 儲存；load_exam_paper 可先查看模板。省略 templateId 時新建答案使用 police_information_essay_165；明確選其他模板及既有答案沿用原模板。" + PAPER_FORMAT_INSTRUCTION,
          "建立重試帶相同 idempotencyKey 與請求；不同請求不可共用 key。create_answers 一次 1–10 題，全數驗證後逐題儲存，每題使用不同 key；部分儲存失敗會列出已建立項目。",
          "2. 只修改需要變更的文字：edit_text 改字句，replace_text 整段改寫，write_answer 整份重寫；format_section 只改格式。修改帶 expectedVersion，可先用 preview_change 預覽。",
          "3. 寫入預設回傳摘要；完整文字用 read_answer，或寫入時指定 responseDetail=full。read_answer 只回傳資料，不顯示畫板；單題畫板用 render_answer_sheet；多題只呼叫一次 render_exam_overview，以分頁切換，不要逐題開畫板。",
          "4. check_layout 查看真實行數、目標差距與 warnings；新答案預設避免英文斷字與標題落頁尾；舊答案可用 update_answer_info.layoutOptions 開啟，補入空白行計入行數與容量。warnings 僅提醒、不阻擋匯出。超出容量時依 compressionHints 修改，再重新檢查。",
          "5. 單題用 export_answer 並帶 expectedVersion；多題用 export_exam_bundle，逐題釘選 expectedVersion，按指定順序合成 PDF 與 Word。只有 fits=true 才可正常匯出；165 原稿紙不允許超頁。全部題目通過後直接匯出，同一則訊息提供兩個下載連結，不要詢問是否匯出。",
          "TXT 的 textMode 預設 paper，paragraphs 去除視覺換行、保留編號並以 _段落.txt 命名；pages 仍計算稿紙頁數。合輯隨任一成員答案刪除；handle 失敗會回收先前 handle，回收失敗會列出遺留 handle。",
          "6. move_section 搬移；renumber_items 修正不連續編號；set_line_targets 調整各節目標；update_answer_info 修改答案資訊；duplicate_answer 複製試寫。",
          REVIEW_INSTRUCTION,
          "7. list_revisions 查歷史，restore_revision 另存新版本還原；只有使用者明確要求永久刪除時才用 delete_answer，並帶目前 expectedVersion。",

        ].join("\n"),
      }],
    }),
  );

  server.registerResource(
    "export-artifact",
    new ResourceTemplate("essay://exports/{handle}", { list: undefined }),
    {
      title: "已匯出的申論檔案",
      description: "export_docx / export_pdf / export_text 產生的限時檔案；URI 見工具結果的 exportUri。",
    },
    async (uri, variables) => {
      if (options.readOnly || (options.scopes && !options.scopes.includes("essay.export"))) throw new Error("Export artifact not found.");
      const handle = Array.isArray(variables.handle) ? variables.handle[0] : variables.handle;
      const artifact = await store.readExport(handle ?? "");
      return {
        contents: [{
          uri: uri.href,
          mimeType: artifact.mimeType,
          blob: artifact.data.toString("base64"),
        }],
      };
    },
  );

  registerTool(
    "list_templates",
    {
      title: "列出答題紙模板",
      description: "Use this when the user wants to inspect available essay answer-sheet templates before creating an answer.",
      inputSchema: {},
      outputSchema: z.object({ templates: z.array(templateSummarySchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const templates = await store.listTemplates();
      return { structuredContent: { templates }, content: textContent(`共有 ${templates.length} 個答題紙模板。`) };
    },
  );

  registerTool(
    "load_exam_paper",
    {
      title: "載入申論答題紙",
      description: "Use this when the user wants to load a template or reopen an existing essay answer with its calculated grid layout.",
      inputSchema: {
        templateId: rawCreateInput(z.string().default(DEFAULT_TEMPLATE_ID)).optional(),
        answerId: answerIdSchema.optional(),
      },
      outputSchema: z.object({
        template: templateSummarySchema,
        answer: answerSummarySchema.optional(),
        layout: layoutSummarySchema.optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: ANSWER_SHEET_UI_META,
    },
    async ({ templateId, answerId }) => {
      z.string().optional().parse(templateId);
      const answer = answerId ? await store.getAnswer(answerId) : undefined;
      const template = await store.getTemplate(templateId ?? answer?.templateId ?? DEFAULT_TEMPLATE_ID);
      if (!answerId) {
        return {
          structuredContent: { template },
          content: textContent(`已載入「${template.name}」：${template.pages}頁、每頁${template.linesPerPage}行、總容量${template.pages * template.linesPerPage}行。`),
        };
      }
      if (!answer) throw new Error("Answer not found");
      if (answer.templateId !== template.id) {
        throw new Error(`答案使用的模板是 ${answer.templateId}，不是 ${template.id}。`);
      }
      const layout = layoutSections(template, answer.sections, answer.layoutOptions);
      return {
        structuredContent: { template, answer, layout },
        content: textContent(`已載入答案「${answer.title}」；${summarizeLayout(layout)}`),
      };
    },
  );

  registerTool(
    "list_answers",
    {
      title: "列出申論答案",
      description: "Use this when the user wants to find saved essay answers that can be reopened or edited.",
      inputSchema: {},
      outputSchema: z.object({ answers: z.array(answerSummarySchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const answers = sortAnswers(await store.listAnswers());
      return { structuredContent: { answers },
        content: textContent([`目前有 ${answers.length} 份已儲存答案。`, ...describeAnswerList(answers)].join("\n")) };
    },
  );

  const startExamTool = registerTool("start_exam", {
    title: "建立考試計畫", description: "Plan questions before drafting; reuse idempotencyKey on retry.",
    inputSchema: { title: z.string().min(1).max(100), questions: z.array(examQuestionSchema.omit({ answerId: true }).strict()).min(1).max(20).refine(q => new Set(q.map(x => x.questionNo)).size === q.length, "questionNo 不可重複。"),
      formats: examFormatsSchema.default(["pdf", "docx"]), idempotencyKey: createFields.idempotencyKey },
    outputSchema: z.object({ examId: examIdSchema, summary: z.string() }).loose(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async ({ idempotencyKey, ...request }) => {
    const id = idempotencyKey ? `exam_idem-${sha256(idempotencyKey).slice(0, 40)}` : `exam_${randomUUID()}`;
    const hash = sha256(canonicalJson(request));
    const replay = async () => {
      try {
        const plan = await store.getExam(id);
        if (plan.createRequestHash !== hash) throw new Error("IDEMPOTENCY_KEY_REUSED：此 key 已用於不同的考試計畫。");
        return plan;
      } catch (error) { if (isStoreNotFound(error)) return; throw error; }
    };
    let plan = await replay(); let replayed = Boolean(plan);
    if (!plan) {
      const now = new Date().toISOString();
      plan = { ...request, id, version: 1, createdAt: now, updatedAt: now, createRequestHash: hash };
      try { await store.saveExam(plan); } catch (error) { if (!await replay()) throw error; replayed = true; }
    }
    const progress = await examProgress(store, id);
    return { structuredContent: { examId: id, summary: progress.summary, replayed }, content: textContent(progress.summary) };
  });
  registerTool("get_exam_progress", {
    title: "讀取考試進度", _meta: { ui: { visibility: ["model", "app"] } }, description: "Read real stages and nextStep first when resuming an interrupted exam.",
    inputSchema: { examId: examIdSchema },
    outputSchema: z.object({ examId: examIdSchema, summary: z.string() }).loose(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ examId }) => {
    const progress = await examProgress(store, examId);
    return { structuredContent: progress, content: textContent(progress.summary) };
  });

  const createAnswerTool = registerTool(
    "create_answer",
    {
      title: "建立申論答案",
      description: "Use this when the user wants a new editable essay answer bound to a specific answer-sheet template. Sections support per-paragraph indentation, alignment, spacing, tabs, emphasis, and automatic heading styles.",
      inputSchema: {
        responseDetail: responseDetailSchema,
        ...createFields,
        templateId: rawCreateInput(createFields.templateId).optional(),
        sections: rawCreateInput(createRequestSchema.shape.sections).default([]),
      },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        ...ANSWER_SHEET_UI_META,
        "openai/toolInvocation/invoking": "建立答題紙…",
        "openai/toolInvocation/invoked": "答題紙已建立。",
      },
    },
    async ({ responseDetail, ...request }) => {
      const { current, replayed, linkPending, message } = await commitCreate(store, await prepareCreate(store, request));
      const { id, version, exam, questionNo } = current.answer;
      return {
        structuredContent: { ...writeResponse(current, responseDetail), ...(replayed ? { replayed } : {}), ...(linkPending ? { linkPending, message } : {}) },
        content: textContent((replayed ? (request.examId ? `既有答案 ${id}（目前第 ${version} 版），未重複建立。` : `重送：此 idempotencyKey 已建立 ${id}（目前第 ${version} 版），未重複建立。`) : `已建立 ${id}`)
          + `${exam ? `；考試：${exam}` : ""}${questionNo === undefined ? "" : `；第 ${questionNo} 題`}；${summarizeLayout(current.layout)}`
          + (message ? `\n${message}` : "")
          + (request.lineTargets ? `\n各節：${describeLines(planLines(current.answer, current.layout).sections)}\n${planLines(current.answer, current.layout).notes.join("\n")}` : "")),
      };
    },
  );

  const createAnswersTool = registerTool(
    "create_answers",
    {
      title: "批次建立申論答案",
      description: "Use this when creating 1–10 answers. All items are validated before saving; use unique idempotencyKeys for safe retries.",
      inputSchema: { examId: examIdSchema.optional(), answers: z.array(rawCreateInput(batchCreateSchema)).min(1).max(10) },
      outputSchema: z.object({ answers: z.array(z.object({ index: z.number().int(), answerId: answerIdSchema,
        version: z.number().int(), fits: z.boolean() }).loose()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    },
    async ({ examId, answers }) => {
      const failures: string[] = [], prepared: PreparedCreate[] = [];
      const assigned = new Map<string, Set<number>>();
      const keys = answers.map(item => item && typeof item === "object" ? item.idempotencyKey : undefined);
      for (const [index, received] of answers.entries()) {
        let request = received;
        try {
          if (keys[index] && keys.indexOf(keys[index]) !== index) throw new CreateError("INVALID_INPUT", "批次內 idempotencyKey 不可重複。");
          if (examId && request && typeof request === "object") {
            if (request.examId && request.examId !== examId) throw new CreateError("INVALID_INPUT", "批次 examId 與項目的 examId 不一致。");
            request = { ...request, examId };
          }
          let defaultQuestionNo: number | undefined;
          if (request?.examId) {
            const used = assigned.get(request.examId) ?? new Set<number>();
            const plan = await store.getExam(request.examId);
            defaultQuestionNo = request.questionNo ?? (request.idempotencyKey ? plan.createRequests?.[sha256(request.idempotencyKey)]?.questionNo : undefined)
              ?? [...plan.questions].sort((a,b) => a.questionNo - b.questionNo).find(q => !q.answerId && !used.has(q.questionNo))?.questionNo;
            const item = await prepareCreate(store, request, defaultQuestionNo);
            used.add(item.examQuestionNo!); assigned.set(plan.id, used); prepared.push(item);
          } else prepared.push(await prepareCreate(store, request));
        } catch (error) {
          if (!(error instanceof CreateError)) throw error;
          failures.push(`第 ${index + 1} 項 ${error.message}`);
        }
      }
      if (failures.length) throw new Error(failures.join("\n"));
      const results = [];
      for (const [index, item] of prepared.entries()) {
        try {
          const { current: { answer, layout }, replayed, linkPending, message } = await commitCreate(store, item);
          results.push({ index: index + 1, answerId: answer.id, title: answer.title,
            ...(answer.exam === undefined ? {} : { exam: answer.exam }), ...(answer.questionNo === undefined ? {} : { questionNo: answer.questionNo }),
            version: answer.version, fits: layout.fits, totalLines: layout.totalLines, capacity: layout.capacity,
            overflowLines: layout.overflowLines, ...(replayed ? { replayed } : {}), ...(linkPending ? { linkPending, message } : {}) });
        } catch (error) {
          throw new Error(`已完成：${results.map(item => `第 ${item.index} 項 ${item.answerId}${item.replayed ? "（重送）" : ""}`).join("、") || "無"}。\n`
            + `第 ${index + 1} 項建立失敗：${errorMessage(error)}\n使用相同 idempotencyKeys 重試同一批次可避免重複；未提供 key 的已建立項目請勿重送。`);
        }
      }
      return { structuredContent: { answers: results }, content: textContent(results.map(item =>
        `第${item.questionNo ?? item.index}題/${item.title} ${item.answerId} ${item.totalLines}/${item.capacity} 行，`
        + (item.fits ? "符合容量" : `超出 ${item.overflowLines} 行`) + (item.message ? `；${item.message}` : "") + (item.replayed ? "（重送，未重複建立）" : "")).join("\n")) };
    },
  );

  registerTool(
    "read_answer",
    {
      title: "讀取申論答案",
      description: "Use this when the user wants the complete structured answer, section metadata, and exact rendered lines.",
      inputSchema: { answerId: answerIdSchema },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ answerId }) => {
      try {
        const current = await loadSnapshot(store, answerId);
        return { structuredContent: current, content: textContent(`已讀取「${current.answer.title}」；${summarizeLayout(current.layout)}`) };
      } catch (error) {
        if (isStoreNotFound(error)) throw new Error(noAnswerFoundMessage(answerId));
        throw error;
      }
    },
  );

  const writeAnswerTool = registerTool(
    "write_answer",
    {
      title: "寫入完整申論答案",
      description: "Use this when the user has generated or rewritten the full answer and wants it stored as ordered editable sections; paragraph-level formatting is preserved and line count is delegated to the layout engine.",
      inputSchema: {
        responseDetail: responseDetailSchema,
        answerId: answerIdSchema,
        sections: z.array(answerSectionInputSchema).max(100),
        expectedVersion: expectedVersionSchema,
      },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "寫入並計算版面…",
        "openai/toolInvocation/invoked": "答案已寫入並完成排版檢查。",
      },
    },
    async ({ responseDetail, answerId, sections, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      await store.saveAnswer(hypotheticalAnswer(answer, writtenSections(sections)), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: writeResponse(current, responseDetail), content: textContent(`已寫入；${summarizeLayout(current.layout)}${changeText(before, current)}`) };
    },
  );

  const replaceTextTool = registerTool(
    "replace_text",
    {
      title: "替換申論區塊",
      description: "Use this when the user wants to revise one existing section without regenerating unrelated sections; optional paragraphs can replace the text with independent formatting, and the answer is reflowed afterward.",
      inputSchema: replacementContentSchema.extend({
        responseDetail: responseDetailSchema,
        answerId: answerIdSchema,
        sectionId: z.string().min(1),
        expectedVersion: expectedVersionSchema,
      }),
      outputSchema: sectionOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        ui: { visibility: ["model", "app"] },
        "openai/toolInvocation/invoking": "修改指定段落並重排…",
        "openai/toolInvocation/invoked": "段落已修改並重新計算行數。",
      },
    },
    async ({ responseDetail, answerId, sectionId, newText, paragraphs, heading, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      const sections = replacedSections(answer, sectionId, { newText, paragraphs, heading });
      await store.saveAnswer(hypotheticalAnswer(answer, sections), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      const section = current.answer.sections.find((item) => item.id === sectionId);
      if (!section) throw new Error("替換後找不到 section。");
      return {
        structuredContent: writeResponse({ section, answer: current.answer, layout: current.layout }, responseDetail),
        content: textContent(`已修改「${section.heading ?? section.id}」；${summarizeLayout(current.layout)}${changeText(before, current)}`),
      };
    },
  );

  const formatSectionTool = registerTool(
    "format_section",
    {
      title: "格式化申論區塊",
      description: "Use this when the user wants to change indentation, alignment, spacing, tabs, emphasis, heading style, or selected paragraph formats without resending or rewriting the section text.",
      inputSchema: formattingPayloadSchema.extend({
        responseDetail: responseDetailSchema,
        answerId: answerIdSchema,
        sectionId: z.string().min(1),
        expectedVersion: expectedVersionSchema,
      }),
      outputSchema: sectionOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "更新段落格式並重排…",
        "openai/toolInvocation/invoked": "段落格式已更新並重新計算行數。",
      },
    },
    async ({ responseDetail, answerId, sectionId, paragraphFormat, headingStyle, paragraphFormats, expectedVersion }) => {
      if (paragraphFormat === undefined && headingStyle === undefined && (paragraphFormats?.length ?? 0) === 0) {
        throw new Error("至少提供 paragraphFormat、headingStyle 或一個 paragraphFormats 項目。");
      }
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      const sections = formattedSections(answer, sectionId, { paragraphFormat, headingStyle, paragraphFormats });
      await store.saveAnswer(hypotheticalAnswer(answer, sections), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      const section = current.answer.sections.find((item) => item.id === sectionId);
      if (!section) throw new Error("格式化後找不到 section。");
      return {
        structuredContent: writeResponse({ section, answer: current.answer, layout: current.layout }, responseDetail),
        content: textContent(`已更新「${section.heading ?? section.id}」的格式；${summarizeLayout(current.layout)}${changeText(before, current)}`),
      };
    },
  );

  const insertTextTool = registerTool(
    "insert_text",
    {
      title: "插入申論區塊",
      description: "Use this when the user wants to add a new section at a precise position in an existing answer; the complete answer is reflowed afterward.",
      inputSchema: {
        responseDetail: responseDetailSchema,
        answerId: answerIdSchema,
        afterSectionId: z.string().min(1).optional(),
        section: answerSectionInputSchema,
        expectedVersion: expectedVersionSchema,
      },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "插入段落並重排…",
        "openai/toolInvocation/invoked": "段落已插入並重新計算行數。",
      },
    },
    async ({ responseDetail, answerId, afterSectionId, section, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      const { sections, inserted: newSection } = insertedSections(answer, afterSectionId, section);
      await store.saveAnswer(hypotheticalAnswer(answer, sections), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: writeResponse(current, responseDetail), content: textContent(`已插入「${newSection.heading ?? newSection.id}」；${summarizeLayout(current.layout)}${changeText(before, current)}`
        + numberingHint(current.answer.sections)) };
    },
  );

  const deleteTextTool = registerTool(
    "delete_text",
    {
      title: "刪除申論區塊",
      description: "Use this when the user explicitly wants to remove one section from an answer; the remaining sections are reflowed afterward.",
      inputSchema: {
        responseDetail: responseDetailSchema,
        answerId: answerIdSchema,
        sectionId: z.string().min(1),
        expectedVersion: expectedVersionSchema,
      },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "刪除段落並重排…",
        "openai/toolInvocation/invoked": "段落已刪除並重新計算行數。",
      },
    },
    async ({ responseDetail, answerId, sectionId, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      await store.saveAnswer(hypotheticalAnswer(answer, deletedSections(answer, sectionId)), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: writeResponse(current, responseDetail), content: textContent(`已刪除 ${sectionId}；${summarizeLayout(current.layout)}${changeText(before, current)}`
        + numberingHint(current.answer.sections)) };
    },
  );

  const textEditsInput = {
    answerId: answerIdSchema,
    edits: textEditsSchema,
    expectedVersion: expectedVersionSchema,
  };

  registerTool(
    "preview_change",
    {
      title: "預覽修改",
      description: "Use this before any write tool when the user wants to see what it would change without saving: each changed paragraph with its page and line, the line-count delta and any overflow. Set operation to the write tool being previewed and pass that tool's own arguments with it: write_answer (sections), replace_text (sectionId, newText or paragraphs, heading), format_section (sectionId, paragraphFormat, headingStyle, paragraphFormats), insert_text (section, afterSectionId), delete_text (sectionId), edit_text (edits), move_section (sectionId, beforeSectionId or afterSectionId) or renumber_items (sectionId).",
      // Every previewed tool's arguments, all optional here; previewedSections checks them per operation.
      // Strict, so a misspelled or invented argument is reported instead of silently dropped.
      inputSchema: z.object({
        answerId: answerIdSchema,
        operation: z.enum(PREVIEW_OPERATIONS),
        expectedVersion: expectedVersionSchema,
        sections: previewArgumentSchemas.write_answer.shape.sections.optional(),
        sectionId: sectionIdSchema.optional(),
        ...replacementContentSchema.shape,
        ...formattingPayloadSchema.shape,
        afterSectionId: sectionIdSchema.optional(),
        beforeSectionId: sectionIdSchema.optional(),
        section: answerSectionInputSchema.optional(),
        edits: textEditsSchema.optional(),
      }).strict(),
      outputSchema: changePreviewOutputSchema,
      _meta: { ui: { visibility: ["model", "app"] } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ answerId, operation, expectedVersion, ...args }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const { sections, notes } = previewedSections(before.answer, operation, args);
      const preview = await makeChangePreview(store, operation, before, hypotheticalAnswer(before.answer, sections));
      preview.summary.push(...notes);
      return { structuredContent: preview, content: textContent(preview.summary.join("；")) };
    },
  );

  const editTextTool = registerTool(
    "edit_text",
    {
      title: "修改字句",
      description: "Use this when the user wants to change, add or delete specific words or sentences without resending whole sections. Each edit replaces the exact text `find` (heading or paragraph) with `replace`: to insert, keep the anchor text in `replace`; empty `replace` deletes (an emptied paragraph is removed); a newline splits the paragraph. A `find` occurring more than once needs `occurrence` (1-based) or `replaceAll`; `sectionId` limits the search. All edits apply as one new version or none do; the result lists each change with its page and line.",
      inputSchema: { ...textEditsInput, responseDetail: responseDetailSchema },
      outputSchema: editOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        ui: { visibility: ["model", "app"] },
        "openai/toolInvocation/invoking": "修改字句並重排…",
        "openai/toolInvocation/invoked": "字句已修改並重新計算行數。",
      },
    },
    async ({ responseDetail, answerId, edits, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const { sections, replacements } = applyTextEdits(before.answer.sections, edits);
      await store.saveAnswer(hypotheticalAnswer(before.answer, sections), { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const changes = describeChanges(before, current);
      const total = replacements.reduce((sum, count) => sum + count, 0);
      return {
        structuredContent: writeResponse({ ...current, replacements: total, changes }, responseDetail),
        content: textContent(`已修改 ${total} 處（版本 ${before.answer.version} → ${current.answer.version}）；${summarizeLayout(current.layout)}`
          + changes.map((line) => `\n・${line}`).join("") + numberingHint(current.answer.sections)),
      };
    },
  );

  const moveSectionTool = registerTool(
    "move_section",
    {
      title: "搬移申論區塊",
      description: "Use this when the user wants a section moved to another position: give beforeSectionId or afterSectionId (one of them). Only the order changes; the result lists the new order and the layout effect.",
      inputSchema: { responseDetail: responseDetailSchema, answerId: answerIdSchema, ...previewArgumentSchemas.move_section.shape, expectedVersion: expectedVersionSchema },
      outputSchema: z.object({ ...compactSnapshotShape, changes: z.array(z.string()) }).loose(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ responseDetail, answerId, sectionId, beforeSectionId, afterSectionId, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const sections = movedSections(before.answer, sectionId, { beforeSectionId, afterSectionId });
      await store.saveAnswer(hypotheticalAnswer(before.answer, sections), { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const changes = describeChanges(before, current);
      return {
        structuredContent: writeResponse({ ...current, changes }, responseDetail),
        content: textContent(`已搬移「${findSection(current.answer, sectionId).heading ?? sectionId}」（版本 ${before.answer.version} → ${current.answer.version}）；`
          + summarizeLayout(current.layout) + changes.map((line) => `\n・${line}`).join("") + numberingHint(current.answer.sections)),
      };
    },
  );

  const renumberItemsTool = registerTool(
    "renumber_items",
    {
      title: "重新編號",
      description: "Use this after items or sections were inserted, deleted or moved and their written numbers (壹、 一、 （一） 1. （1）) are no longer consecutive. Headings are numbered as one list and each section's paragraphs as their own, each level restarting under a higher one; sectionId limits it to that section's paragraphs. Preview with preview_change first.",
      inputSchema: { responseDetail: responseDetailSchema, answerId: answerIdSchema, ...previewArgumentSchemas.renumber_items.shape, expectedVersion: expectedVersionSchema },
      outputSchema: z.object({ ...compactSnapshotShape, renumbered: z.number().int().positive(), skipped: z.array(z.string()), changes: z.array(z.string()) }).loose(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ responseDetail, answerId, sectionId, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const { sections, renumbered, skipped } = renumberItems(before.answer.sections, sectionId);
      await store.saveAnswer(hypotheticalAnswer(before.answer, sections), { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const changes = describeChanges(before, current);
      return {
        structuredContent: writeResponse({ ...current, renumbered, skipped, changes }, responseDetail),
        content: textContent(`已重新編號 ${renumbered} 處（版本 ${before.answer.version} → ${current.answer.version}）；${summarizeLayout(current.layout)}`
          + changes.map((line) => `\n・${line}`).join("")
          + (skipped.length ? `\n${skippedNote(skipped)}` : "")),
      };
    },
  );

  server.registerResource("answer-review-plan-schema", "essay://schemas/review-plan", {
    title: "小問與驗收清單 JSON Schema", mimeType: "application/json",
    description: "Strict plan schema for set_answer_review; evidence is caller-reported, not server approval.",
  }, async uri => ({ contents: [{ uri: uri.href, mimeType: "application/json",
    text: JSON.stringify(z.toJSONSchema(reviewPlanSchema, { io: "input" })) }] }));

  registerTool("review_answer", {
    title: "檢查小問覆蓋與驗收紀錄",
    description: "Check mapped subquestions, score totals, source/scan review records and line allocation; never verifies semantic correctness or fetches sources.",
    inputSchema: { answerId: answerIdSchema, expectedVersion: expectedVersionSchema },
    outputSchema: z.object({ answerId: answerIdSchema, version: z.number().int().positive(), summary: z.string() }).loose(),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }, async ({ answerId, expectedVersion }) => {
    const current = await loadSnapshot(store, answerId);
    assertExpectedVersion(current.answer, expectedVersion);
    const template = await store.getTemplate(current.answer.templateId);
    const report = reviewAnswer(current.answer, template, current.layout);
    return { structuredContent: report, content: textContent(report.summary + report.issues.map(i => `\n${i.code}：${i.message}`).join("")) };
  });

  const setAnswerReviewTool = registerTool("set_answer_review", {
    title: "保存小問與驗收清單",
    description: "Replace or clear review plan at required expectedVersion; records caller evidence, not automatic approval. All prior evidence must be rechecked after edits.",
    // Keep the strict full schema in a resource rather than repeating it in every tools/list.
    inputSchema: { answerId: answerIdSchema, expectedVersion: z.number().int().positive(),
      plan: z.record(z.string(), z.unknown()).nullable().describe("Strict ReviewPlan JSON: read essay://schemas/review-plan. null clears the plan.") },
    outputSchema: z.object({ answerId: answerIdSchema, version: z.number().int().positive(), summary: z.string() }).loose(),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
  }, async ({ answerId, expectedVersion, plan: inputPlan }) => {
    const plan = inputPlan === null ? null : reviewPlanSchema.parse(inputPlan);
    const before = await loadSnapshot(store, answerId);
    assertExpectedVersion(before.answer, expectedVersion);
    for (const r of plan?.requirements ?? []) for (const id of r.sectionIds) findSection(before.answer, id);
    const template = await store.getTemplate(before.answer.templateId);
    const updated = hypotheticalAnswer({ ...before.answer, review: undefined }, before.answer.sections);
    if (plan) updated.review = { plan, reviewedVersion: updated.version, fingerprint: reviewFingerprint(updated, template) };
    if (Buffer.byteLength(JSON.stringify(updated)) > MAX_ANSWER_BYTES) throw new Error("答案超過 700 KiB 文件上限。");
    await store.saveAnswer(updated, { expectedVersion });
    const report = reviewAnswer(updated, template, layoutSections(template, updated.sections, updated.layoutOptions));
    return { structuredContent: report, content: textContent(report.summary + report.issues.map(i => `\n${i.code}：${i.message}`).join("")) };
  });

  const setLineTargetsTool = registerTool(
    "set_line_targets",
    {
      title: "設定各節目標行數",
      description: "Use this when the user plans how many lines each section should take (heading and spacing included); lines null clears a target. check_layout then reports each section against its target and where to expand or condense to fill or fit the sheet.",
      inputSchema: {
        answerId: answerIdSchema,
        targets: z.array(z.object({ sectionId: sectionIdSchema, lines: z.number().int().min(1).max(200).nullable() })).min(1).max(100),
        expectedVersion: expectedVersionSchema,
      },
      outputSchema: z.object({ answerId: answerIdSchema, version: z.number().int().positive(),
        sections: z.array(z.object({ sectionId: z.string(), lines: z.number() }).loose()), notes: z.array(z.string()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ answerId, targets, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const ids = new Set(before.answer.sections.map((section) => section.id));
      // Targets of sections that no longer exist are dropped with this write.
      const lineTargets = Object.fromEntries(Object.entries(before.answer.lineTargets ?? {}).filter(([id]) => ids.has(id)));
      for (const { sectionId, lines } of targets) {
        findSection(before.answer, sectionId);
        if (lines === null) delete lineTargets[sectionId];
        else lineTargets[sectionId] = lines;
      }
      const updated = hypotheticalAnswer({ ...before.answer, lineTargets }, before.answer.sections);
      const changes = describeTargetChanges(before.answer, updated);
      if (changes.length === 0) throw new Error("目標行數與目前設定相同，沒有需要儲存的變更。");
      await store.saveAnswer(updated, { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const plan = planLines(current.answer, current.layout);
      return {
        structuredContent: { answerId, version: current.answer.version, sections: plan.sections, notes: plan.notes },
        content: textContent(`已更新目標行數（版本 ${before.answer.version} → ${current.answer.version}）`
          + changes.map((line) => `\n・${line}`).join("") + `\n各節：${describeLines(plan.sections)}\n${plan.notes.join("\n")}`),
      };
    },
  );

  registerTool(
    "list_revisions",
    {
      title: "列出答案版本",
      description: "Use this when the user wants the saved versions of an answer, what changed in each, or a version to restore.",
      inputSchema: {
        answerId: answerIdSchema,
        limit: z.number().int().min(1).max(30).default(10),
      },
      outputSchema: revisionListOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ answerId, limit }) => {
      const current = await store.getAnswer(answerId);
      const template = await store.getTemplate(current.templateId);
      // One extra version, so the oldest listed one can still be compared with its predecessor.
      const stored = await store.listRevisions(answerId, { limit: limit + 1 });
      const byVersion = new Map(stored.map((revision) => [revision.version, revision]));
      byVersion.set(current.version, current);
      const revisions: Array<{ version: number; updatedAt: string; totalLines?: number; fits?: boolean;
        layoutError?: string; changes: string[] }> = [...byVersion.values()].sort((a, b) => b.version - a.version)
        // A version committed after `current` was read stays out, so at most `limit` are listed.
        .filter((revision) => revision.version <= current.version && revision.version > current.version - limit)
        .map((revision) => {
          let after: AnswerSnapshot;
          try {
            after = snapshot(revision, template);
          } catch (error) {
            const layoutError = error instanceof Error ? error.message : "未知版面錯誤";
            return { version: revision.version, updatedAt: revision.updatedAt, layoutError,
              changes: [`此版本版面無法計算：${layoutError}；可選擇其他可用版本還原。`] };
          }
          const previous = byVersion.get(revision.version - 1);
          let content: string[] | undefined;
          if (previous) {
            try { content = describeChanges(snapshot(previous, template), after, 8); }
            catch { content = ["前一版版面無法計算，無法比較內容版面差異。"]; }
          }
          const targets = previous ? [...describeInfoChanges(previous, revision), ...describeTargetChanges(previous, revision)] : [];
          // A version that only changed line targets lists just those, without "版面沒有改變。".
          const compared = content && (targets.length && content.join() === "版面沒有改變。" ? targets : [...content, ...targets]);
          const changes = revision.version === 1 ? ["建立答案。"] : compared ?? ["（前一版紀錄不存在，無法比較。）"];
          return { version: revision.version, updatedAt: revision.updatedAt, totalLines: after.layout.totalLines, fits: after.layout.fits, changes };
        });
      const olderVersions = Math.max(0, current.version - limit);
      return {
        structuredContent: { answerId, currentVersion: current.version, revisions, olderVersions },
        content: textContent(revisions.map((revision) => `第 ${revision.version} 版（${revision.updatedAt}，${revision.layoutError ? "版面無法計算" : `${revision.totalLines} 行${revision.fits ? "" : "，超出"}`}）：`
          + revision.changes.join("；")).join("\n") + (olderVersions ? `\n另有 ${olderVersions} 個更早的版本未列出。` : "")),
      };
    },
  );

  async function restoredAnswer(before: AnswerDocument, version: number): Promise<AnswerDocument> {
    if (version === before.version) throw new Error(`第 ${version} 版就是目前的版本，不需要還原。`);
    if (version > before.version) throw new Error(`目前最新是第 ${before.version} 版，沒有第 ${version} 版。`);
    let revision: AnswerDocument;
    try {
      revision = await store.getRevision(before.id, version);
    } catch (error) {
      if (isStoreNotFound(error)) throw new Error(`找不到第 ${version} 版的紀錄；可用 list_revisions 查看可還原的版本。`);
      throw error;
    }
    // Restore content and targets; keep current layoutOptions, like title and exam.
    return hypotheticalAnswer({ ...before, lineTargets: revision.lineTargets }, inLayoutOrder(revision.sections));
  }

  const restoreRevisionTool = registerTool(
    "restore_revision",
    {
      title: "還原答案版本",
      description: "Use this when the user wants the answer's sections back as they were in an earlier version (see list_revisions). It saves a new version, so the current content stays in the history and can itself be restored. Pass the current version as expectedVersion.",
      inputSchema: {
        responseDetail: responseDetailSchema,
        answerId: answerIdSchema,
        version: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      },
      outputSchema: z.object({ ...compactSnapshotShape, changes: z.array(z.string()) }).loose(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        ui: { visibility: ["model", "app"] },
        "openai/toolInvocation/invoking": "還原版本並重排…",
        "openai/toolInvocation/invoked": "已還原版本並重新計算行數。",
      },
    },
    async ({ responseDetail, answerId, version, expectedVersion }) => {
      // Read the current document without rendering it: an older invalid layout must not
      // block restoring valid history. Validate the chosen target before committing it.
      const stored = await store.getAnswer(answerId);
      const beforeAnswer = { ...stored, sections: inLayoutOrder(stored.sections) };
      assertExpectedVersion(beforeAnswer, expectedVersion);
      const restored = await restoredAnswer(beforeAnswer, version);
      const template = await store.getTemplate(restored.templateId);
      snapshot(restored, template);
      let before: AnswerSnapshot | undefined;
      let previousLayoutError: string | undefined;
      try { before = snapshot(beforeAnswer, template); }
      catch (error) { previousLayoutError = error instanceof Error ? error.message : "未知版面錯誤"; }
      await store.saveAnswer(restored, { expectedVersion: beforeAnswer.version });
      const current = await loadSnapshot(store, answerId);
      const contentChanges = before ? describeChanges(before, current)
        : [`先前版面無法計算：${previousLayoutError}；已從可用歷史版本還原，原紀錄仍保留。`];
      const targetChanges = describeTargetChanges(beforeAnswer, current.answer);
      const changes = targetChanges.length && contentChanges.join() === "版面沒有改變。"
        ? targetChanges : [...contentChanges, ...targetChanges];
      return {
        structuredContent: writeResponse({ ...current, changes }, responseDetail),
        content: textContent(`已還原第 ${version} 版的內容，存為第 ${current.answer.version} 版；${summarizeLayout(current.layout)}`
          + changes.map((line) => `\n・${line}`).join("")),
      };
    },
  );

  const deleteAnswerTool = registerTool(
    "delete_answer",
    {
      title: "刪除申論答案",
      description: "Use only for explicit permanent deletion; pass the current expectedVersion. Deletes the answer, revisions, export files and exam bundles containing it; cannot be restored.",
      inputSchema: {
        answerId: answerIdSchema,
        expectedVersion: z.number().int().positive(),
      },
      outputSchema: z.object({
        answerId: answerIdSchema,
        title: z.string(),
        version: z.number().int().positive(),
        deletedRevisions: z.number().int().nonnegative(),
        deletedExports: z.number().int().nonnegative(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "刪除答案…",
        "openai/toolInvocation/invoked": "答案已永久刪除。",
      },
    },
    async ({ answerId, expectedVersion }) => {
      let deleted;
      try {
        deleted = await store.deleteAnswer(answerId, { expectedVersion });
      } catch (error) {
        if (isStoreNotFound(error)) throw new Error(`找不到答案 ${answerId}；可能已刪除，或請確認 answerId。`);
        throw error;
      }
      return {
        structuredContent: {
          answerId,
          title: deleted.answer.title,
          version: deleted.answer.version,
          deletedRevisions: deleted.revisions,
          deletedExports: deleted.exports,
        },
        content: textContent(`已永久刪除「${deleted.answer.title}」（${answerId}，版本 ${deleted.answer.version}）；一併刪除 ${deleted.revisions} 筆修改紀錄與 ${deleted.exports} 個匯出檔。`),
      };
    },
  );

  registerTool(
    "reflow_answer",
    {
      title: "重新排版申論答案",
      description: "Use this after content changes when the user wants the authoritative line-by-line wrapping and page assignment; it recalculates from stored sections without asking the model to estimate.",
      inputSchema: { answerId: answerIdSchema },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ answerId }) => {
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: current, content: textContent(`已重新排版；${summarizeLayout(current.layout)}`) };
    },
  );

  registerTool(
    "check_layout",
    {
      title: "檢查申論版面",
      description: "Use this when the user wants exact page usage, remaining capacity, overflow count, or compression priorities for a saved answer.",
      inputSchema: { answerId: answerIdSchema },
      outputSchema: layoutOutputSchema,
      _meta: { ui: { visibility: ["model", "app"] } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ answerId }) => {
      const current = await loadSnapshot(store, answerId);
      const plan = planLines(current.answer, current.layout);
      const warnings = layoutWarnings(current.layout, await store.getTemplate(current.answer.templateId));
      const structuredContent = { answerId, version: current.answer.version, layout: current.layout, sections: plan.sections, notes: plan.notes, warnings };
      return { structuredContent, content: textContent(`${summarizeLayout(current.layout)}\n各節：${describeLines(plan.sections)}\n${plan.notes.join("\n")}${warnings.map((warning) => `\n${warning.code} 第${warning.page}頁第${warning.line}行：${warning.message}`).join("")}`) };
    },
  );

  registerTool(
    "render_answer_sheet",
    {
      title: "顯示申論答題紙畫板",
      description: "Use this when the user wants to view or edit a saved answer in an interactive canvas. Returns current answer/version and authoritative layout; 165 preview uses the original paper and exact font outlines.",
      inputSchema: { answerId: answerIdSchema, responseDetail: responseDetailSchema },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: ANSWER_SHEET_UI_META,
    },
    async ({ answerId, responseDetail }) => {
      const current = await loadSnapshot(store, answerId);
      const template = await store.getTemplate(current.answer.templateId);
      const paper = template.paperProfile ? { paperSvgPages: originalPaperPreview(template, current.layout) } : {};
      const readOnly = Boolean(options.readOnly || (options.scopes && !options.scopes.includes("essay.write")));
      return {
        structuredContent: { ...renderSummary(current, layoutWarnings(current.layout, template).length), ...(responseDetail === "full" ? { ...current, readOnly, ...paper } : {}) },
        content: textContent(`已準備答題紙畫板；${summarizeLayout(current.layout)}`),
        _meta: { snapshot: current, readOnly, ...paper },
      };
    },
  );

  registerTool(
    "render_exam_overview",
    {
      title: "顯示整場考試畫板",
      description: "Show exam progress and tabs, including missing questions; use once instead of render_answer_sheet per question.",
      inputSchema: { examId: examIdSchema.optional(), answerIds: z.array(answerIdSchema).min(1).max(20).optional(), activeAnswerId: answerIdSchema.optional(), responseDetail: responseDetailSchema },
      outputSchema: z.object({}).loose(),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: ANSWER_SHEET_UI_META,
    },
    async ({ examId, answerIds, activeAnswerId, responseDetail }) => {
      if (examId && answerIds) throw new Error("INVALID_INPUT：examId 與 answerIds 擇一。");
      const progress = examId ? await examProgress(store, examId) : undefined;
      answerIds ??= progress?.questions.flatMap(q => q.answerId ? [q.answerId] : []);
      if (!answerIds || (!examId && !answerIds.length)) throw new Error("INVALID_INPUT：請提供 examId 或 answerIds。");
      activeAnswerId ??= answerIds[0];
      if (new Set(answerIds).size !== answerIds.length) throw new Error("INVALID_INPUT：answerIds 不可重複。");
      if (activeAnswerId && !answerIds.includes(activeAnswerId)) throw new Error("INVALID_INPUT：activeAnswerId 必須是 answerIds 之一。");
      const snapshots: AnswerSnapshot[] = [], templates: AnswerTemplate[] = [], failures: string[] = [];
      for (const id of answerIds) {
        let answer: AnswerDocument;
        try { answer = await store.getAnswer(id); }
        catch (error) { if (!isStoreNotFound(error)) throw error; failures.push(`ANSWER_NOT_FOUND ${id}`); continue; }
        try {
          const template = await store.getTemplate(answer.templateId);
          snapshots.push(snapshot({ ...answer, sections: inLayoutOrder(answer.sections) }, template)); templates.push(template);
        } catch (error) { failures.push(`LAYOUT_INVALID ${answer.id}：${publicExportMessage(errorMessage(error))}`); }
      }
      if (failures.length && !progress) throw new Error([...failures.filter(f => f.startsWith("ANSWER_NOT_FOUND")), ...failures.filter(f => !f.startsWith("ANSWER_NOT_FOUND"))].join("\n"));
      activeAnswerId = snapshots.find(s => s.answer.id === activeAnswerId)?.answer.id ?? snapshots[0]?.answer.id;
      const current = snapshots.find(s => s.answer.id === activeAnswerId);
      const template = templates[snapshots.findIndex(s => s.answer.id === activeAnswerId)];
      const summaries = snapshots.map(({ answer, layout }, index) => ({ answerId: answer.id, title: answer.title,
        ...(answer.exam === undefined ? {} : { exam: answer.exam }), ...(answer.questionNo === undefined ? {} : { questionNo: answer.questionNo }),
        version: answer.version, totalLines: layout.totalLines, capacity: layout.capacity, fits: layout.fits,
        warnings: layoutWarnings(layout, templates[index]).length }));
      const examAnswers = progress ? progress.questions.map(q => ({ ...q, ...summaries.find(a => a.answerId === q.answerId), title: summaries.find(a => a.answerId === q.answerId)?.title ?? (q.stage === "drafted" ? "版面待修正" : "未建立") })) : summaries;
      const paper = current && template.paperProfile ? { paperSvgPages: originalPaperPreview(template, current.layout) } : {};
      const readOnly = Boolean(options.readOnly || (options.scopes && !options.scopes.includes("essay.write")));
      const overview = { activeAnswerId, examAnswers, ...(progress ? { examId, progress } : {}) };
      const full = { ...current, ...overview, readOnly, ...paper };
      return {
        structuredContent: { ...(current ? renderSummary(current, layoutWarnings(current.layout, template).length) : {}), ...overview,
          ...(responseDetail === "full" ? full : {}) },
        content: textContent(progress?.summary ?? summaries.map((answer, index) => `第${answer.questionNo ?? index + 1}題 ${answer.title}：${answer.totalLines}/${answer.capacity} 行，`
          + (answer.fits ? "符合" : `超出 ${answer.totalLines - answer.capacity} 行`) + `，警告 ${answer.warnings}`).join("\n") + "\n畫板以分頁切換題目。"),
        _meta: { snapshot: examId ? full : current, readOnly, ...paper },
      };
    },
  );

  const exporters = {
    docx: { run: exportDocx, label: " Word" },
    pdf: { run: exportPdf, label: " PDF" },
    txt: { run: exportText, label: "純文字" },
  } as const;

  /** Exports one format of the given snapshot; the readable file name is used for the link and the download. */
  async function exportSnapshot(current: AnswerSnapshot, format: ExportFormat, filename: string | undefined, allowOverflow: boolean, textMode = "paper") {
    const answerId = current.answer.id;
    const template = await store.getTemplate(current.answer.templateId);
    const outputPath = store.resolveExportPath(filename ?? `${answerId}_${Date.now()}`, format);
    return withTemporaryExport(outputPath, async (outputPath, temporaryDir) => {
      const paragraphs = format === "txt" && textMode === "paragraphs";
      const output = await (paragraphs ? exportParagraphTextBundle([{ report: current.layout, template }], outputPath, allowOverflow)
        : exporters[format].run(current.layout, template, outputPath, allowOverflow));
      const artifact = await store.createExportHandle(output.path, { answerId, answerVersion: current.answer.version, format, temporaryDir });
      const fileName = answerFileName(current.answer, format).replace(/\.txt$/, paragraphs ? "_段落.txt" : ".txt");
      const downloadUrl = options.downloadBaseUrl
        ? `${options.downloadBaseUrl}/downloads/${artifact.handle}/${encodeStrict(fileName)}` : undefined;
      return { output, artifact, exportUri: `essay://exports/${artifact.handle}`, fileName, downloadUrl };
    });
  }

  function registerExportTool(name: "export_docx" | "export_text" | "export_pdf", format: ExportFormat, base: {
    title: string; description: string; invoking: string; invoked: string;
  }) {
    return registerTool(
      name,
      {
        title: base.title,
        description: base.description,
        inputSchema: {
          answerId: answerIdSchema,
          expectedVersion: expectedVersionSchema,
          filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/).optional(),
          allowOverflow: z.boolean().default(false),
        },
        outputSchema: exportOutputSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
        _meta: {
          "openai/toolInvocation/invoking": base.invoking,
          "openai/toolInvocation/invoked": base.invoked,
        },
      },
      async ({ answerId, expectedVersion, filename, allowOverflow }) => {
        const answer = await store.getAnswer(answerId);
        assertExportVersion(answer, expectedVersion);
        const current = snapshot(answer, await store.getTemplate(answer.templateId));
        const { output, artifact, exportUri, fileName, downloadUrl } = await exportSnapshot(current, format, filename, allowOverflow);
        return {
          structuredContent: {
            answerId,
            version: current.answer.version,
            ...output,
            exportUri,
            exportExpiresAt: artifact.expiresAt,
            layout: current.layout,
            fileName,
            ...(downloadUrl ? { downloadUrl } : {}),
          },
          content: [
            ...textContent(`已輸出${exporters[format].label}：${output.path}；${summarizeLayout(current.layout)}`
              + (downloadUrl ? `\n下載「${fileName}」（24 小時內有效）：${downloadUrl}` : "")),
            exportArtifactLink(fileName, exportUri, artifact.mimeType),
          ],
        };
      },
    );
  }

  const exportDocxTool = registerExportTool("export_docx", "docx", {
    title: "輸出申論 Word",
    description: "Use this when the user wants a fixed-grid A4 Word document; by default export is refused unless the answer fits the configured page capacity.",
    invoking: "產生固定格線 Word…",
    invoked: "Word 已產生。",
  });

  const exportTextTool = registerExportTool("export_text", "txt", {
    title: "輸出申論純文字",
    description: "Use this when the user wants the authoritative wrapped answer as plain text with form-feed page breaks; by default export is refused unless the answer fits the configured page capacity.",
    invoking: "產生固定換行純文字…",
    invoked: "純文字已產生。",
  });

  const exportPdfTool = registerExportTool("export_pdf", "pdf", {
    title: "輸出申論 PDF",
    description: "Use this when the user wants a fixed-grid A4 PDF for printing; by default export is refused unless the answer fits the configured page capacity.",
    invoking: "產生固定格線 PDF…",
    invoked: "PDF 已產生。",
  });

  const exportAnswerTool = registerTool(
    "export_answer",
    {
      title: "一次輸出答案檔案",
      description: "Use this when the user wants the answer files: Word and PDF by default (formats picks any of docx, pdf, txt), all from the same version and named after the exam, question number and title. Refused unless the answer fits, unless allowOverflow.",
      inputSchema: {
        answerId: answerIdSchema,
        expectedVersion: expectedVersionSchema,
        formats: z.array(z.enum(["docx", "pdf", "txt"])).min(1).max(3).default(["docx", "pdf"]),
        textMode: textModeSchema,
        allowOverflow: z.boolean().default(false),
      },
      outputSchema: exportResultSchema(z.object({ answerId: answerIdSchema, version: z.number().int().positive(),
        files: z.array(z.object({ format: z.string(), fileName: z.string(), exportUri: z.string() }).loose()),
        failed: z.array(z.object({ format: z.string(), error: z.string() })) }).loose()),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "產生答案檔案…",
        "openai/toolInvocation/invoked": "答案檔案已產生。",
      },
    },
    async ({ answerId, expectedVersion, formats, allowOverflow, textMode }) => {
      let answer: AnswerDocument;
      try { answer = await store.getAnswer(answerId); }
      catch (error) { throw new ExportFailure([exportIssue(isStoreNotFound(error) ? "ANSWER_NOT_FOUND" : error instanceof z.ZodError || error instanceof SyntaxError ? "LAYOUT_INVALID" : "EXPORT_FAILED", error, { id: answerId })]); }
      try { assertExportVersion(answer, expectedVersion); }
      catch (error) { throw new ExportFailure([exportIssue("VERSION_CONFLICT", errorMessage(error), answer)]); }
      let current: AnswerSnapshot;
      try {
        const template = await store.getTemplate(answer.templateId).catch(error => {
          if (isStoreNotFound(error) || error instanceof z.ZodError || error instanceof SyntaxError) throw error;
          throw new ExportFailure([exportIssue("EXPORT_FAILED", error, answer)]);
        });
        current = snapshot(answer, template);
        if (!allowOverflow && !current.layout.fits) {
          throw new ExportFailure([exportIssue("LAYOUT_OVERFLOW", `答案超出版面 ${current.layout.overflowLines} 行，請先壓縮到兩頁內；確定要輸出超出的版本時帶 allowOverflow=true。`, answer)]);
        }
        outputPageCount(current.layout, template, allowOverflow);
      } catch (error) {
        if (error instanceof ExportFailure) throw error;
        throw new ExportFailure([exportIssue("LAYOUT_INVALID", errorMessage(error), answer)]);
      }
      const files = [];
      const failed: Array<{ format: ExportFormat; error: string }> = [];
      const errors: ExportIssue[] = [];
      // One failing format does not lose the files already made: they are returned with the failures.
      for (const format of [...new Set(formats)]) {
        try {
          const { output, artifact, exportUri, fileName, downloadUrl } = await exportSnapshot(current, format, undefined, allowOverflow, textMode);
          files.push({ format, fileName, exportUri, exportExpiresAt: artifact.expiresAt, pages: output.pages, mimeType: artifact.mimeType,
            ...("fontWarning" in output && output.fontWarning ? { fontWarning: output.fontWarning } : {}), ...(downloadUrl ? { downloadUrl } : {}) });
        } catch (error) {
          failed.push({ format, error: publicExportMessage(errorMessage(error)) });
          errors.push(exportIssue("EXPORT_FAILED", error, answer, format));
        }
      }
      if (files.length === 0) throw new ExportFailure(errors, failed.map((item) => `${item.format}：${item.error}`).join("；"));
      return {
        structuredContent: { answerId, version: current.answer.version, files, failed, ...(errors.length ? { errors } : {}) },
        content: [
          ...textContent(`已輸出第 ${current.answer.version} 版：${files.map((file) => `${file.fileName}（${file.pages} 頁）`).join("、")}；${summarizeLayout(current.layout)}`
            + files.filter((file) => file.fontWarning).map((file) => `\n${file.fileName}：${file.fontWarning}`).join("")
            + failed.map((item) => `\n${item.format} 沒有輸出：${item.error}`).join("")
            + files.filter((file) => file.downloadUrl).map((file) => `\n下載「${file.fileName}」（24 小時內有效）：${file.downloadUrl}`).join("")),
          ...files.map((file) => exportArtifactLink(file.fileName, file.exportUri, file.mimeType)),
        ],
      };
    },
  );

  const exportExamBundleTool = registerTool(
    "export_exam_bundle",
    {
      title: "輸出整場考試合輯",
      description: "Use this when the user wants several answers as PDF and Word by default, in the given order. Pin every expectedVersion from read_answer/check_layout; all answers are validated before rendering. PDF bookmarks identify questions; quality warnings do not block export.",
      inputSchema: {
        examId: examIdSchema.optional(),
        answers: z.array(z.object({ answerId: answerIdSchema, expectedVersion: z.number().int().positive() })).min(1).max(20).optional(),
        formats: examFormatsSchema.optional(),
        title: z.string().min(1).max(100).optional(),
        allowOverflow: z.boolean().default(false),
      },
      outputSchema: exportResultSchema(z.object({
        files: z.array(z.object({ format: z.string(), fileName: z.string(), exportUri: z.string(), exportExpiresAt: z.string(),
          pages: z.number().int().positive(), mimeType: z.string(), fontWarning: z.string().optional(), downloadUrl: z.string().optional() })),
        answers: z.array(z.object({ answerId: answerIdSchema, version: z.number().int().positive(), title: z.string(),
          pages: z.number().int().positive(), startPage: z.number().int().positive(), endPage: z.number().int().positive() }).loose()),
        totalPages: z.number().int().positive(),
      })),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    },
    async ({ examId, answers, formats, title, allowOverflow }, extra) => {
      const plan = examId ? await store.getExam(examId) : undefined;
      if (plan) {
        const missing = plan.questions.filter(q => !q.answerId);
        if (missing.length) throw new ExportFailure(missing.map(q => exportIssue("ANSWER_NOT_FOUND", `第${q.questionNo}題尚未建立。`, { questionNo: q.questionNo })));
        const planned = [...plan.questions].sort((a, b) => a.questionNo - b.questionNo);
        if (answers && (answers.length !== planned.length || planned.some((q, i) => q.answerId !== answers![i].answerId)))
          throw new ExportFailure([exportIssue("LAYOUT_INVALID", "answers 必須包含計畫全部題目並依題號排序。")]);
        answers ??= await Promise.all(planned.map(async q => {
          try { return { answerId: q.answerId!, expectedVersion: (await store.getAnswer(q.answerId!)).version }; }
          catch (error) { if (!isStoreNotFound(error)) throw error; throw new ExportFailure([exportIssue("ANSWER_NOT_FOUND", `第${q.questionNo}題答案不存在。`, { id: q.answerId, questionNo: q.questionNo })]); }
        }));
      }
      if (!answers?.length) throw new ExportFailure([exportIssue("LAYOUT_INVALID", "請提供 examId 或 answers。")]);
      const bundleFormats = [...new Set(formats ?? plan?.formats ?? ["pdf", "docx"] as const)];
      const total = 1 + answers.length * bundleFormats.length + bundleFormats.length + 1;
      let completed = 0;
      const notify = async (message: string) => {
        completed++;
        if (extra._meta?.progressToken !== undefined) await extra.sendNotification({ method: "notifications/progress",
          params: { progressToken: extra._meta.progressToken, progress: completed, total, message } }).catch(() => undefined);
      };
      const duplicates = [...new Set(answers.filter(({ answerId }, index) => answers.findIndex(answer => answer.answerId === answerId) < index).map(answer => answer.answerId))];
      if (duplicates.length) throw new ExportFailure(duplicates.map(id => exportIssue("LAYOUT_INVALID", `answers 的 answerId 不可重複：${id}`, { id })));
      const failures: ExportIssue[] = [];
      const entries: Array<AnswerSnapshot & { report: AnswerSnapshot["layout"]; template: AnswerTemplate; bookmark: string }> = [];
      const counts: number[] = [];
      // Load and validate every pinned snapshot before rendering any format or creating handles.
      for (const { answerId, expectedVersion } of answers) {
        let answer: AnswerDocument;
        try { answer = await store.getAnswer(answerId); }
        catch (error) {
          failures.push(exportIssue(isStoreNotFound(error) ? "ANSWER_NOT_FOUND" : error instanceof z.ZodError || error instanceof SyntaxError ? "LAYOUT_INVALID" : "EXPORT_FAILED",
            isStoreNotFound(error) ? `ANSWER_NOT_FOUND ${answerId}：找不到答案。` : error, { id: answerId }));
          continue;
        }
        if (answer.version !== expectedVersion) {
          failures.push(exportIssue("VERSION_CONFLICT", `VERSION_CONFLICT ${answerId}：目前版本 ${answer.version}，預期 ${expectedVersion}；請用 read_answer/check_layout 重新讀取。`, answer));
          continue;
        }
        try {
          const template = await store.getTemplate(answer.templateId).catch(error => {
            if (isStoreNotFound(error) || error instanceof z.ZodError || error instanceof SyntaxError) throw error;
            throw new ExportFailure([exportIssue("EXPORT_FAILED", error, answer)]);
          });
          const current = snapshot(answer, template);
          if (!allowOverflow && !current.layout.fits) {
            failures.push(exportIssue("LAYOUT_OVERFLOW", `LAYOUT_OVERFLOW ${answerId}：超出 ${current.layout.overflowLines} 行。`, answer));
            continue;
          }
          counts.push(outputPageCount(current.layout, template, allowOverflow));
          entries.push({ ...current, report: current.layout, template,
            bookmark: `第${answer.questionNo ?? entries.length + 1}題 ${answer.title}` });
        } catch (error) {
          if (error instanceof ExportFailure) failures.push(...error.errors);
          else failures.push(exportIssue("LAYOUT_INVALID", `LAYOUT_INVALID ${answerId}：${errorMessage(error)}`, answer));
        }
      }
      if (failures.length) throw new ExportFailure(failures);
      await notify("已驗證全部題目與版本");
      let totalPages = 0;
      const manifest = entries.map(({ answer, report, template }, index) => {
        const startPage = totalPages + 1;
        totalPages += counts[index];
        return { answerId: answer.id, version: answer.version, title: answer.title,
          ...(answer.exam === undefined ? {} : { exam: answer.exam }), ...(answer.questionNo === undefined ? {} : { questionNo: answer.questionNo }),
          pages: counts[index], startPage, endPage: totalPages, warnings: layoutWarnings(report, template) };
      });
      const first = entries[0].answer;
      const bundleTitle = title ?? (first.exam ? `${first.exam}_合輯` : "申論合輯");
      const files = await withTemporaryExport(`bundle_${randomUUID()}`, async (_, temporaryDir) => {
        const rendered = [];
        for (const format of bundleFormats) {
          try {
            const fileName = answerFileName({ title: bundleTitle }, format);
            const outputPath = path.join(temporaryDir, path.basename(store.resolveExportPath(`bundle_${randomUUID()}`, format)));
            const output = await (format === "pdf" ? exportPdfBundle : exportDocxBundle)(entries, outputPath, allowOverflow,
              async index => notify(`${format.toUpperCase()} 第${entries[index].answer.questionNo ?? index + 1}題已繪製`));
            await notify(`${format.toUpperCase()} 合輯已合併`);
            rendered.push({ format, fileName, output });
          } catch (error) { throw new ExportFailure([exportIssue("EXPORT_FAILED", error, undefined, format)]); }
        }
        const files = [];
        const handles: string[] = [];
        for (const { format, fileName, output } of rendered) {
          let artifact;
          try {
            // Every member owns the bundle lifetime; deleting any member removes its content.
            artifact = await store.createExportHandle(output.path, { answerId: first.id, answerVersion: first.version,
              relatedAnswerIds: entries.map(entry => entry.answer.id), format, temporaryDir });
          } catch (error) {
            const orphans: string[] = [];
            for (const handle of handles) {
              try { await store.deleteExport(handle); }
              catch { orphans.push(handle); }
            }
            throw new ExportFailure([exportIssue("EXPORT_FAILED", `合輯 ${format} 建立匯出 handle 失敗：${errorMessage(error)}`
              + (orphans.length ? `；回收失敗，遺留 handle：${orphans.join("、")}` : "；先前 handle 已回收。"), undefined, format, error)]);
          }
          handles.push(artifact.handle);
          const downloadUrl = options.downloadBaseUrl
            ? `${options.downloadBaseUrl}/downloads/${artifact.handle}/${encodeStrict(fileName)}` : undefined;
          files.push({ format, fileName, exportUri: `essay://exports/${artifact.handle}`, exportExpiresAt: artifact.expiresAt,
            pages: output.pages, mimeType: artifact.mimeType,
            ...("fontWarning" in output && output.fontWarning ? { fontWarning: output.fontWarning } : {}), ...(downloadUrl ? { downloadUrl } : {}) });
        }
        const failures: ExportIssue[] = [];
        try {
          for (const { answer } of entries) {
            try { await store.getAnswer(answer.id); }
            catch (error) { if (!isStoreNotFound(error)) throw error; failures.push(exportIssue("ANSWER_NOT_FOUND", `ANSWER_NOT_FOUND ${answer.id}：匯出期間已刪除`, answer)); }
          }
          if (failures.length) throw new ExportFailure(failures);
          if (plan) for (let attempt = 0; ; attempt++) {
            const latest = await store.getExam(plan.id);
            const linked = [...latest.questions].sort((a, b) => a.questionNo - b.questionNo);
            if (linked.length !== manifest.length || linked.some((q, i) => q.answerId !== manifest[i].answerId))
              throw new ExportFailure([exportIssue("VERSION_CONFLICT", "考試成員已變更，請呼叫 get_exam_progress 後重新匯出。")]);
            for (const member of manifest) {
              const current = await store.getAnswer(member.answerId);
              if (current.version !== member.version) throw new ExportFailure([exportIssue("VERSION_CONFLICT", "匯出期間答案已更新，請重新匯出。", current)]);
            }
            try {
              await store.saveExam({ ...latest, updatedAt: new Date().toISOString(), lastBundle: {
                formats: bundleFormats, members: manifest.map(m => ({ answerId: m.answerId, version: m.version })),
                pages: Object.fromEntries(files.map(file => [file.format, file.pages])), exportedAt: new Date().toISOString(),
              } }, { expectedVersion: latest.version });
              break;
            } catch (error) { if (attempt >= 2 || !isStoreConflict(error)) throw error; await conflictBackoff(attempt); }
          }
        } catch (error) {
          const orphans: string[] = [];
          for (const handle of handles) {
            try { await store.deleteExport(handle); }
            catch { orphans.push(handle); }
          }
          throw new ExportFailure(error instanceof ExportFailure ? error.errors : [exportIssue("EXPORT_FAILED", error)],
            errorMessage(error) + (orphans.length ? `；回收失敗，遺留 handle：${orphans.join("、")}` : ""));
        }
        return files;
      });
      await notify("合輯已保存");
      return {
        structuredContent: { files, answers: manifest, totalPages },
        content: [
          ...textContent(manifest.map((answer) => `${answer.answerId}「${answer.title}」第 ${answer.version} 版：第 ${answer.startPage}–${answer.endPage} 頁`
            + answer.warnings.map(warning => `\n  ${warning.code} 第 ${warning.page} 頁第 ${warning.line} 行：${warning.message}`).join("")).join("\n")
            + `\n共 ${totalPages} 頁。` + files.map((file) => `\n${file.fileName}：${file.downloadUrl ?? file.exportUri}`).join("")
            + files.filter((file) => file.fontWarning).map((file) => `\n${file.fileName}：${file.fontWarning}`).join("")),
          ...files.map((file) => exportArtifactLink(file.fileName, file.exportUri, file.mimeType)),
        ],
      };
    },
  );

  const updateAnswerInfoTool = registerTool(
    "update_answer_info",
    {
      title: "修改答案資訊",
      description: "Use this when the user wants to rename an answer or record which exam and question number it belongs to (or the question text); null clears exam, questionNo or question. list_answers groups answers by exam and orders them by question number.",
      inputSchema: {
        responseDetail: responseDetailSchema,
        answerId: answerIdSchema,
        title: z.string().min(1).max(300).optional(),
        exam: z.string().min(1).max(100).nullable().optional(),
        questionNo: z.number().int().min(1).max(20).nullable().optional(),
        question: z.string().max(10_000).nullable().optional(),
        layoutOptions: layoutOptionsSchema.optional().describe("Partial update; false turns an option off."),
        expectedVersion: expectedVersionSchema,
      },
      outputSchema: z.object({ ...compactSnapshotShape, changes: z.array(z.string()) }).loose(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ responseDetail, answerId, title, exam, questionNo, question, layoutOptions, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const pick = <T>(value: T | null | undefined, current: T | undefined) => value === undefined ? current : value ?? undefined;
      const updated = hypotheticalAnswer({ ...before.answer, title: title ?? before.answer.title, exam: pick(exam, before.answer.exam),
        layoutOptions: layoutOptions === undefined ? before.answer.layoutOptions : { ...before.answer.layoutOptions, ...layoutOptions },
        questionNo: pick(questionNo, before.answer.questionNo), question: pick(question, before.answer.question) }, before.answer.sections);
      const changes = describeInfoChanges(before.answer, updated);
      if (changes.length === 0) throw new Error("答案資訊與目前相同，沒有需要儲存的變更。");
      await store.saveAnswer(updated, { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      return {
        structuredContent: writeResponse({ ...current, changes }, responseDetail),
        content: textContent(`已更新答案資訊（版本 ${before.answer.version} → ${current.answer.version}）` + changes.map((line) => `\n・${line}`).join("")),
      };
    },
  );

  const duplicateAnswerTool = registerTool(
    "duplicate_answer",
    {
      title: "複製申論答案",
      description: "Use this when the user wants to try another version of an answer without touching the original: copies the current content, formats, exam, question number and line targets into a new answer (version 1, own history).",
      inputSchema: { responseDetail: responseDetailSchema, answerId: answerIdSchema, title: z.string().min(1).max(300).optional() },
      outputSchema: z.object(compactSnapshotShape).loose(),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    },
    async ({ responseDetail, answerId, title }) => {
      const source = await loadSnapshot(store, answerId);
      const fresh = createAnswerDocument({ templateId: source.answer.templateId, title: title ?? `${source.answer.title}（副本）`.slice(0, 300) });
      const copy = answerDocumentSchema.parse({ ...fresh, question: source.answer.question, exam: source.answer.exam,
        layoutOptions: source.answer.layoutOptions,
        questionNo: source.answer.questionNo, lineTargets: source.answer.lineTargets, sections: source.answer.sections });
      await store.saveAnswer(copy);
      const current = await loadSnapshot(store, copy.id);
      return {
        structuredContent: writeResponse(current, responseDetail),
        content: textContent(`已複製「${source.answer.title}」第 ${source.answer.version} 版為新答案「${copy.title}」（${copy.id}）；${summarizeLayout(current.layout)}`),
      };
    },
  );

  for (const [name, tool] of [
    ["start_exam", startExamTool], ["create_answer", createAnswerTool], ["create_answers", createAnswersTool], ["write_answer", writeAnswerTool], ["replace_text", replaceTextTool],
    ["format_section", formatSectionTool], ["insert_text", insertTextTool], ["delete_text", deleteTextTool],
    ["delete_answer", deleteAnswerTool], ["edit_text", editTextTool], ["restore_revision", restoreRevisionTool],
    ["move_section", moveSectionTool], ["renumber_items", renumberItemsTool], ["set_line_targets", setLineTargetsTool],
    ["update_answer_info", updateAnswerInfoTool], ["duplicate_answer", duplicateAnswerTool],
    ["set_answer_review", setAnswerReviewTool],
    ["export_docx", exportDocxTool], ["export_text", exportTextTool], ["export_pdf", exportPdfTool], ["export_answer", exportAnswerTool], ["export_exam_bundle", exportExamBundleTool],
  ] as const) {
    if (options.readOnly || (options.scopes && !options.scopes.includes(toolScope(name)))) tool.remove();
  }

  server.registerPrompt(
    "draft_answer",
    {
      title: "起草兩頁申論答案",
      description: "建立一個遵循固定格紙行數限制的申論起草工作提示。",
      argsSchema: {
        question: z.string().min(1),
        scoringPoints: z.string().optional(),
      },
    },
    ({ question, scoringPoints }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: [
            `請回答申論題：${question}`,
            scoringPoints ? `採點方向：${scoringPoints}` : "",
            "請先規劃 sections，再呼叫 create_answer 或 write_answer。寫入後務必呼叫 check_layout；若超過44行，依 compressionHints 修改後重試。",
            REVIEW_INSTRUCTION,
          ].filter(Boolean).join("\n"),
        },
      }],
    }),
  );

  server.registerPrompt(
    "compress_answer",
    {
      title: "把申論答案壓回格紙容量",
      description: "提供一個根據實際溢出行數與區塊優先級進行濃縮的工作提示。",
      argsSchema: {
        answerId: answerIdSchema,
        overflowLines: z.coerce.number().int().positive().optional(),
      },
    },
    ({ answerId, overflowLines }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `請讀取答案 ${answerId}，目前預估超出 ${overflowLines ?? "若干"} 行。依 sections 的 required、priority、compressible 與 check_layout 的 compressionHints，優先濃縮非核心說明；每次修改後都重新 check_layout，直到 fits=true。`,
        },
      }],
    }),
  );

  return server;
}

