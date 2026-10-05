import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test(".gitignore covers node_modules in every form, not only directories", () => {
  // A `node_modules/` entry only matches directories. A dependency directory
  // supplied as a symlink (linked worktrees, CI caches, `npm link` layouts)
  // would then appear as an untracked `node_modules` entry to `git status`.
  const lines = readFileSync(path.join(projectRoot, ".gitignore"), "utf8").split(/\r?\n/u);
  assert.ok(
    lines.some((line) => line.trim() === "node_modules"),
    ".gitignore needs a bare `node_modules` entry so symlinked dependency dirs stay ignored",
  );
});
