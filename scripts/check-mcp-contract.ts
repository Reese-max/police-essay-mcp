import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}
export async function collectContract(factory = createEssayMcpServer) {
  const result: Record<string, unknown> = {};
  for (const readOnly of [false, true]) {
    const server = factory(new FileStore(), { readOnly });
    const client = new Client({ name: "contract-check", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      const tools = (await client.listTools()).tools.map(tool => ({
        name: tool.name,
        inputSchemaSha256: createHash("sha256").update(stableJson(tool.inputSchema)).digest("hex"),
        annotations: tool.annotations,
      })).sort((a, b) => a.name.localeCompare(b.name));
      result[readOnly ? "reader" : "owner"] = {
        tools,
        resources: (await client.listResources()).resources.map(r => ({ name: r.name, uri: r.uri })).sort((a,b) => a.name.localeCompare(b.name)),
        resourceTemplates: (await client.listResourceTemplates()).resourceTemplates.map(r => ({ name: r.name, uriTemplate: r.uriTemplate })),
        prompts: (await client.listPrompts()).prompts.map(p => p.name).sort(),
      };
      assert.equal(tools.length, readOnly ? 12 : 21);
    } finally { await client.close(); await server.close(); }
  }
  return result;
}
export async function checkMcpContract() {
  const fixture = JSON.parse(await readFile(new URL(import.meta.url.includes("/dist/") ? "../../tests/fixtures/mcp-contract.json" : "../tests/fixtures/mcp-contract.json", import.meta.url), "utf8"));
  assert.deepEqual(await collectContract(), fixture.contract);
  console.log("MCP_CONTRACT_OK owner=21 reader=12 baseline=18cb176");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await checkMcpContract();
