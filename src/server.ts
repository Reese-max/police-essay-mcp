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

const layoutOutputSchema = z.object({
  answerId: answerIdSchema,
  version: z.number().int().positive(),
  layout: layoutSummarySchema,
});

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
const PREVIEW_OPERATIONS = ["write_answer", "replace_text", "format_section", "insert_text", "delete_text", "edit_text"] as const;
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
  // Each entry also carries updatedAt, totalLines and fits.
  revisions: z.array(z.object({ version: z.number().int().positive(), changes: z.array(z.string()) }).loose()),
  olderVersions: z.number().int().nonnegative(),
});

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
});

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

async function loadSnapshot(store: EssayStore, answerId: string): Promise<AnswerSnapshot> {
  const answer = await store.getAnswer(answerId);
  const template = await store.getTemplate(answer.templateId);
  return snapshot(answer, template);
}

function sectionFromInput(input: AnswerSectionInput, order: number): AnswerSection {
  return normalizeSection(input, order);
}

function hypotheticalAnswer(answer: AnswerDocument, sections: AnswerSection[]): AnswerDocument {
  return answerDocumentSchema.parse({
    ...answer,
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
function previewedSections(answer: AnswerDocument, operation: PreviewOperation, args: Record<string, unknown>): AnswerSection[] {
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

const EDIT_INSTRUCTION = "修改字詞或句子時用 edit_text，只送要改的原文片段與新文字，不要重送整段或整份答案；replace_text 只用於整段改寫，write_answer 只用於整份重寫。任何修改都可先用 preview_change（operation 填要預覽的工具名稱，其餘參數與該工具相同）把變更清單給使用者確認，套用後把回傳的變更清單告訴使用者。改錯或想回到舊版時，用 list_revisions 查版本，再以 restore_revision 還原（還原會另存新版本，不會刪除紀錄）。";

function noAnswerFoundMessage(answerId: string): string {
  return `找不到答案 ${answerId}。先呼叫 create_answer 建立答案，或確認 answerId。`;
}

export function createEssayMcpServer(store: EssayStore = new FileStore(), options: { readOnly?: boolean; scopes?: string[] } = {}): McpServer {
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
          "7. preview_change：任何修改前都可預覽；operation 填要預覽的工具（write_answer、replace_text、format_section、insert_text、delete_text、edit_text），其餘參數與該工具相同，不會存檔。",
          "8. list_revisions / restore_revision：查看每個版本改了什麼，必要時還原舊版本；還原會另存新版本。",
          "9. 超出時依 compressionHints 優先濃縮低優先級或可壓縮區塊，再重新 check_layout。",
          "10. 使用者要求畫面預覽或編輯時呼叫 render_answer_sheet，顯示互動答題紙畫板；畫板可重新檢查版面並預覽／套用區塊修改。",
          "11. fits=true 後才呼叫 export_docx 或 export_pdf。",
          "12. 只有使用者明確要求永久刪除答案時才呼叫 delete_answer，並帶目前的 expectedVersion；刪除後無法復原。",
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
      const answers = await store.listAnswers();
      return { structuredContent: { answers }, content: textContent(`目前有 ${answers.length} 份已儲存答案。`) };
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
      return { structuredContent: current, content: textContent(`已插入「${newSection.heading ?? newSection.id}」；${summarizeLayout(current.layout)}${changeText(before, current)}`) };
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
      return { structuredContent: current, content: textContent(`已刪除 ${sectionId}；${summarizeLayout(current.layout)}${changeText(before, current)}`) };
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
      description: "Use this before any write tool when the user wants to see what it would change without saving: each changed paragraph with its page and line, the line-count delta and any overflow. Set operation to the write tool being previewed and pass that tool's own arguments with it: write_answer (sections), replace_text (sectionId, newText or paragraphs, heading), format_section (sectionId, paragraphFormat, headingStyle, paragraphFormats), insert_text (section, afterSectionId), delete_text (sectionId) or edit_text (edits).",
      inputSchema: {
        answerId: answerIdSchema,
        operation: z.enum(PREVIEW_OPERATIONS),
        expectedVersion: expectedVersionSchema,
        // Every previewed tool's arguments, all optional here; previewedSections checks them per operation.
        sections: previewArgumentSchemas.write_answer.shape.sections.optional(),
        sectionId: sectionIdSchema.optional(),
        ...replacementContentSchema.shape,
        ...formattingPayloadSchema.shape,
        afterSectionId: sectionIdSchema.optional(),
        section: answerSectionInputSchema.optional(),
        edits: textEditsSchema.optional(),
      },
      outputSchema: changePreviewOutputSchema,
      _meta: { ui: { visibility: ["model", "app"] } },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ answerId, operation, expectedVersion, ...args }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      const sections = previewedSections(before.answer, operation, args);
      const preview = await makeChangePreview(store, operation, before, hypotheticalAnswer(before.answer, sections));
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
          + changes.map((line) => `\n・${line}`).join("")),
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
    },
    async ({ answerId, limit }) => {
      const current = await store.getAnswer(answerId);
      const template = await store.getTemplate(current.templateId);
      // One extra version, so the oldest listed one can still be compared with its predecessor.
      const stored = await store.listRevisions(answerId, { limit: limit + 1 });
      const byVersion = new Map(stored.map((revision) => [revision.version, revision]));
      byVersion.set(current.version, current);
      const revisions = [...byVersion.values()].sort((a, b) => b.version - a.version)
        // A version committed after `current` was read stays out, so at most `limit` are listed.
        .filter((revision) => revision.version <= current.version && revision.version > current.version - limit)
        .map((revision) => {
          const after = snapshot(revision, template);
          const previous = byVersion.get(revision.version - 1);
          const changes = revision.version === 1 ? ["建立答案。"]
            : previous ? describeChanges(snapshot(previous, template), after, 8) : ["（前一版紀錄不存在，無法比較。）"];
          return { version: revision.version, updatedAt: revision.updatedAt, totalLines: after.layout.totalLines, fits: after.layout.fits, changes };
        });
      const olderVersions = Math.max(0, current.version - limit);
      return {
        structuredContent: { answerId, currentVersion: current.version, revisions, olderVersions },
        content: textContent(revisions.map((revision) => `第 ${revision.version} 版（${revision.updatedAt}，${revision.totalLines} 行${revision.fits ? "" : "，超出"}）：`
          + revision.changes.join("；")).join("\n") + (olderVersions ? `\n另有 ${olderVersions} 個更早的版本未列出。` : "")),
      };
    },
  );

  async function restoredAnswer(before: AnswerSnapshot, version: number): Promise<AnswerDocument> {
    if (version === before.answer.version) throw new Error(`第 ${version} 版就是目前的版本，不需要還原。`);
    if (version > before.answer.version) throw new Error(`目前最新是第 ${before.answer.version} 版，沒有第 ${version} 版。`);
    let revision: AnswerDocument;
    try {
      revision = await store.getRevision(before.answer.id, version);
    } catch (error) {
      if (isStoreNotFound(error)) throw new Error(`找不到第 ${version} 版的紀錄；可用 list_revisions 查看可還原的版本。`);
      throw error;
    }
    return hypotheticalAnswer(before.answer, revision.sections);
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
        "openai/toolInvocation/invoking": "還原版本並重排…",
        "openai/toolInvocation/invoked": "已還原版本並重新計算行數。",
      },
    },
    async ({ answerId, version, expectedVersion }) => {
      const before = await loadSnapshot(store, answerId);
      assertExpectedVersion(before.answer, expectedVersion);
      await store.saveAnswer(await restoredAnswer(before, version), { expectedVersion: before.answer.version });
      const current = await loadSnapshot(store, answerId);
      const changes = describeChanges(before, current);
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
      const structuredContent = { answerId, version: current.answer.version, layout: current.layout };
      return { structuredContent, content: textContent(summarizeLayout(current.layout)) };
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

  const exportDocxTool = registerTool(
    "export_docx",
    {
      title: "輸出申論 Word",
      description: "Use this when the user wants a fixed-grid A4 Word document; by default export is refused unless the answer fits the configured page capacity.",
      inputSchema: {
        answerId: answerIdSchema,
        filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/).optional(),
        allowOverflow: z.boolean().default(false),
      },
      outputSchema: exportOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "產生固定格線 Word…",
        "openai/toolInvocation/invoked": "Word 已產生。",
      },
    },
    async ({ answerId, filename, allowOverflow }) => {
      const current = await loadSnapshot(store, answerId);
      const template = await store.getTemplate(current.answer.templateId);
      const outputPath = store.resolveExportPath(filename ?? `${answerId}_${Date.now()}`, "docx");
      return withTemporaryExport(outputPath, async (outputPath, temporaryDir) => {
        const output = await exportDocx(current.layout, template, outputPath, allowOverflow);
        const artifact = await store.createExportHandle(output.path, {
          answerId,
          answerVersion: current.answer.version,
          format: "docx",
          temporaryDir,
        });
        const exportUri = `essay://exports/${artifact.handle}`;
        return {
          structuredContent: {
            answerId,
            version: current.answer.version,
            ...output,
            exportUri,
            exportExpiresAt: artifact.expiresAt,
            layout: current.layout,
          },
          content: [
            ...textContent(`已輸出 Word：${output.path}；${summarizeLayout(current.layout)}`),
            exportArtifactLink(artifact.name, exportUri, artifact.mimeType),
          ],
        };
      });
    },
  );

  const exportTextTool = registerTool(
    "export_text",
    {
      title: "輸出申論純文字",
      description: "Use this when the user wants the authoritative wrapped answer as plain text with form-feed page breaks; by default export is refused unless the answer fits the configured page capacity.",
      inputSchema: {
        answerId: answerIdSchema,
        filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/).optional(),
        allowOverflow: z.boolean().default(false),
      },
      outputSchema: exportOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "產生固定換行純文字…",
        "openai/toolInvocation/invoked": "純文字已產生。",
      },
    },
    async ({ answerId, filename, allowOverflow }) => {
      const current = await loadSnapshot(store, answerId);
      const template = await store.getTemplate(current.answer.templateId);
      const outputPath = store.resolveExportPath(filename ?? `${answerId}_${Date.now()}`, "txt");
      return withTemporaryExport(outputPath, async (outputPath, temporaryDir) => {
        const output = await exportText(current.layout, template, outputPath, allowOverflow);
        const artifact = await store.createExportHandle(output.path, {
          answerId,
          answerVersion: current.answer.version,
          format: "txt",
          temporaryDir,
        });
        const exportUri = `essay://exports/${artifact.handle}`;
        return {
          structuredContent: {
            answerId,
            version: current.answer.version,
            ...output,
            exportUri,
            exportExpiresAt: artifact.expiresAt,
            layout: current.layout,
          },
          content: [
            ...textContent(`已輸出純文字：${output.path}；${summarizeLayout(current.layout)}`),
            exportArtifactLink(artifact.name, exportUri, artifact.mimeType),
          ],
        };
      });
    },
  );

  const exportPdfTool = registerTool(
    "export_pdf",
    {
      title: "輸出申論 PDF",
      description: "Use this when the user wants a fixed-grid A4 PDF for printing; by default export is refused unless the answer fits the configured page capacity.",
      inputSchema: {
        answerId: answerIdSchema,
        filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/).optional(),
        allowOverflow: z.boolean().default(false),
      },
      outputSchema: exportOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "產生固定格線 PDF…",
        "openai/toolInvocation/invoked": "PDF 已產生。",
      },
    },
    async ({ answerId, filename, allowOverflow }) => {
      const current = await loadSnapshot(store, answerId);
      const template = await store.getTemplate(current.answer.templateId);
      const outputPath = store.resolveExportPath(filename ?? `${answerId}_${Date.now()}`, "pdf");
      return withTemporaryExport(outputPath, async (outputPath, temporaryDir) => {
        const output = await exportPdf(current.layout, template, outputPath, allowOverflow);
        const artifact = await store.createExportHandle(output.path, {
          answerId,
          answerVersion: current.answer.version,
          format: "pdf",
          temporaryDir,
        });
        const exportUri = `essay://exports/${artifact.handle}`;
        return {
          structuredContent: {
            answerId,
            version: current.answer.version,
            ...output,
            exportUri,
            exportExpiresAt: artifact.expiresAt,
            layout: current.layout,
          },
          content: [
            ...textContent(`已輸出 PDF：${output.path}；${summarizeLayout(current.layout)}`),
            exportArtifactLink(artifact.name, exportUri, artifact.mimeType),
          ],
        };
      });
    },
  );

  for (const [name, tool] of [
    ["create_answer", createAnswerTool], ["write_answer", writeAnswerTool], ["replace_text", replaceTextTool],
    ["format_section", formatSectionTool], ["insert_text", insertTextTool], ["delete_text", deleteTextTool],
    ["delete_answer", deleteAnswerTool], ["edit_text", editTextTool], ["restore_revision", restoreRevisionTool],
    ["export_docx", exportDocxTool], ["export_text", exportTextTool], ["export_pdf", exportPdfTool],
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

