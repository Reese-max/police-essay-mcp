import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  answerDocumentSchema,
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
import { describeLines, describeTargetChanges, planLines } from "./planning.js";
import { answerFileName, describeAnswerList, describeInfoChanges, encodeStrict, sortAnswers, type ExportFormat } from "./answer-info.js";
import { exportDocx, exportPdf, exportText, withTemporaryExport } from "./exporters.js";
import { layoutSections, summarizeLayout } from "./layout.js";
import { FileStore, isStoreNotFound, type EssayStore } from "./storage.js";
import { originalPaperPreview } from "./original-paper.js";
import { ANSWER_SHEET_WIDGET_URI, POLICE_ESSAY_WIDGET_HTML } from "./widget.js";

import { toolScope } from "./oauth.js";

export const DEFAULT_TEMPLATE_ID = "police_information_essay";

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
});

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
});

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
});

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
  return { answer, layout: layoutSections(template, answer.sections) };
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

/** Formatting tools state the 166 paper limits up front so the model explains them instead of retrying. */
export const PAPER_FORMAT_NOTE = " The 166 original-paper template (police_information_essay_166) accepts only left-aligned text without bold or italic; tell the user so instead of attempting that formatting.";
const FORMATTING_TOOLS = new Set(["create_answer", "write_answer", "replace_text", "format_section", "insert_text", "preview_change"]);
const PAPER_FORMAT_INSTRUCTION = "166 原稿紙模板（police_information_essay_166）只接受靠左、非粗體、非斜體的標準楷書；使用者要求粗體、斜體、置中、靠右或分散對齊時，直接說明不支援，不要嘗試寫入。";

