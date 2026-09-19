import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  answerDocumentSchema,
  answerSectionInputSchema,
  answerSectionSchema as storedSectionSchema,
  createAnswerDocument,
  assertExpectedVersion,
  normalizeSection,
  type AnswerDocument,
  type AnswerSection,
  type AnswerSectionInput,
  type AnswerSnapshot,
  type AnswerTemplate,
  layoutReportSchema,
  templateSchema,
} from "./domain.js";
import { exportDocx, exportPdf, exportText } from "./exporters.js";
import { layoutSections, summarizeLayout } from "./layout.js";
import { FileStore } from "./storage.js";

export const DEFAULT_TEMPLATE_ID = "police_information_essay";

const expectedVersionSchema = z.number().int().positive().optional();
const answerIdSchema = z.string().regex(/^ans_[A-Za-z0-9-]+$/);

const snapshotOutputSchema = z.object({
  answer: answerDocumentSchema,
  layout: layoutReportSchema,
});

const layoutOutputSchema = z.object({
  answerId: answerIdSchema,
  version: z.number().int().positive(),
  layout: layoutReportSchema,
});

const sectionOutputSchema = z.object({
  section: storedSectionSchema,
  answer: answerDocumentSchema,
  layout: layoutReportSchema,
});

const exportOutputSchema = z.object({
  answerId: answerIdSchema,
  version: z.number().int().positive(),
  format: z.enum(["docx", "pdf", "txt"]),
  path: z.string(),
  pages: z.number().int().positive(),
  layout: layoutReportSchema,
  font: z.string().optional(),
  fontWarning: z.string().optional(),
});

function textContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
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

async function loadSnapshot(store: FileStore, answerId: string): Promise<AnswerSnapshot> {
  const answer = await store.getAnswer(answerId);
  const template = await store.getTemplate(answer.templateId);
  return snapshot(answer, template);
}

function sectionFromInput(input: AnswerSectionInput, order: number): AnswerSection {
  return normalizeSection(input, order);
}

function noAnswerFoundMessage(answerId: string): string {
  return `找不到答案 ${answerId}。先呼叫 create_answer 建立答案，或確認 answerId。`;
}

