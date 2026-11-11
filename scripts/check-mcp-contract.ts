import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer, PAPER_FORMAT_NOTE } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import { ANSWER_SHEET_WIDGET_URI } from "../src/widget.js";
import { toolScope } from "../src/oauth.js";

export const INTENTIONAL_DIFFERENCES = [{ path: "*.tools[review_answer];owner.tools[set_answer_review];*.resources[answer-review-plan-schema]",
  reason: "Add explicit, version-bound review manifests and read-only structural checks; source and semantic correctness remain not_checked. Full plan schema is a resource to retain the tools/list budget." }, { path: "*.tools[check_layout,create_answer,delete_text,format_section,insert_text,list_answers,list_templates,load_exam_paper,read_answer,render_answer_sheet,replace_text,write_answer].description;owner.tools[create_answer].inputSchema.examId;*.tools[start_exam,get_exam_progress]",
  reason: "Exam plans and derived resume progress; optional examId links creates. Exact short descriptions replace workflow prose moved to server instructions to preserve the 80000-byte budget." },
{ path: "*.tools[render_exam_overview]",
  reason: "New essay.read canvas tool opens ordered answers in one widget with question tabs and a selected full snapshot." },
{ path: "owner.tools[create_answers]",
  reason: "New essay.write batch create tool validates all items before saving and shares retry-safe create semantics." },
{ path: "*.tools[read_answer]._meta",
  reason: "Data reads no longer open the widget. Remove only base read_answer metadata before comparison; current read_answer must have no UI resourceUri or outputTemplate." },
{ path: "owner.tools[export_exam_bundle]",
  reason: "New essay.export tool combines ordered, version-pinned answers into PDF and Word, with page ranges and layout warnings." },
{ path: "owner.tools[create_answer,write_answer,replace_text,format_section,insert_text,delete_text,render_answer_sheet].inputSchema.responseDetail;owner.tools[create_answer].inputSchema.exam,questionNo,lineTargets,idempotencyKey,layoutOptions",
  reason: "Declared optional input additions: compact write/render responses default to summary with full opt-in; create records exam, question number, line targets and per-answer layout options in version 1, with retry-safe idempotencyKey. Strip exactly these optional properties before base comparison. Paragraph and heading format objects also gain optional hangingIndent (continuation-line indent beside firstLineIndent); strip only that key." },
{ path: "oauth.tools[*]._meta.securitySchemes",
  reason: "Base has no OAuth support; preserve Round B OAuth scope declarations. All other fields must equal base." },
{ path: "*.tools[*].outputSchema",
  reason: "Write tools share a minimal loose answer/layout schema without changing structuredContent; output schemas must stay structural subsets of the base." },
{ path: "owner.tools[delete_answer]",
  reason: "New owner-only destructive tool (essay.write) removing an answer with its revisions and exports; requires the user's quoted deletion request (userRequest)." },
{ path: "owner.tools[delete_exam];*.tools[get_exam_progress].structuredContent.version",
  reason: "Owner-only essay.write deletion requires the current plan version and no existing linked answers; progress exposes that version and remaining artifacts expire via lifecycle." },
{ path: "*.tools[edit_text,list_revisions,preview_change,restore_revision]",
  reason: "New editing, preview and version history tools: edit_text and restore_revision need essay.write; the list and the preview are read-only (essay.read). preview_change advertises only answerId, operation and expectedVersion; top-level passthrough arguments still use the selected write tool schema." },
{ path: "owner.tools[duplicate_answer,export_answer,update_answer_info]",
  reason: "New answer-management tools: rename or file an answer under an exam and question number and duplicate it (essay.write); export several formats at once with readable names (essay.export)." },
{ path: "owner.tools[move_section,renumber_items,set_line_targets]",
  reason: "New writing tools (essay.write): move a section, renumber written item numbers, and set per-section line targets that check_layout reports against." },
{ path: "*.tools[check_layout].outputSchema.additionalProperties",
  reason: "Loosened so check_layout can also return each section's lines against its target (sections, notes)." },
{ path: "*.tools[preview_delete_text,preview_format_section,preview_insert_text,preview_replace_text,preview_write_answer]",
  reason: "Removed: merged into the read-only preview_change, which takes the previewed write tool's name and arguments." },
{ path: "*.tools[load_exam_paper,render_answer_sheet]._meta,*.resources[police-information-essay-answer-sheet-widget].uri",
  reason: "The widget URI carries a version so hosts drop a cached widget that calls removed tools; the base URI is restored before comparing." },
{ path: "*.tools[*].inputSchema,*.tools[*].outputSchema,*.prompts[*].argsSchema: paragraph format and heading style fields",
  reason: "Format inputs drop their default keyword: an omitted field now inherits from the section and template instead of being reset to the default (Zod 4 fills defaults inside .partial()). Base defaults are removed before comparing." },
{ path: "*.tools[create_answer,load_exam_paper].inputSchema.templateId.default",
  reason: "User-authorized default for newly created answers and template-only loads is police_information_essay_165. Explicit templates and saved-answer template identity are preserved. Normalize only this exact default before base comparison." },
{ path: "*.tools[create_answer,format_section,insert_text,replace_text,write_answer].description",
  reason: "Formatting tools append the 165 paper formatting limits; the base description stays the exact prefix." },
{ path: "owner.tools[export_docx,export_pdf,export_text];*.tools[reflow_answer]",
   reason: "User-approved removals: export_answer retains multi-format exports, version binding, overflow guards and TXT modes. reflow_answer only read a freshly computed snapshot; read_answer/check_layout already recompute layout." },
{ path: "*.resourceTemplates[export-artifact].description",
   reason: "Export resource guidance names export_answer and export_exam_bundle instead of the removed legacy tools." }];
