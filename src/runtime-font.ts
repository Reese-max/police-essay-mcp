import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StorageClient } from "./cloud-storage.js";
import { FileStore } from "./storage.js";
import { validateOriginalPaper, ORIGINAL_PAPER_FONT_SHA256 } from "./original-paper.js";
import type { AnswerTemplate } from "./domain.js";

export async function validateRuntimeFont(template: AnswerTemplate, fontPath = process.env.ESSAY_MCP_PAPER_FONT): Promise<void> {
  if (!fontPath) throw new Error("165 font is missing.");
  validateOriginalPaper(template, fontPath);
}

export async function initializeRuntimeFont(storage?: StorageClient, env = process.env): Promise<void> {
  const uri = env.PAPER_FONT_GCS_URI;
  if (!uri) {
    if (env.PAPER_FONT_GENERATION || env.PAPER_FONT_SHA256) throw new Error("PAPER_FONT_GCS_URI is required.");
    if (env.REQUIRE_PAPER_FONT === "true" && !env.ESSAY_MCP_PAPER_FONT) throw new Error("165 font is missing.");
    return;
  }
  const match = /^gs:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match || !/^[1-9][0-9]*$/.test(env.PAPER_FONT_GENERATION ?? "")
    || env.PAPER_FONT_SHA256 !== ORIGINAL_PAPER_FONT_SHA256) {
    throw new Error("Runtime font requires a GCS URI, fixed generation and the approved SHA-256.");
  }
  if (match[1] === env.ESSAY_ARTIFACT_BUCKET) throw new Error("Runtime font requires a dedicated bucket separate from artifacts.");
  const file = (storage ?? new (await import("@google-cloud/storage")).Storage()).bucket(match[1]).file(match[2], { generation: env.PAPER_FONT_GENERATION });
  const [metadata] = await file.getMetadata();
  if (String(metadata.generation) !== env.PAPER_FONT_GENERATION || Number(metadata.size) > 16 * 1024 * 1024) {
    throw new Error("Runtime font generation or size mismatch.");
  }
  const [data] = await file.download();
  if (data.length > 16 * 1024 * 1024 || createHash("sha256").update(data).digest("hex") !== env.PAPER_FONT_SHA256) {
    throw new Error("Runtime font SHA-256 mismatch.");
  }
  const directory = path.join(os.tmpdir(), "fonts");
  await fs.mkdir(directory, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(directory, "moe-"));
  const fontPath = path.join(temporary, "moe5.1.ttf");
  const previous = process.env.ESSAY_MCP_PAPER_FONT;
  try {
    await fs.writeFile(fontPath, data, { flag: "wx", mode: 0o400 });
    await fs.chmod(fontPath, 0o444);
    process.env.ESSAY_MCP_PAPER_FONT = fontPath;
    const template = await new FileStore({ templateDir: env.ESSAY_MCP_TEMPLATE_DIR }).getTemplate("police_information_essay_165");
    await validateRuntimeFont(template);
  } catch {
    if (previous === undefined) delete process.env.ESSAY_MCP_PAPER_FONT;
    else process.env.ESSAY_MCP_PAPER_FONT = previous;
    await fs.rm(temporary, { recursive: true, force: true });
    throw new Error("Runtime font validation failed.");
  }
}
