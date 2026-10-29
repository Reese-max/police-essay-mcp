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

export const INTENTIONAL_DIFFERENCES = [{ path: "*.tools[check_layout,create_answer,delete_text,export_docx,export_pdf,export_text,format_section,insert_text,list_answers,list_templates,load_exam_paper,read_answer,reflow_answer,render_answer_sheet,replace_text,write_answer].description;owner.tools[create_answer].inputSchema.examId;*.tools[start_exam,get_exam_progress]",
  reason: "Exam plans and derived resume progress; optional examId links creates. Exact short descriptions replace workflow prose moved to server instructions to preserve the 80000-byte budget." },{ path: "owner.tools[export_docx,export_pdf,export_text].inputSchema.expectedVersion",
  reason: "Optional version binding for legacy exports; strip only expectedVersion before base comparison." },
{ path: "*.tools[render_exam_overview]",
  reason: "New essay.read canvas tool opens ordered answers in one widget with question tabs and a selected full snapshot." },
{ path: "owner.tools[create_answers]",
  reason: "New essay.write batch create tool validates all items before saving and shares retry-safe create semantics." },
{ path: "*.tools[read_answer]._meta",
  reason: "Data reads no longer open the widget. Remove only base read_answer metadata before comparison; current read_answer must have no UI resourceUri or outputTemplate." },
{ path: "owner.tools[export_exam_bundle]",
  reason: "New essay.export tool combines ordered, version-pinned answers into PDF and Word, with page ranges and layout warnings." },
{ path: "owner.tools[create_answer,write_answer,replace_text,format_section,insert_text,delete_text,render_answer_sheet].inputSchema.responseDetail;owner.tools[create_answer].inputSchema.exam,questionNo,lineTargets,idempotencyKey,layoutOptions",
  reason: "Declared optional input additions: compact write/render responses default to summary with full opt-in; create records exam, question number, line targets and per-answer layout options in version 1, with retry-safe idempotencyKey. Strip exactly these optional properties before base comparison." },
{ path: "oauth.tools[*]._meta.securitySchemes",
  reason: "Base has no OAuth support; preserve Round B OAuth scope declarations. All other fields must equal base." },
{ path: "*.tools[*].outputSchema",
  reason: "Compact output schemas shrink tools/list; each must stay a structural subset of the base schema." },
{ path: "owner.tools[delete_answer]",
  reason: "New owner-only destructive tool (essay.write) removing an answer with its revisions and exports." },
{ path: "*.tools[edit_text,list_revisions,preview_change,restore_revision]",
  reason: "New editing, preview and version history tools: edit_text and restore_revision need essay.write; the list and the preview are read-only (essay.read)." },
{ path: "owner.tools[duplicate_answer,export_answer,update_answer_info]",
  reason: "New answer-management tools: rename or file an answer under an exam and question number and duplicate it (essay.write); export several formats at once with readable names (essay.export)." },
{ path: "*.tools[export_docx,export_pdf,export_text].outputSchema.additionalProperties",
  reason: "Loosened so the export tools can also return the readable fileName and, when the server has a public URL, a downloadUrl." },
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
  reason: "User-authorized default for newly created answers and template-only loads is police_information_essay_166. Explicit templates and saved-answer template identity are preserved. Normalize only this exact default before base comparison." },
{ path: "*.tools[create_answer,format_section,insert_text,replace_text,write_answer].description",
  reason: "Formatting tools append the 166 paper formatting limits; the base description stays the exact prefix." }];
export const BASE_COMMIT = "18cb1760160d2849039277c13546f168a0956329";
export const ADDED_TOOLS = ["start_exam", "get_exam_progress", "create_answers", "delete_answer", "duplicate_answer", "edit_text", "export_answer", "export_exam_bundle", "list_revisions", "move_section",
  "preview_change", "render_exam_overview", "renumber_items", "restore_revision", "set_line_targets", "update_answer_info"];