export const BASE_COMMIT = "18cb1760160d2849039277c13546f168a0956329";
export const ADDED_TOOLS = ["review_answer", "set_answer_review", "start_exam", "get_exam_progress", "create_answers", "delete_answer", "delete_exam", "duplicate_answer", "edit_text", "export_answer", "export_exam_bundle", "list_revisions", "move_section",
  "preview_change", "render_exam_overview", "renumber_items", "restore_revision", "set_line_targets", "update_answer_info"];
/** Added tools that only need essay.read, so read credentials list them too. */
export const ADDED_READ_TOOLS = ["review_answer", "get_exam_progress", "list_revisions", "preview_change", "render_exam_overview"];
/** Removed base tools that were visible with essay.read. Legacy exports required essay.export. */
export const REMOVED_READ_TOOLS = ["preview_delete_text", "preview_format_section", "preview_insert_text", "preview_replace_text", "preview_write_answer", "reflow_answer"];
export const REMOVED_TOOLS = [...REMOVED_READ_TOOLS, "export_docx", "export_pdf", "export_text"];
/** Tools whose description is the base description followed by PAPER_FORMAT_NOTE. */
export const PAPER_NOTE_TOOLS = ["create_answer", "format_section", "insert_text", "replace_text", "write_answer"];
const BASE_WIDGET_URI = "ui://widget/police-essay-answer-sheet.html";
/** Fields only paragraph formats and heading styles have together; their schema objects lost their defaults. */
const FORMAT_FIELDS = ["firstLineIndent", "tabSize"];
/** Upper bound for the serialized owner tools/list; the base contract was ~262 KB. */
export const TOOLS_LIST_BUDGET_BYTES = 80_000;
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
type JsonSchema = Record<string, unknown>;
type ContractTool = { name: string; outputSchema?: JsonSchema; _meta?: Record<string, unknown> } & Record<string, unknown>;
/** Only load_exam_paper adds an optional, unconstrained caller-guidance field.
 * Keep the pinned base and the general subset validator strict for all other fields. */
export function withoutWritingGuide(schema: JsonSchema, toolName: string): JsonSchema {
  if (toolName !== "load_exam_paper") return schema;
  const properties = schema.properties as JsonSchema;
  assert.ok(properties && "writingGuide" in properties, "load_exam_paper missing declared writingGuide addition");
  assert.deepEqual(properties.writingGuide, {}, "writingGuide must remain an unconstrained output");
  assert.ok(!((schema.required ?? []) as string[]).includes("writingGuide"), "writingGuide must be optional");
  const { writingGuide: _guide, ...baseProperties } = properties;
  return { ...schema, properties: baseProperties };
}
/**
 * A compact schema may drop object fields (and must then allow them via additionalProperties),
 * but every field it keeps carries the base field's keywords unchanged.
 */
