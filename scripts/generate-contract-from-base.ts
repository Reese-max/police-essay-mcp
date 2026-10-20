import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BASE_COMMIT, INTENTIONAL_DIFFERENCES, collectContract, oauthToolLists } from "./check-mcp-contract.js";

export async function generateContractFromBase(basePath: string) {
  const base = path.resolve(basePath);
  const git = (...args: string[]) => execFileSync("git", ["-C", base, ...args], { encoding: "utf8", windowsHide: true }).trim();
  const sourceCommit = git("rev-parse", "HEAD");
  assert.equal(sourceCommit, BASE_COMMIT, "Contract must come from the pinned base revision.");
  assert.equal(git("status", "--porcelain", "--", "src"), "", "Base source must be unmodified.");
  const sourceSha256: Record<string, string> = {};
  for (const file of (await readdir(path.join(base, "src"))).filter(name => name.endsWith(".ts")).sort()) {
    sourceSha256[file] = createHash("sha256").update(await readFile(path.join(base, "src", file))).digest("hex");
  }
  const { createEssayMcpServer } = await import(pathToFileURL(path.join(base, "src/server.ts")).href);
  const contract = await collectContract(createEssayMcpServer, 21, 12);
  return { sourceCommit, sourceSha256, contract, oauthTools: oauthToolLists(contract), intentionalDifferences: INTENTIONAL_DIFFERENCES };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.ok(process.argv[2], "Usage: npx tsx scripts/generate-contract-from-base.ts <base-path> [output-path]");
  const fixture = await generateContractFromBase(process.argv[2]);
  const output = process.argv[3] ?? path.resolve("tests/fixtures/mcp-contract.json");
  await writeFile(output, JSON.stringify(fixture, null, 2) + "\n");
  console.log("BASE_CONTRACT_GENERATED revision=" + fixture.sourceCommit + " output=" + output);
}
