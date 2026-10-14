import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

export const INTENTIONAL_DIFFERENCES = [{ path: "oauth.tools[*]._meta.securitySchemes",
  reason: "Base has no OAuth support; preserve Round B OAuth scope declarations. All other fields must equal base." }];
export const BASE_COMMIT = "18cb1760160d2849039277c13546f168a0956329";
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export async function collectContract(factory = createEssayMcpServer) {
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
      assert.equal(tools.length, readOnly ? 12 : 21);
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
  assert.deepEqual(await collectContract(), fixture.contract);
  assert.deepEqual(oauthToolLists(fixture.contract), fixture.oauthTools);
  for (const [name, scopes] of Object.entries({ read: ["essay.read"], readWrite: ["essay.read", "essay.write"],
    readExport: ["essay.read", "essay.export"], all: ["essay.read", "essay.write", "essay.export"] })) {
    const server = createEssayMcpServer(new FileStore(), { scopes });
    const client = new Client({ name: "scope-contract-check", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a); await client.connect(b);
    try {
      const tools = (await client.listTools()).tools.sort((a, b) => a.name.localeCompare(b.name));
      assert.deepEqual(tools.map(t => t.name).sort(), [...fixture.oauthTools[name]].sort());
      // Sole intentional difference: the existing OAuth declaration, with exact expected scopes.
      const expected = fixture.contract.owner.tools.filter((t: { name: string }) => fixture.oauthTools[name].includes(t.name))
        .map((tool: { name: string; _meta?: Record<string, unknown> }) => {
          const required = fixture.oauthTools.read.includes(tool.name) ? "essay.read"
            : ["export_docx", "export_pdf", "export_text"].includes(tool.name) ? "essay.export" : "essay.write";
          return { ...tool, _meta: { ...tool._meta, securitySchemes: [{ type: "oauth2", scopes: [...new Set(["essay.read", required])] }] } };
        });
      assert.deepEqual(JSON.parse(stableJson(tools)), expected);
    }
    finally { await client.close(); await server.close(); }
  }
  console.log("MCP_CONTRACT_OK owner=21 reader=12 scopes=12/18/15/21 baseline=" + BASE_COMMIT);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkMcpContract();