/** Added tools that only need essay.read, so read credentials list them too. */
export const ADDED_READ_TOOLS = ["get_exam_progress", "list_revisions", "preview_change", "render_exam_overview"];
/** Base tools that no longer exist; all of them were read-only. */
export const REMOVED_TOOLS = ["preview_delete_text", "preview_format_section", "preview_insert_text", "preview_replace_text", "preview_write_answer"];
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
    "after": "Read exact line usage, overflow, targets and quality warnings (not content verification)."
  },
  "create_answer": {
    "before": "Use this when the user wants a new editable essay answer bound to a specific answer-sheet template. Sections support per-paragraph indentation, alignment, spacing, tabs, emphasis, and automatic heading styles.",
    "after": "Create an editable answer. examId resumes existing planned questions; use idempotencyKey for retries."
  },
  "delete_text": {
    "before": "Use this when the user explicitly wants to remove one section from an answer; the remaining sections are reflowed afterward.",
    "after": "Delete one section; preview_change can preview first."
  },
  "export_docx": {
    "before": "Use this when the user wants a fixed-grid A4 Word document; by default export is refused unless the answer fits the configured page capacity.",
    "after": "Export DOCX at expectedVersion; rejects overflow unless explicitly allowed (never for 166)."
  },
  "export_pdf": {
    "before": "Use this when the user wants a fixed-grid A4 PDF for printing; by default export is refused unless the answer fits the configured page capacity.",
    "after": "Export PDF at expectedVersion; rejects overflow unless explicitly allowed (never for 166)."
  },
  "export_text": {
    "before": "Use this when the user wants the authoritative wrapped answer as plain text with form-feed page breaks; by default export is refused unless the answer fits the configured page capacity.",
    "after": "Export grid TXT at expectedVersion; rejects overflow unless explicitly allowed (never for 166)."
  },
  "format_section": {
    "before": "Use this when the user wants to change indentation, alignment, spacing, tabs, emphasis, heading style, or selected paragraph formats without resending or rewriting the section text.",
    "after": "Change section/paragraph formatting without rewriting content."
  },
  "insert_text": {
    "before": "Use this when the user wants to add a new section at a precise position in an existing answer; the complete answer is reflowed afterward.",
    "after": "Insert a section after afterSectionId, or append when omitted."
  },
  "list_answers": {
    "before": "Use this when the user wants to find saved essay answers that can be reopened or edited.",
    "after": "List saved answers grouped by exam, ordered by question number."
  },
  "list_templates": {
    "before": "Use this when the user wants to inspect available essay answer-sheet templates before creating an answer.",
    "after": "List available answer-sheet templates."
  },
  "load_exam_paper": {
    "before": "Use this when the user wants to load a template or reopen an existing essay answer with its calculated grid layout.",
    "after": "Load template geometry and formatting rules."
  },
  "read_answer": {
    "before": "Use this when the user wants the complete structured answer, section metadata, and exact rendered lines.",
    "after": "Read the complete answer and rendered lines; no canvas."
  },
  "reflow_answer": {
    "before": "Use this after content changes when the user wants the authoritative line-by-line wrapping and page assignment; it recalculates from stored sections without asking the model to estimate.",
    "after": "Recalculate saved content with the authoritative layout engine."
  },
  "render_answer_sheet": {
    "before": "Use this when the user wants to view or edit a saved answer in an interactive canvas. Returns current answer/version and authoritative layout; 166 preview uses the original paper and exact font outlines.",
    "after": "Show one answer canvas with authoritative layout and editing controls."
  },
  "replace_text": {
    "before": "Use this when the user wants to revise one existing section without regenerating unrelated sections; optional paragraphs can replace the text with independent formatting, and the answer is reflowed afterward.",
    "after": "Replace one section's text or paragraphs, preserving other sections."
  },
  "write_answer": {
    "before": "Use this when the user has generated or rewritten the full answer and wants it stored as ordered editable sections; paragraph-level formatting is preserved and line count is delegated to the layout engine.",
    "after": "Replace all sections; expectedVersion protects edits. Prefer edit_text for phrases."
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
    assert.equal(properties.templateId.default, "police_information_essay_166", `${tool.name} authorized template default`);
    return { ...tool, inputSchema: { ...input, properties: { ...properties,
      templateId: { ...properties.templateId, default: "police_information_essay" } } } };
  }) };
}
/** Remove only declared optional additions; every remaining base input stays strictly compared. */
export function withoutAddedInputs<T extends { tools: ContractTool[] }>(view: T): T {
  const writeTools = ["create_answer", "write_answer", "replace_text", "format_section", "insert_text", "delete_text", "render_answer_sheet", "export_docx", "export_pdf", "export_text"];
  return { ...view, tools: view.tools.map(tool => {
    if (!writeTools.includes(tool.name)) return tool;
    const input = tool.inputSchema as JsonSchema;
    const properties = { ...input.properties as JsonSchema };
    const added = tool.name.startsWith("export_") ? ["expectedVersion"] : ["responseDetail", ...(tool.name === "create_answer" ? ["exam", "questionNo", "lineTargets", "idempotencyKey", "layoutOptions", "examId"] : [])];
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
  readerToolCount = 12 - REMOVED_TOOLS.length + ADDED_READ_TOOLS.length) {
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
  assert.match(PAPER_FORMAT_NOTE, /^ The 166 original-paper template .*left-aligned.*bold.*italic/);
  assert.notEqual(ANSWER_SHEET_WIDGET_URI, BASE_WIDGET_URI);
  // Every reference must have moved to the versioned URI, or normalizing would hide a stale one.
  for (const view of ["owner", "reader"] as const) {
    assertReadHasNoUi(current[view].tools);
    assert.ok(!JSON.stringify(current[view]).includes(JSON.stringify(BASE_WIDGET_URI)), `${view} still references ${BASE_WIDGET_URI}`);
    assert.ok((current[view].resources as Array<{ uri: string }>).some(resource => resource.uri === ANSWER_SHEET_WIDGET_URI),
      `${view} does not register ${ANSWER_SHEET_WIDGET_URI}`);
  }
  const comparable = withBaseWidgetUri(current);
  assert.deepEqual(withoutFormatDefaults(current), current, "format fields must not declare defaults");
  const base = withoutFormatDefaults(fixture.contract) as typeof fixture.contract;
  assert.deepEqual({ owner: withoutOutputSchemas(withoutAddedInputs(withBaseTemplateDefault(withBaseDescriptions(comparable.owner, base.owner.tools))), ADDED_TOOLS), reader: withoutOutputSchemas(withoutAddedInputs(withBaseTemplateDefault(withBaseDescriptions(comparable.reader, base.reader.tools))), ADDED_READ_TOOLS) },
    { owner: withoutOutputSchemas(withoutBaseReadUi(base.owner), REMOVED_TOOLS), reader: withoutOutputSchemas(withoutBaseReadUi(base.reader), REMOVED_TOOLS) });
  for (const view of ["owner", "reader"] as const) {
    for (const baseTool of base[view].tools as ContractTool[]) {
      if (REMOVED_TOOLS.includes(baseTool.name)) continue;
      const tool = (current[view].tools as ContractTool[]).find(item => item.name === baseTool.name)!;
      assertSchemaSubset(tool.outputSchema, baseTool.outputSchema, `${view}.${baseTool.name}.outputSchema`);
    }
  }
  const toolsListBytes = Buffer.byteLength(JSON.stringify(current.owner.tools));
  assert.ok(toolsListBytes <= TOOLS_LIST_BUDGET_BYTES, `owner tools/list is ${toolsListBytes} bytes`);
  const deleteAnswer = (current.owner.tools as ContractTool[]).find(tool => tool.name === "delete_answer") as ContractTool & {
    annotations: Record<string, boolean>; inputSchema: { required: string[] };
  };
  assert.deepEqual(deleteAnswer.annotations, { readOnlyHint: false, destructiveHint: true, openWorldHint: false, idempotentHint: false });
  assert.deepEqual([...deleteAnswer.inputSchema.required].sort(), ["answerId", "expectedVersion"]);
  assert.ok(!current.reader.tools.some(tool => tool.name === "delete_answer"));
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