export function createEssayMcpServer(store = new FileStore()): McpServer {
  const server = new McpServer(
    {
      name: "police-essay-answer-sheet",
      version: "0.1.0",
    },
    {
      instructions:
        "這是一個固定版面國考申論答題紙 MCP。先呼叫 load_exam_paper 或 create_answer；所有答案都必須透過版面引擎計算行數。修改後呼叫 check_layout，只有 fits=true 才可視為符合兩頁限制。",
    },
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
          "2. create_answer / write_answer：把答案存成可編輯的 sections。",
          "3. read_answer / check_layout：查看每頁行數、剩餘行數與溢出。",
          "4. replace_text / insert_text / delete_text：只改指定區塊，並使用 expectedVersion 防止覆蓋別人的新版本。",
          "5. 超出時依 compressionHints 優先濃縮低優先級或可壓縮區塊，再重新 check_layout。",
          "6. fits=true 後才呼叫 export_docx 或 export_pdf。",
        ].join("\n"),
      }],
    }),
  );

  server.registerTool(
    "list_templates",
    {
      title: "列出答題紙模板",
      description: "Use this when the user wants to inspect available essay answer-sheet templates before creating an answer.",
      inputSchema: {},
      outputSchema: z.object({ templates: z.array(templateSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const templates = await store.listTemplates();
      return { structuredContent: { templates }, content: textContent(`共有 ${templates.length} 個答題紙模板。`) };
    },
  );

  server.registerTool(
    "load_exam_paper",
    {
      title: "載入申論答題紙",
      description: "Use this when the user wants to load a template or reopen an existing essay answer with its calculated grid layout.",
      inputSchema: {
        templateId: z.string().default(DEFAULT_TEMPLATE_ID),
        answerId: answerIdSchema.optional(),
      },
      outputSchema: z.object({
        template: templateSchema,
        answer: answerDocumentSchema.optional(),
        layout: layoutReportSchema.optional(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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

  server.registerTool(
    "list_answers",
    {
      title: "列出申論答案",
      description: "Use this when the user wants to find saved essay answers that can be reopened or edited.",
      inputSchema: {},
      outputSchema: z.object({ answers: z.array(answerDocumentSchema) }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const answers = await store.listAnswers();
      return { structuredContent: { answers }, content: textContent(`目前有 ${answers.length} 份已儲存答案。`) };
    },
  );

  server.registerTool(
    "create_answer",
    {
      title: "建立申論答案",
      description: "Use this when the user wants a new editable essay answer bound to a specific answer-sheet template.",
      inputSchema: {
        templateId: z.string().default(DEFAULT_TEMPLATE_ID),
        title: z.string().min(1).max(300),
        question: z.string().max(10_000).optional(),
        sections: z.array(answerSectionInputSchema).max(100).default([]),
      },
      outputSchema: snapshotOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
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

  server.registerTool(
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
        if (error instanceof Error && error.message.includes("ENOENT")) throw new Error(noAnswerFoundMessage(answerId));
        throw error;
      }
    },
  );

  server.registerTool(
    "write_answer",
    {
      title: "寫入完整申論答案",
      description: "Use this when the user has generated or rewritten the full answer and wants it stored as ordered editable sections; this does not guess line count, it delegates wrapping to the layout engine.",
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
      const answer = await store.getAnswer(answerId);
      assertExpectedVersion(answer, expectedVersion);
      const normalized = sections.map(sectionFromInput);
      ensureUniqueSectionIds(normalized);
      const updated = {
        ...answer,
        sections: normalized,
        version: answer.version + 1,
        updatedAt: new Date().toISOString(),
      } satisfies AnswerDocument;
      const validated = answerDocumentSchema.parse(updated);
      await store.saveAnswer(validated);
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: current, content: textContent(`已寫入；${summarizeLayout(current.layout)}`) };
    },
  );

  server.registerTool(
    "replace_text",
    {
      title: "替換申論區塊",
      description: "Use this when the user wants to revise one existing section without regenerating unrelated sections; the answer is reflowed after replacement.",
      inputSchema: {
        answerId: answerIdSchema,
        sectionId: z.string().min(1),
        newText: z.string().max(100_000),
        heading: z.string().max(200).nullable().optional(),
        expectedVersion: expectedVersionSchema,
      },
      outputSchema: sectionOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false, idempotentHint: false },
      _meta: {
        "openai/toolInvocation/invoking": "修改指定段落並重排…",
        "openai/toolInvocation/invoked": "段落已修改並重新計算行數。",
      },
    },
    async ({ answerId, sectionId, newText, heading, expectedVersion }) => {
      const answer = await store.getAnswer(answerId);
      assertExpectedVersion(answer, expectedVersion);
      const target = answer.sections.find((section) => section.id === sectionId);
      if (!target) throw new Error(`找不到 sectionId ${sectionId}。`);
      const updatedSections = answer.sections.map((section) =>
        section.id === sectionId
          ? { ...section, text: newText, ...(heading === undefined ? {} : { heading: heading ?? undefined }) }
          : section,
      );
      const updated = {
        ...answer,
        sections: updatedSections,
        version: answer.version + 1,
        updatedAt: new Date().toISOString(),
      } satisfies AnswerDocument;
      const validated = answerDocumentSchema.parse(updated);
      await store.saveAnswer(validated);
      const current = await loadSnapshot(store, answerId);
      const section = current.answer.sections.find((item) => item.id === sectionId);
      if (!section) throw new Error("替換後找不到 section。");
      return {
        structuredContent: { section, answer: current.answer, layout: current.layout },
        content: textContent(`已修改「${section.heading ?? section.id}」；${summarizeLayout(current.layout)}`),
      };
    },
  );

  server.registerTool(
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
      const answer = await store.getAnswer(answerId);
      assertExpectedVersion(answer, expectedVersion);
      if (afterSectionId && !answer.sections.some((item) => item.id === afterSectionId)) {
        throw new Error(`找不到 afterSectionId ${afterSectionId}。`);
      }
      const newSection = sectionFromInput(section, 0);
      const insertIndex = afterSectionId
        ? answer.sections.findIndex((item) => item.id === afterSectionId) + 1
        : answer.sections.length;
      const sections = [...answer.sections];
      sections.splice(insertIndex, 0, newSection);
      const updated = {
        ...answer,
        sections: sections.map((item, index) => ({ ...item, order: index })),
        version: answer.version + 1,
        updatedAt: new Date().toISOString(),
      } satisfies AnswerDocument;
      const validated = answerDocumentSchema.parse(updated);
      await store.saveAnswer(validated);
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: current, content: textContent(`已插入「${newSection.heading ?? newSection.id}」；${summarizeLayout(current.layout)}`) };
    },
  );

  server.registerTool(
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
      const answer = await store.getAnswer(answerId);
      assertExpectedVersion(answer, expectedVersion);
      if (!answer.sections.some((item) => item.id === sectionId)) throw new Error(`找不到 sectionId ${sectionId}。`);
      const sections = answer.sections.filter((item) => item.id !== sectionId).map((item, index) => ({ ...item, order: index }));
      const updated = {
        ...answer,
        sections,
        version: answer.version + 1,
        updatedAt: new Date().toISOString(),
      } satisfies AnswerDocument;
      const validated = answerDocumentSchema.parse(updated);
      await store.saveAnswer(validated);
      const current = await loadSnapshot(store, answerId);
      return { structuredContent: current, content: textContent(`已刪除 ${sectionId}；${summarizeLayout(current.layout)}`) };
    },
  );

  server.registerTool(
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

  server.registerTool(
    "check_layout",
    {
      title: "檢查申論版面",
      description: "Use this when the user wants exact page usage, remaining capacity, overflow count, or compression priorities for a saved answer.",
      inputSchema: { answerId: answerIdSchema },
      outputSchema: layoutOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ answerId }) => {
      const current = await loadSnapshot(store, answerId);
      const structuredContent = { answerId, version: current.answer.version, layout: current.layout };
      return { structuredContent, content: textContent(summarizeLayout(current.layout)) };
    },
  );

  server.registerTool(
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
      const output = await exportDocx(current.layout, template, outputPath, allowOverflow);
      return {
        structuredContent: { answerId, version: current.answer.version, ...output, layout: current.layout },
        content: textContent(`已輸出 Word：${output.path}；${summarizeLayout(current.layout)}`),
      };
    },
  );

  server.registerTool(
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
      const output = await exportText(current.layout, template, outputPath, allowOverflow);
      return {
        structuredContent: { answerId, version: current.answer.version, ...output, layout: current.layout },
        content: textContent(`已輸出純文字：${output.path}；${summarizeLayout(current.layout)}`),
      };
    },
  );

  server.registerTool(
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
      const output = await exportPdf(current.layout, template, outputPath, allowOverflow);
      return {
        structuredContent: { answerId, version: current.answer.version, ...output, layout: current.layout },
        content: textContent(`已輸出 PDF：${output.path}；${summarizeLayout(current.layout)}`),
      };
    },
  );

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
