import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { checkMcpContract, ADDED_TOOLS, BASE_COMMIT, REMOVED_TOOLS, assertSchemaSubset, withoutAddedInputs, withBaseDescriptions, DESCRIPTION_CHANGES } from "../scripts/check-mcp-contract.js";
import { generateContractFromBase } from "../scripts/generate-contract-from-base.js";
import { READ_TOOLS, WRITE_TOOLS, EXPORT_TOOLS, toolScope } from "../src/oauth.js";

test("MCP contract matches all pre-Round-A fields and scope lists", checkMcpContract);
const contractBasePath = process.env.MCP_CONTRACT_BASE_PATH ?? path.resolve("../pem-wt-base");
test("contract provenance is reproduced from the actual pinned base code and git HEAD", { skip: existsSync(contractBasePath) ? false : `base worktree ${contractBasePath} not found; set MCP_CONTRACT_BASE_PATH to a checkout of ${BASE_COMMIT}` }, async () => {
  const fixture = JSON.parse(await readFile(path.resolve("tests/fixtures/mcp-contract.json"), "utf8"));
  const actual = await generateContractFromBase(contractBasePath);
  assert.equal(actual.sourceCommit, BASE_COMMIT);
  assert.deepEqual(actual, fixture);
});
test("every existing tool has exactly one explicit scope classification; unknown tools require write", async () => {
  const fixture = JSON.parse(await readFile(path.resolve("tests/fixtures/mcp-contract.json"), "utf8"));
  const classified = [...READ_TOOLS, ...WRITE_TOOLS, ...EXPORT_TOOLS];
  assert.equal(new Set(classified).size, 32);
  assert.deepEqual([...classified].sort(), [...fixture.contract.owner.tools.map((t: { name: string }) => t.name)
    .filter((name: string) => !REMOVED_TOOLS.includes(name)), ...ADDED_TOOLS].sort());
  for (const [names, scope] of [[READ_TOOLS, "essay.read"], [WRITE_TOOLS, "essay.write"], [EXPORT_TOOLS, "essay.export"]] as const)
    for (const name of names) assert.equal(toolScope(name), scope);
  assert.equal(toolScope("unclassified_future_tool"), "essay.write");
});
test("compact output schemas may only drop fields or loosen additionalProperties", () => {
  const base = { type: "object", properties: { id: { type: "string" }, n: { type: "integer" } }, required: ["id", "n"], additionalProperties: false };
  assertSchemaSubset({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: {} }, base, "ok");
  assert.throws(() => assertSchemaSubset({ type: "object", properties: { extra: { type: "string" } } }, base, "added"), /not a base field/);
  assert.throws(() => assertSchemaSubset({ type: "object", properties: { n: { type: "string" } } }, base, "retyped"), /differs from base/);
  assert.throws(() => assertSchemaSubset({ type: "object", required: ["missing"] }, base, "required"), /requires a field/);
  assert.throws(() => assertSchemaSubset({ type: "object", properties: { id: {} }, required: ["id"], additionalProperties: {} }, base, "emptied"), /drops base keyword/);
  assert.throws(() => assertSchemaSubset({ type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, base, "closed"),
    /must allow the dropped base fields/);
});

test("optional-input normalization removes only declared additions and rejects required additions", () => {
  const inputSchema = { type: "object", properties: { answerId: { type: "string" }, responseDetail: { type: "string" },
    future: { type: "string" } }, required: ["answerId"] };
  const view = { tools: [{ name: "write_answer", inputSchema }] };
  const normalized = withoutAddedInputs(view);
  assert.deepEqual(normalized.tools[0].inputSchema.properties, { answerId: { type: "string" }, future: { type: "string" } });
  assert.deepEqual(inputSchema.properties.responseDetail, { type: "string" }, "normalization must not mutate the listed contract");
  assert.throws(() => withoutAddedInputs({ tools: [{ name: "write_answer", inputSchema: { ...inputSchema,
    required: ["answerId", "responseDetail"] } }] }), /must be optional/);
  assert.throws(() => withoutAddedInputs({ tools: [{ name: "write_answer", inputSchema: { ...inputSchema,
    properties: { answerId: { type: "string" } } } }] }), /missing declared addition/);
});


test("legacy version normalization strips only the optional version and keeps other fields", () => {
  for (const name of ["export_docx", "export_pdf", "export_text"]) {
    const inputSchema = { type: "object", properties: { answerId: { type: "string" }, expectedVersion: { type: "integer" }, future: { type: "string" } }, required: ["answerId"] };
    assert.deepEqual(withoutAddedInputs({ tools: [{ name, inputSchema }] }).tools[0].inputSchema.properties,
      { answerId: { type: "string" }, future: { type: "string" } });
    assert.throws(() => withoutAddedInputs({ tools: [{ name, inputSchema: { ...inputSchema, required: ["answerId", "expectedVersion"] } }] }), /must be optional/);
    assert.throws(() => withoutAddedInputs({ tools: [{ name, inputSchema: { ...inputSchema, properties: { answerId: { type: "string" } } } }] }), /missing declared addition/);
  }
});

test("description normalization rejects live and baseline regressions independently", () => {
  const change = DESCRIPTION_CHANGES.read_answer;
  const base = [{ name: "read_answer", description: change.before }];
  const live = { tools: [{ name: "read_answer", description: change.after }] };
  assert.equal(withBaseDescriptions(live, base).tools[0].description, change.before);
  assert.throws(() => withBaseDescriptions({ tools: [{ ...live.tools[0], description: "regressed" }] }, base), /short description/);
  assert.throws(() => withBaseDescriptions(live, [{ ...base[0], description: "regressed" }]), /baseline description/);
  assert.equal(live.tools[0].description, change.after);
});
