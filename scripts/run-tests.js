import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { availableParallelism } from "node:os";

function collectTestFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectTestFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(path);
  }
  return files;
}

const testFiles = collectTestFiles(resolve("tests"));
// Many files spawn tsx child processes with fixed timeouts; one file per core starves them and they time out.
const concurrency = Math.max(1, Math.min(8, Math.floor(availableParallelism() / 2)));
if (testFiles.length === 0) {
  console.error("No TypeScript test files found under tests/.");
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", `--test-concurrency=${concurrency}`, ...testFiles], { stdio: "inherit" });
  if (result.error) {
    console.error(result.error);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
