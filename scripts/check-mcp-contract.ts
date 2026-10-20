import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

export const INTENTIONAL_DIFFERENCES = [{ path: "oauth.tools[*]._meta.securitySchemes",
  reason: "Base has no OAuth support; preserve Round B OAuth scope declarations. All other fields must equal base." },
{ path: "*.tools[*].outputSchema",
  reason: "Compact output schemas shrink tools/list; each must stay a structural subset of the base schema." },
{ path: "owner.tools[delete_answer]",
  reason: "New owner-only destructive tool (essay.write) removing an answer with its revisions and exports." }];
export const BASE_COMMIT = "18cb1760160d2849039277c13546f168a0956329";
export const ADDED_TOOLS = ["delete_answer"];
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
function withoutOutputSchemas<T extends { tools: ContractTool[] }>(view: T, drop: string[] = []): T {
  return { ...view, tools: view.tools.filter(tool => !drop.includes(tool.name)).map(({ outputSchema: _output, ...tool }) => tool) };
}
export async function collectContract(factory = createEssayMcpServer, ownerToolCount = 21 + ADDED_TOOLS.length) {
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
      assert.equal(tools.length, readOnly ? 12 : ownerToolCount);
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
  assert.deepEqual({ owner: withoutOutputSchemas(current.owner, ADDED_TOOLS), reader: withoutOutputSchemas(current.reader) },
    { owner: withoutOutputSchemas(fixture.contract.owner), reader: withoutOutputSchemas(fixture.contract.reader) });
  for (const view of ["owner", "reader"] as const) {
    for (const base of fixture.contract[view].tools as ContractTool[]) {
      const tool = (current[view].tools as ContractTool[]).find(item => item.name === base.name)!;
      assertSchemaSubset(tool.outputSchema, base.outputSchema, `${view}.${base.name}.outputSchema`);
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
      const added = scopes.includes("essay.write") ? ADDED_TOOLS : [];
      assert.deepEqual(tools.map(t => t.name).sort(), [...fixture.oauthTools[name], ...added].sort());
      // Base-surface difference: the existing OAuth declaration, with exact expected scopes.
      const expected = fixture.contract.owner.tools.filter((t: { name: string }) => fixture.oauthTools[name].includes(t.name))
        .map((tool: ContractTool) => {
          const required = fixture.oauthTools.read.includes(tool.name) ? "essay.read"
            : ["export_docx", "export_pdf", "export_text"].includes(tool.name) ? "essay.export" : "essay.write";
          return { ...tool, _meta: { ...tool._meta, securitySchemes: [{ type: "oauth2", scopes: [...new Set(["essay.read", required])] }] } };
        });
      const listed = JSON.parse(stableJson(tools)) as ContractTool[];
      assert.deepEqual(withoutOutputSchemas({ tools: listed }, ADDED_TOOLS).tools, withoutOutputSchemas({ tools: expected }).tools);
      for (const name of added) {
        assert.deepEqual(listed.find(tool => tool.name === name)?._meta?.securitySchemes, [{ type: "oauth2", scopes: ["essay.read", "essay.write"] }]);
      }
    }
    finally { await client.close(); await server.close(); }
  }
  console.log(`MCP_CONTRACT_OK owner=${current.owner.tools.length} reader=12 scopes=12/19/15/22 toolsListBytes=${toolsListBytes} baseline=${BASE_COMMIT}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkMcpContract();