export function assertSchemaSubset(compact: unknown, base: unknown, where: string): void {
  assert.ok(compact && typeof compact === "object" && base && typeof base === "object", where + " must be an object schema");
  const c = compact as JsonSchema, b = base as JsonSchema;
  for (const key of Object.keys(b)) {
    if (["properties", "required", "additionalProperties"].includes(key)) continue;
    assert.ok(key in c, `${where} drops base keyword ${key}`);
  }
  const dropped = Object.keys((b.properties ?? {}) as JsonSchema).some(name => !(name in ((c.properties ?? {}) as JsonSchema)));
  if (dropped) assert.notEqual(c.additionalProperties, false, `${where} must allow the dropped base fields`);
  for (const [key, value] of Object.entries(c)) {
    if (key === "properties") {
      const baseProperties = (b.properties ?? {}) as JsonSchema;
      for (const [name, schema] of Object.entries(value as JsonSchema)) {
        assert.ok(name in baseProperties, `${where}.${name} is not a base field`);
        assertSchemaSubset(schema, baseProperties[name], `${where}.${name}`);
      }
    } else if (key === "items") assertSchemaSubset(value, b.items, where + "[]");
    else if (key === "required") {
      assert.ok((value as string[]).every(name => ((b.required ?? []) as string[]).includes(name)), `${where} requires a field the base does not`);
    } else if (key === "additionalProperties") {
      assert.ok(isDeepStrictEqual(value, b.additionalProperties) || isDeepStrictEqual(value, {}), `${where}.additionalProperties tightened`);
    } else assert.deepEqual(value, b[key], `${where}.${key} differs from base`);
  }
}
/** Exact, declared baseline-to-short-description replacements; never derive expectations from live code. */
export const DESCRIPTION_CHANGES: Record<string, { before: string; after: string }> = {
  "check_layout": {
    "before": "Use this when the user wants exact page usage, remaining capacity, overflow count, or compression priorities for a saved answer.",
    "after": "Read authoritative line usage, overflow, targets and quality warnings, not content verification. For fit/export tasks call for EVERY answer before compression and again after its last edit, including answers that batch or overview tools report as fitting. Reuse checks for unchanged versions. Report planned targets separately from actual usage."
  },
  "create_answer": {
    "before": "Use this when the user wants a new editable essay answer bound to a specific answer-sheet template. Sections support per-paragraph indentation, alignment, spacing, tabs, emphasis, and automatic heading styles.",
    "after": "Create an editable answer. For one question use this directly with examId=null (or omitted); do not start_exam or render_exam_overview. Nonempty paragraphs take precedence over text. Omit templateId for the default 165 paper; pass one only when the user picks a paper. Indent values are display-width units: one full-width cell is 2, so a 2-cell first-line indent is firstLineIndent 4. Preserve supplied drafts; include explicit section IDs, matching lineTargets in version 1 and known exam/questionNo. Allocate targets from the user's budget or template capacity, not current usage; do not expand drafts to meet targets. examId resumes existing planned questions; retry with the same idempotencyKey and identical request."
  },
  "delete_text": {
    "before": "Use this when the user explicitly wants to remove one section from an answer; the remaining sections are reflowed afterward.",
    "after": "Delete one section only when its removal is explicitly requested or authorized; compression alone is not permission to remove sections. preview_change can preview first."
  },
  "format_section": {
    "before": "Use this when the user wants to change indentation, alignment, spacing, tabs, emphasis, heading style, or selected paragraph formats without resending or rewriting the section text.",
    "after": "Change section/paragraph formatting without rewriting content; use expectedVersion. Indent values are display-width units: one full-width cell is 2, so a 2-cell first-line indent is firstLineIndent 4."
  },
  "insert_text": {
    "before": "Use this when the user wants to add a new section at a precise position in an existing answer; the complete answer is reflowed afterward.",
    "after": "Insert a section after afterSectionId, or append when omitted; use expectedVersion."
  },
  "list_answers": {
    "before": "Use this when the user wants to find saved essay answers that can be reopened or edited.",
    "after": "Find saved answers grouped by exam and ordered by question number. Reuse a known answerId instead of listing again."
  },
  "list_templates": {
    "before": "Use this when the user wants to inspect available essay answer-sheet templates before creating an answer.",
    "after": "List templates only when choosing a non-default paper (ids are paper specs, not subject tags); omitting templateId selects the 165 original paper."
  },
  "load_exam_paper": {
    "before": "Use this when the user wants to load a template or reopen an existing essay answer with its calculated grid layout.",
    "after": "Load template geometry and formatting rules. Before allocating proportional line targets, load the suitable known/default template if its capacity is not already available; no preceding list_templates is needed. Layout summaries are not full original text or substitutes for per-answer check_layout."
  },
  "read_answer": {
    "before": "Use this when the user wants the complete structured answer, section metadata, and exact rendered lines.",
    "after": "Read the complete answer, section IDs, current version and rendered lines; no canvas. Before compression obtain the full original, not just a layout summary; reuse full text already available."
  },
  "render_answer_sheet": {
    "before": "Use this when the user wants to view or edit a saved answer in an interactive canvas. Returns current answer/version and authoritative layout; 166 preview uses the original paper and exact font outlines.",
    "after": "Show one answer canvas with authoritative layout and editing controls; the client renders it, so the default result's line usage and status suffice — omit responseDetail=full unless per-line data is needed. For multiple questions use one render_exam_overview instead."
  },
  "replace_text": {
    "before": "Use this when the user wants to revise one existing section without regenerating unrelated sections; optional paragraphs can replace the text with independent formatting, and the answer is reflowed afterward.",
    "after": "Replace one section's text or paragraphs at expectedVersion; nonempty paragraphs take precedence over newText; omit heading to keep it (a new heading replaces it, null removes it); other sections stay untouched. During compression retain headings, numbered subheadings and distinct substantive points; do not replace multiple sections with one summary."
  },
  "write_answer": {
    "before": "Use this when the user has generated or rewritten the full answer and wants it stored as ordered editable sections; paragraph-level formatting is preserved and line count is delegated to the layout engine.",
    "after": "Replace all sections at expectedVersion only for a whole-answer rewrite or explicitly requested content clearing; include every section that must remain. Prefer edit_text or replace_text for targeted edits and compression. Keep section IDs, headings, numbering, order, each question's block and distinct substantive points; merge only verbatim-identical or same-point restatements."
  }
};
export function withBaseDescriptions<T extends { tools: ContractTool[] }>(view: T, baseline: ContractTool[]): T {
  return { ...view, tools: view.tools.map(tool => {
    const change = DESCRIPTION_CHANGES[tool.name];
    if (!change) return tool;
    assert.equal(baseline.find(t => t.name === tool.name)?.description, change.before, `${tool.name} baseline description`);
    assert.equal(tool.description, change.after + (PAPER_NOTE_TOOLS.includes(tool.name) ? PAPER_FORMAT_NOTE : ""), `${tool.name} short description`);
    return { ...tool, description: change.before };
  }) };
}
function withoutOutputSchemas<T extends { tools: ContractTool[] }>(view: T, drop: string[] = []): T {
  return { ...view, tools: view.tools.filter(tool => !drop.includes(tool.name)).map(({ outputSchema: _output, ...tool }) => tool) };
}
/** Guard the one authorized default change while preserving every other schema keyword. */
export function withBaseTemplateDefault<T extends { tools: ContractTool[] }>(view: T): T {
  return { ...view, tools: view.tools.map(tool => {
    if (!["create_answer", "load_exam_paper"].includes(tool.name)) return tool;
    const input = tool.inputSchema as JsonSchema;
    const properties = input.properties as Record<string, JsonSchema>;
    assert.equal(properties.templateId.default, "police_information_essay_165", `${tool.name} authorized template default`);
    return { ...tool, inputSchema: { ...input, properties: { ...properties,
      templateId: { ...properties.templateId, default: "police_information_essay" } } } };
  }) };
}
/** Optional hangingIndent added beside firstLineIndent in every paragraph/heading format object; strip only that key. */
function withoutHangingIndent(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(withoutHangingIndent);
  if (!schema || typeof schema !== "object") return schema;
  const node = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, withoutHangingIndent(value)])) as JsonSchema;
  const properties = node.properties as JsonSchema | undefined;
  if (properties && Object.hasOwn(properties, "hangingIndent") && Object.hasOwn(properties, "firstLineIndent")) {
    assert.ok(!((node.required ?? []) as string[]).includes("hangingIndent"), "hangingIndent must be optional");
    const { hangingIndent: _added, ...rest } = properties;
    return { ...node, properties: rest };
  }
  return node;
}
/** Remove only declared optional additions; every remaining base input stays strictly compared. */
export function withoutAddedInputs<T extends { tools: ContractTool[] }>(view: T): T {
  const writeTools = ["create_answer", "write_answer", "replace_text", "format_section", "insert_text", "delete_text", "render_answer_sheet"];
  return { ...view, tools: view.tools.map(original => {
    const tool = { ...original, inputSchema: withoutHangingIndent(original.inputSchema) as JsonSchema };
    if (!writeTools.includes(tool.name)) return tool;
    const input = tool.inputSchema as JsonSchema;
    const properties = { ...input.properties as JsonSchema };
    const added = ["responseDetail", ...(tool.name === "create_answer" ? ["exam", "questionNo", "lineTargets", "idempotencyKey", "layoutOptions", "examId"] : [])];
    for (const name of added) {
      assert.ok(Object.hasOwn(properties, name), `${tool.name} missing declared addition ${name}`);
      assert.ok(!((input.required ?? []) as string[]).includes(name), `${tool.name}.${name} must be optional`);
      delete properties[name];
    }
    return { ...tool, inputSchema: { ...input, properties } };
  }) };
}
function withoutBaseReadUi<T extends { tools: ContractTool[] }>(view: T): T {
  return { ...view, tools: view.tools.map(tool => {
    if (tool.name !== "read_answer") return tool;
    const { _meta, ...dataTool } = tool;
    assert.ok((_meta?.ui as { resourceUri?: string })?.resourceUri);
    assert.ok(_meta?.["openai/outputTemplate"]);
    return dataTool;
  }) };
}
function assertReadHasNoUi(tools: ContractTool[]) {
  const read = tools.find(tool => tool.name === "read_answer");
  assert.ok(read);
  assert.equal((read._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri, undefined);
  assert.equal(read._meta?.["openai/outputTemplate"], undefined);
}
/** Drops the default keyword of paragraph-format and heading-style fields anywhere in a contract view. */
export function withoutFormatDefaults<T>(value: T): T {
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!node || typeof node !== "object") return node;
    const result = Object.fromEntries(Object.entries(node).map(([key, item]) => [key, strip(item)])) as JsonSchema;
    const properties = result.properties as Record<string, JsonSchema> | undefined;
    if (properties && FORMAT_FIELDS.every(field => field in properties)) {
      result.properties = Object.fromEntries(Object.entries(properties).map(([key, { default: _default, ...schema }]) => [key, schema]));
    }
    return result;
  };
  return strip(value) as T;
}
/** Puts the base widget URI back so the versioned one is the only difference. */
function withBaseWidgetUri<T>(view: T): T {
  return JSON.parse(JSON.stringify(view).replaceAll(JSON.stringify(ANSWER_SHEET_WIDGET_URI), JSON.stringify(BASE_WIDGET_URI)));
}
export async function collectContract(factory = createEssayMcpServer, ownerToolCount = 21 - REMOVED_TOOLS.length + ADDED_TOOLS.length,
  readerToolCount = 12 - REMOVED_READ_TOOLS.length + ADDED_READ_TOOLS.length) {
  const views = [];
  for (const readOnly of [false, true]) {
    const server = factory(new FileStore(), { readOnly });
    const client = new Client({ name: "contract-check", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
      // MCP lists only prompt argument names; retain the complete registered schema too (SDK 1.30).
      const registered = (server as unknown as { _registeredPrompts: Record<string, { argsSchema?: z.ZodType }> })._registeredPrompts;
      const prompts = (await client.listPrompts()).prompts.map(prompt => ({ ...prompt,
        argsSchema: registered[prompt.name].argsSchema
          ? z.toJSONSchema(registered[prompt.name].argsSchema!, { io: "input" }) : undefined,
      })).sort((a, b) => a.name.localeCompare(b.name));
      views.push({ tools, prompts,
        resources: (await client.listResources()).resources.sort((a, b) => a.name.localeCompare(b.name)),
        resourceTemplates: (await client.listResourceTemplates()).resourceTemplates.sort((a, b) => a.name.localeCompare(b.name)),
      });
      assert.equal(tools.length, readOnly ? readerToolCount : ownerToolCount);
    } finally { await client.close(); await server.close(); }
  }
  return JSON.parse(stableJson({ owner: views[0], reader: views[1] })) as { owner: typeof views[number]; reader: typeof views[number] };
}
export function oauthToolLists(contract: Awaited<ReturnType<typeof collectContract>>) {
  // Derive scope lists solely from the base owner/read surfaces, never from the current classifier.
  const read = contract.reader.tools.map(tool => tool.name);
  const exports = ["export_docx", "export_pdf", "export_text"];
  const all = contract.owner.tools.map(tool => tool.name);
  assert.ok(exports.every(name => all.includes(name) && !read.includes(name)));
  return { read, readWrite: all.filter(name => !exports.includes(name)),
    readExport: all.filter(name => read.includes(name) || exports.includes(name)), all };
}
export async function checkMcpContract() {
  const fixture = JSON.parse(await readFile(new URL(import.meta.url.includes("/dist/") ? "../../tests/fixtures/mcp-contract.json" : "../tests/fixtures/mcp-contract.json", import.meta.url), "utf8"));
  assert.equal(fixture.sourceCommit, BASE_COMMIT);
  assert.deepEqual(fixture.intentionalDifferences, INTENTIONAL_DIFFERENCES);
  const current = await collectContract();
  // Everything except the declared differences must still equal base.
  assert.match(PAPER_FORMAT_NOTE, /^ The 165 original-paper template .*left-aligned.*bold.*italic/);
  assert.notEqual(ANSWER_SHEET_WIDGET_URI, BASE_WIDGET_URI);
  // Every reference must have moved to the versioned URI, or normalizing would hide a stale one.
  for (const view of ["owner", "reader"] as const) {
    assertReadHasNoUi(current[view].tools);
    assert.ok(!JSON.stringify(current[view]).includes(JSON.stringify(BASE_WIDGET_URI)), `${view} still references ${BASE_WIDGET_URI}`);
    assert.ok((current[view].resources as Array<{ uri: string }>).some(resource => resource.uri === ANSWER_SHEET_WIDGET_URI),
      `${view} does not register ${ANSWER_SHEET_WIDGET_URI}`);
  }
  const comparable = withBaseWidgetUri(current);
  // Normalize declared resource guidance and remove only the verified new resource.
  for (const view of ["owner", "reader"] as const) {
    const exportResource = comparable[view].resourceTemplates.find(r => r.name === "export-artifact");
    const baseExportResource = fixture.contract[view].resourceTemplates.find((r: { name: string }) => r.name === "export-artifact");
    assert.deepEqual(exportResource, { ...baseExportResource,
      description: "export_answer / export_exam_bundle 產生的限時檔案；URI 見工具結果的 exportUri。" });
    Object.assign(exportResource!, baseExportResource);
    const resource = comparable[view].resources.find(r => r.name === "answer-review-plan-schema");
    assert.deepEqual(resource, { name: "answer-review-plan-schema", title: "小問與驗收清單 JSON Schema",
      uri: "essay://schemas/review-plan", mimeType: "application/json",
      description: "Strict plan schema for set_answer_review; evidence is caller-reported, not server approval." });
    comparable[view].resources = comparable[view].resources.filter(r => r.name !== "answer-review-plan-schema");
  }
  assert.deepEqual(withoutFormatDefaults(current), current, "format fields must not declare defaults");
  const base = withoutFormatDefaults(fixture.contract) as typeof fixture.contract;
  assert.deepEqual({ owner: withoutOutputSchemas(withoutAddedInputs(withBaseTemplateDefault(withBaseDescriptions(comparable.owner, base.owner.tools))), ADDED_TOOLS), reader: withoutOutputSchemas(withoutAddedInputs(withBaseTemplateDefault(withBaseDescriptions(comparable.reader, base.reader.tools))), ADDED_READ_TOOLS) },
    { owner: withoutOutputSchemas(withoutBaseReadUi(base.owner), REMOVED_TOOLS), reader: withoutOutputSchemas(withoutBaseReadUi(base.reader), REMOVED_TOOLS) });
  for (const view of ["owner", "reader"] as const) {
    for (const baseTool of base[view].tools as ContractTool[]) {
      if (REMOVED_TOOLS.includes(baseTool.name)) continue;
      const tool = (current[view].tools as ContractTool[]).find(item => item.name === baseTool.name)!;
      assertSchemaSubset(withoutWritingGuide(tool.outputSchema!, tool.name), baseTool.outputSchema, `${view}.${baseTool.name}.outputSchema`);
    }
  }
  const toolsListBytes = Buffer.byteLength(JSON.stringify(current.owner.tools));
  assert.ok(toolsListBytes <= TOOLS_LIST_BUDGET_BYTES, `owner tools/list is ${toolsListBytes} bytes`);
  const deleteAnswer = (current.owner.tools as ContractTool[]).find(tool => tool.name === "delete_answer") as ContractTool & {
    annotations: Record<string, boolean>; inputSchema: { required: string[] };
  };
  assert.deepEqual(deleteAnswer.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false });
  assert.deepEqual([...deleteAnswer.inputSchema.required].sort(), ["answerId", "expectedVersion", "userRequest"]);
  assert.ok(!current.reader.tools.some(tool => tool.name === "delete_answer"));
  const deleteExam = current.owner.tools.find(tool => tool.name === "delete_exam")!;
  assert.deepEqual(deleteExam.annotations, deleteAnswer.annotations);
  assert.deepEqual([...deleteExam.inputSchema.required!].sort(), ["examId", "expectedVersion"]);
  assert.deepEqual(Object.keys(deleteExam.inputSchema.properties!).sort(), ["examId", "expectedVersion"]);
  assert.ok(!current.reader.tools.some(tool => tool.name === "delete_exam"));
  assert.deepEqual(oauthToolLists(fixture.contract), fixture.oauthTools);
  for (const [name, scopes] of Object.entries({ read: ["essay.read"], readWrite: ["essay.read", "essay.write"],
    readExport: ["essay.read", "essay.export"], all: ["essay.read", "essay.write", "essay.export"] })) {
    const server = createEssayMcpServer(new FileStore(), { scopes });
    const client = new Client({ name: "scope-contract-check", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const tools = (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name)) as ContractTool[];
      assertReadHasNoUi(tools);
      const added = ADDED_TOOLS.filter(tool => scopes.includes(toolScope(tool)));
      const kept = (fixture.oauthTools[name] as string[]).filter(tool => !REMOVED_TOOLS.includes(tool));
      assert.deepEqual(tools.map(t => t.name).sort(), [...kept, ...added].sort());
      // Base-surface difference: the existing OAuth declaration, with exact expected scopes.
      const expected = withoutBaseReadUi(base.owner).tools.filter((t: { name: string }) => kept.includes(t.name))
        .map((tool: ContractTool) => {
          const required = fixture.oauthTools.read.includes(tool.name) ? "essay.read"
            : ["export_docx", "export_pdf", "export_text"].includes(tool.name) ? "essay.export" : "essay.write";
          return { ...tool, _meta: { ...tool._meta, securitySchemes: [{ type: "oauth2", scopes: [...new Set(["essay.read", required])] }] } };
        });
      const listed = withBaseDescriptions({ tools: withBaseWidgetUri(JSON.parse(stableJson(tools)) as ContractTool[]) }, base.owner.tools).tools;
      assert.deepEqual(withoutOutputSchemas(withoutAddedInputs(withBaseTemplateDefault({ tools: listed })), ADDED_TOOLS).tools, withoutOutputSchemas({ tools: expected }).tools);
      for (const name of added) {
        assert.deepEqual(listed.find(tool => tool.name === name)?._meta?.securitySchemes,
          [{ type: "oauth2", scopes: [...new Set(["essay.read", toolScope(name)])] }]);
      }
    }
    finally { await client.close(); await server.close(); }
  }
  console.log(`MCP_CONTRACT_OK owner=${current.owner.tools.length} reader=${current.reader.tools.length} toolsListBytes=${toolsListBytes} baseline=${BASE_COMMIT}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkMcpContract();