const EDIT_INSTRUCTION = "修改字詞或句子時用 edit_text，只送要改的原文片段與新文字，不要重送整段或整份答案；replace_text 只用於整段改寫，write_answer 只用於整份重寫。任何修改都可先用 preview_change（operation 填要預覽的工具名稱，其餘參數與該工具相同）把變更清單給使用者確認，套用後把回傳的變更清單告訴使用者。改錯或想回到舊版時，用 list_revisions 查版本，再以 restore_revision 還原（還原會另存新版本，不會刪除紀錄）。搬移區塊用 move_section；插入、刪除或搬移後若手寫的編號（壹、一、（一）、1.）不再連續，用 renumber_items 重新編號。使用者規劃各節行數時用 set_line_targets，之後 check_layout 會回報各節行數、與目標的差距，以及要補滿或壓縮時該從哪一節增減。使用者要檔案時用 export_answer（預設一次輸出 Word 與 PDF，檔名用考試、題號與標題），回覆裡有下載連結時直接提供給使用者。答案屬於哪場考試、第幾題用 update_answer_info 記錄；想試寫另一個版本時用 duplicate_answer 複製。";

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
        "這是一個固定版面國考申論答題紙 MCP。先呼叫 load_exam_paper 或 create_answer；所有答案都必須透過版面引擎計算行數。使用者要求觀看、建立後顯示或編輯時，呼叫 render_answer_sheet 顯示互動答題紙畫板。修改後呼叫 check_layout，只有 fits=true 才可視為符合兩頁限制。" + EDIT_INSTRUCTION + PAPER_FORMAT_INSTRUCTION,
    },
  );

  const registerTool: typeof server.registerTool = (name, base, callback) => {
    const config = FORMATTING_TOOLS.has(name) ? { ...base, description: (base.description ?? "") + PAPER_FORMAT_NOTE } : base;
    return server.registerTool(name, options.scopes ? { ...config, _meta: { ...config._meta,
      securitySchemes: [{ type: "oauth2", scopes: [...new Set(["essay.read", toolScope(name)])] }],
    } } : config, callback);
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
      const template = await store.getTemplate(DEFAULT_TEMPLATE_ID);
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
          "1. load_exam_paper：讀模板或既有答案。",
          "2. create_answer / write_answer：把答案存成可編輯的 sections；可在 paragraphs.format 設定縮排、對齊、間距、Tab 與粗體。" + PAPER_FORMAT_INSTRUCTION,
          "3. read_answer / check_layout：查看每頁行數、剩餘行數與溢出。",
          "4. format_section：只改 section 或指定 paragraphs 的格式，不必重送文字；使用 expectedVersion 防止覆蓋別人的新版本。",
          "5. edit_text：改字詞或句子時只送原文片段（find）與新文字（replace），一次可改多處、全部成功才存檔。",
          "6. replace_text / insert_text / delete_text：整段改寫、插入或刪除區塊，並使用 expectedVersion 防止覆蓋別人的新版本。",
          "7. preview_change：任何修改前都可預覽；operation 填要預覽的工具（write_answer、replace_text、format_section、insert_text、delete_text、edit_text、move_section、renumber_items），其餘參數與該工具相同，不會存檔。",
          "8. list_revisions / restore_revision：查看每個版本改了什麼，必要時還原舊版本；還原會另存新版本。",
          "9. move_section：把區塊移到另一個區塊之前或之後；插入、刪除或搬移後編號不連續時，用 renumber_items 重新編號（標題自成一串，各區塊段落各自一串）。",
          "10. set_line_targets：設定各節目標行數；check_layout 回報各節行數與目標差距，並建議補滿或壓縮時從哪一節增減。",
          "11. update_answer_info：改標題、題目，或記錄考試名稱與題號（list_answers 依考試分組、依題號排序）；duplicate_answer：複製一份答案試寫另一個版本。",
          "12. export_answer：一次輸出 Word 與 PDF（formats 可選 docx、pdf、txt），檔名用考試、題號與標題；有下載連結時直接給使用者。",
          "13. 超出時依 compressionHints 優先濃縮低優先級或可壓縮區塊，再重新 check_layout。",
          "14. 使用者要求畫面預覽或編輯時呼叫 render_answer_sheet，顯示互動答題紙畫板；畫板可重新檢查版面並預覽／套用區塊修改。",
          "15. fits=true 後才呼叫 export_docx 或 export_pdf。",
          "16. 只有使用者明確要求永久刪除答案時才呼叫 delete_answer，並帶目前的 expectedVersion；刪除後無法復原。",
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
        templateId: z.string().default(DEFAULT_TEMPLATE_ID),
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
      const template = await store.getTemplate(templateId);
      if (!answerId) {
        return {
          structuredContent: { template },
          content: textContent(`已載入「${template.name}」：${template.pages}頁、每頁${template.linesPerPage}行、總容量${template.pages * template.linesPerPage}行。`),
        };
      }
      const answer = await store.getAnswer(answerId);
      if (answer.templateId !== template.id) {
        throw new Error(`答案使用的模板是 ${answer.templateId}，不是 ${template.id}。`);
      }
      const layout = layoutSections(template, answer.sections);
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

  const createAnswerTool = registerTool(
    "create_answer",
    {
      title: "建立申論答案",
      description: "Use this when the user wants a new editable essay answer bound to a specific answer-sheet template. Sections support per-paragraph indentation, alignment, spacing, tabs, emphasis, and automatic heading styles.",
      inputSchema: {
        templateId: z.string().default(DEFAULT_TEMPLATE_ID),
        title: z.string().min(1).max(300),
        question: z.string().max(10_000).optional(),
        sections: z.array(answerSectionInputSchema).max(100).default([]),
      },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        ...ANSWER_SHEET_UI_META,
        "openai/toolInvocation/invoking": "建立答題紙…",
        "openai/toolInvocation/invoked": "答題紙已建立。",
      },
    },
    async ({ templateId, title, question, sections }) => {
      await store.getTemplate(templateId);
      const answer = createAnswerDocument({ templateId, title, question, sections });
      ensureUniqueSectionIds(answer.sections);
      await store.saveAnswer(answer);
      const current = await loadSnapshot(store, answer.id);
      return {
        structuredContent: current,
        content: textContent(`已建立 ${answer.id}；${summarizeLayout(current.layout)}`),
      };
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
      _meta: ANSWER_SHEET_UI_META,
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
    async ({ answerId, sections, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      await store.saveAnswer(hypotheticalAnswer(answer, writtenSections(sections)), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: current, content: textContent(`已寫入；${summarizeLayout(current.layout)}${changeText(before, current)}`) };
    },
  );

  const replaceTextTool = registerTool(
    "replace_text",
    {
      title: "替換申論區塊",
      description: "Use this when the user wants to revise one existing section without regenerating unrelated sections; optional paragraphs can replace the text with independent formatting, and the answer is reflowed afterward.",
      inputSchema: replacementContentSchema.extend({
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
    async ({ answerId, sectionId, newText, paragraphs, heading, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      const sections = replacedSections(answer, sectionId, { newText, paragraphs, heading });
      await store.saveAnswer(hypotheticalAnswer(answer, sections), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      const section = current.answer.sections.find((item) => item.id === sectionId);
      if (!section) throw new Error("替換後找不到 section。");
      return {
        structuredContent: { section, answer: current.answer, layout: current.layout },
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
    async ({ answerId, sectionId, paragraphFormat, headingStyle, paragraphFormats, expectedVersion }) => {
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
        structuredContent: { section, answer: current.answer, layout: current.layout },
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
    async ({ answerId, afterSectionId, section, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      const { sections, inserted: newSection } = insertedSections(answer, afterSectionId, section);
      await store.saveAnswer(hypotheticalAnswer(answer, sections), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: current, content: textContent(`已插入「${newSection.heading ?? newSection.id}」；${summarizeLayout(current.layout)}${changeText(before, current)}`
        + numberingHint(current.answer.sections)) };
    },
  );

  const deleteTextTool = registerTool(
    "delete_text",
    {
      title: "刪除申論區塊",
      description: "Use this when the user explicitly wants to remove one section from an answer; the remaining sections are reflowed afterward.",
      inputSchema: {
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
    async ({ answerId, sectionId, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      const answer = before.answer;
      assertExpectedVersion(answer, expectedVersion);
      await store.saveAnswer(hypotheticalAnswer(answer, deletedSections(answer, sectionId)), { expectedVersion: answer.version });
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: current, content: textContent(`已刪除 ${sectionId}；${summarizeLayout(current.layout)}${changeText(before, current)}`
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
      inputSchema: textEditsInput,
      outputSchema: editOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        ui: { visibility: ["model", "app"] },
        "openai/toolInvocation/invoking": "修改字句並重排…",
        "openai/toolInvocation/invoked": "字句已修改並重新計算行數。",
      },
    },
    async ({ answerId, edits, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const { sections, replacements } = applyTextEdits(before.answer.sections, edits);
      await store.saveAnswer(hypotheticalAnswer(before.answer, sections), { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const changes = describeChanges(before, current);
      const total = replacements.reduce((sum, count) => sum + count, 0);
      return {
        structuredContent: { ...current, replacements: total, changes },
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
      inputSchema: { answerId: answerIdSchema, ...previewArgumentSchemas.move_section.shape, expectedVersion: expectedVersionSchema },
      outputSchema: z.object({ ...compactSnapshotShape, changes: z.array(z.string()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ answerId, sectionId, beforeSectionId, afterSectionId, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const sections = movedSections(before.answer, sectionId, { beforeSectionId, afterSectionId });
      await store.saveAnswer(hypotheticalAnswer(before.answer, sections), { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const changes = describeChanges(before, current);
      return {
        structuredContent: { ...current, changes },
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
      inputSchema: { answerId: answerIdSchema, ...previewArgumentSchemas.renumber_items.shape, expectedVersion: expectedVersionSchema },
      outputSchema: z.object({ ...compactSnapshotShape, renumbered: z.number().int().positive(), skipped: z.array(z.string()), changes: z.array(z.string()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
      _meta: { ui: { visibility: ["model", "app"] } },
    },
    async ({ answerId, sectionId, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const { sections, renumbered, skipped } = renumberItems(before.answer.sections, sectionId);
      await store.saveAnswer(hypotheticalAnswer(before.answer, sections), { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const changes = describeChanges(before, current);
      return {
        structuredContent: { ...current, renumbered, skipped, changes },
        content: textContent(`已重新編號 ${renumbered} 處（版本 ${before.answer.version} → ${current.answer.version}）；${summarizeLayout(current.layout)}`
          + changes.map((line) => `\n・${line}`).join("")
          + (skipped.length ? `\n${skippedNote(skipped)}` : "")),
      };
    },
  );

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
    return hypotheticalAnswer({ ...before, lineTargets: revision.lineTargets }, inLayoutOrder(revision.sections));
  }

  const restoreRevisionTool = registerTool(
    "restore_revision",
    {
      title: "還原答案版本",
      description: "Use this when the user wants the answer's sections back as they were in an earlier version (see list_revisions). It saves a new version, so the current content stays in the history and can itself be restored. Pass the current version as expectedVersion.",
      inputSchema: {
        answerId: answerIdSchema,
        version: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      },
      outputSchema: z.object({ ...compactSnapshotShape, changes: z.array(z.string()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        ui: { visibility: ["model", "app"] },
        "openai/toolInvocation/invoking": "還原版本並重排…",
        "openai/toolInvocation/invoked": "已還原版本並重新計算行數。",
      },
    },
    async ({ answerId, version, expectedVersion }) => {
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
        structuredContent: { ...current, changes },
        content: textContent(`已還原第 ${version} 版的內容，存為第 ${current.answer.version} 版；${summarizeLayout(current.layout)}`
          + changes.map((line) => `\n・${line}`).join("")),
      };
    },
  );

  const deleteAnswerTool = registerTool(
    "delete_answer",
    {
      title: "刪除申論答案",
      description: "Use this only when the user explicitly asks to permanently delete a saved answer. Pass the current version from read_answer or list_answers as expectedVersion. The answer, its revision history and its exports are removed and cannot be restored.",
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
      const structuredContent = { answerId, version: current.answer.version, layout: current.layout, sections: plan.sections, notes: plan.notes };
      return { structuredContent, content: textContent(`${summarizeLayout(current.layout)}\n各節：${describeLines(plan.sections)}\n${plan.notes.join("\n")}`) };
    },
  );

  registerTool(
    "render_answer_sheet",
    {
      title: "顯示申論答題紙畫板",
      description: "Use this when the user wants to view or edit a saved answer in an interactive canvas. Returns current answer/version and authoritative layout; 166 preview uses the original paper and exact font outlines.",
      inputSchema: { answerId: answerIdSchema },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: ANSWER_SHEET_UI_META,
    },
    async ({ answerId }) => {
      const current = await loadSnapshot(store, answerId);
      const template = await store.getTemplate(current.answer.templateId);
      return {
        structuredContent: current,
        content: textContent(`已準備答題紙畫板；${summarizeLayout(current.layout)}`),
        _meta: { readOnly: Boolean(options.readOnly || (options.scopes && !options.scopes.includes("essay.write"))), ...(template.paperProfile ? { paperSvgPages: originalPaperPreview(template, current.layout) } : {}) },
      };
    },
  );

  const exporters = {
    docx: { run: exportDocx, label: " Word" },
    pdf: { run: exportPdf, label: " PDF" },
    txt: { run: exportText, label: "純文字" },
  } as const;

  /** Exports one format of the given snapshot; the readable file name is used for the link and the download. */
  async function exportSnapshot(current: AnswerSnapshot, format: ExportFormat, filename: string | undefined, allowOverflow: boolean) {
    const answerId = current.answer.id;
    const template = await store.getTemplate(current.answer.templateId);
    const outputPath = store.resolveExportPath(filename ?? `${answerId}_${Date.now()}`, format);
    return withTemporaryExport(outputPath, async (outputPath, temporaryDir) => {
      const output = await exporters[format].run(current.layout, template, outputPath, allowOverflow);
      const artifact = await store.createExportHandle(output.path, { answerId, answerVersion: current.answer.version, format, temporaryDir });
      const fileName = answerFileName(current.answer, format);
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
      async ({ answerId, filename, allowOverflow }) => {
        const current = await loadSnapshot(store, answerId);
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
        formats: z.array(z.enum(["docx", "pdf", "txt"])).min(1).max(3).default(["docx", "pdf"]),
        allowOverflow: z.boolean().default(false),
      },
      outputSchema: z.object({ answerId: answerIdSchema, version: z.number().int().positive(),
        files: z.array(z.object({ format: z.string(), fileName: z.string(), exportUri: z.string() }).loose()),
        failed: z.array(z.object({ format: z.string(), error: z.string() })) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "產生答案檔案…",
        "openai/toolInvocation/invoked": "答案檔案已產生。",
      },
    },
    async ({ answerId, formats, allowOverflow }) => {
      const current = await loadSnapshot(store, answerId);
      if (!allowOverflow && !current.layout.fits) {
        throw new Error(`答案超出版面 ${current.layout.overflowLines} 行，請先壓縮到兩頁內；確定要輸出超出的版本時帶 allowOverflow=true。`);
      }
      const files = [];
      const failed: Array<{ format: ExportFormat; error: string }> = [];
      // One failing format does not lose the files already made: they are returned with the failures.
      for (const format of [...new Set(formats)]) {
        try {
          const { output, artifact, exportUri, fileName, downloadUrl } = await exportSnapshot(current, format, undefined, allowOverflow);
          files.push({ format, fileName, exportUri, exportExpiresAt: artifact.expiresAt, pages: output.pages, mimeType: artifact.mimeType,
            ...("fontWarning" in output && output.fontWarning ? { fontWarning: output.fontWarning } : {}), ...(downloadUrl ? { downloadUrl } : {}) });
        } catch (error) {
          failed.push({ format, error: error instanceof Error ? error.message : String(error) });
        }
      }
      if (files.length === 0) throw new Error(failed.map((item) => `${item.format}：${item.error}`).join("；"));
      return {
        structuredContent: { answerId, version: current.answer.version, files, failed },
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

  const updateAnswerInfoTool = registerTool(
    "update_answer_info",
    {
      title: "修改答案資訊",
      description: "Use this when the user wants to rename an answer or record which exam and question number it belongs to (or the question text); null clears exam, questionNo or question. list_answers groups answers by exam and orders them by question number.",
      inputSchema: {
        answerId: answerIdSchema,
        title: z.string().min(1).max(300).optional(),
        exam: z.string().min(1).max(100).nullable().optional(),
        questionNo: z.number().int().min(1).max(20).nullable().optional(),
        question: z.string().max(10_000).nullable().optional(),
        expectedVersion: expectedVersionSchema,
      },
      outputSchema: z.object({ ...compactSnapshotShape, changes: z.array(z.string()) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: true },
    },
    async ({ answerId, title, exam, questionNo, question, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const pick = <T>(value: T | null | undefined, current: T | undefined) => value === undefined ? current : value ?? undefined;
      const updated = hypotheticalAnswer({ ...before.answer, title: title ?? before.answer.title, exam: pick(exam, before.answer.exam),
        questionNo: pick(questionNo, before.answer.questionNo), question: pick(question, before.answer.question) }, before.answer.sections);
      const changes = describeInfoChanges(before.answer, updated);
      if (changes.length === 0) throw new Error("答案資訊與目前相同，沒有需要儲存的變更。");
      await store.saveAnswer(updated, { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      return {
        structuredContent: { ...current, changes },
        content: textContent(`已更新答案資訊（版本 ${before.answer.version} → ${current.answer.version}）` + changes.map((line) => `\n・${line}`).join("")),
      };
    },
  );

  const duplicateAnswerTool = registerTool(
    "duplicate_answer",
    {
      title: "複製申論答案",
      description: "Use this when the user wants to try another version of an answer without touching the original: copies the current content, formats, exam, question number and line targets into a new answer (version 1, own history).",
      inputSchema: { answerId: answerIdSchema, title: z.string().min(1).max(300).optional() },
      outputSchema: z.object(compactSnapshotShape),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
    },
    async ({ answerId, title }) => {
      const source = await loadSnapshot(store, answerId);
      const fresh = createAnswerDocument({ templateId: source.answer.templateId, title: title ?? `${source.answer.title}（副本）`.slice(0, 300) });
      const copy = answerDocumentSchema.parse({ ...fresh, question: source.answer.question, exam: source.answer.exam,
        questionNo: source.answer.questionNo, lineTargets: source.answer.lineTargets, sections: source.answer.sections });
      await store.saveAnswer(copy);
      const current = await loadSnapshot(store, copy.id);
      return {
        structuredContent: current,
        content: textContent(`已複製「${source.answer.title}」第 ${source.answer.version} 版為新答案「${copy.title}」（${copy.id}）；${summarizeLayout(current.layout)}`),
      };
    },
  );

  for (const [name, tool] of [
    ["create_answer", createAnswerTool], ["write_answer", writeAnswerTool], ["replace_text", replaceTextTool],
    ["format_section", formatSectionTool], ["insert_text", insertTextTool], ["delete_text", deleteTextTool],
    ["delete_answer", deleteAnswerTool], ["edit_text", editTextTool], ["restore_revision", restoreRevisionTool],
    ["move_section", moveSectionTool], ["renumber_items", renumberItemsTool], ["set_line_targets", setLineTargetsTool],
    ["update_answer_info", updateAnswerInfoTool], ["duplicate_answer", duplicateAnswerTool],
    ["export_docx", exportDocxTool], ["export_text", exportTextTool], ["export_pdf", exportPdfTool], ["export_answer", exportAnswerTool],
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

