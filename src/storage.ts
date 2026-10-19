import { promises as fs } from "node:fs";
import { layoutSections } from "./layout.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  answerDocumentSchema,
  templateSchema,
  type AnswerDocument,
  type AnswerTemplate,
} from "./domain.js";

export function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error("Invalid identifier.");
  }
  return id;
}

export interface ExportDetails {
  answerId: string;
  answerVersion: number;
  format: ExportFormat;
  temporaryDir?: string;
}

export interface EssayStore {
  ensureDirectories(): Promise<void>;
  getTemplate(templateId: string): Promise<AnswerTemplate>;
  listTemplates(): Promise<AnswerTemplate[]>;
  getAnswer(answerId: string): Promise<AnswerDocument>;
  saveAnswer(answer: AnswerDocument, options?: { expectedVersion?: number }): Promise<void>;
  listAnswers(): Promise<AnswerDocument[]>;
  resolveExportPath(filename: string, extension: ExportFormat): string;
  createExportHandle(outputPath: string, details: ExportDetails): Promise<{
    handle: string; name: string; mimeType: string; expiresAt: string;
  }>;
  readExport(handle: string): Promise<{
    name: string; mimeType: string; answerId: string; answerVersion: number;
    format: ExportFormat; expiresAt: string; data: Buffer;
  }>;
  checkReadiness?(): Promise<void>;
  /** Present on stores that isolate data per authenticated principal (cloud backend). */
  forPrincipal?(ownerKey: string, readOnly: boolean): EssayStore;
}

export class StoreNotFoundError extends Error {
  readonly code = "ESSAY_NOT_FOUND";
}

export function isStoreNotFound(error: unknown): boolean {
  return error instanceof StoreNotFoundError
    || (error instanceof Error && "code" in error && error.code === "ENOENT");
}

export class FileStore implements EssayStore {
  readonly templateDir: string;
  readonly answerDir: string;
  readonly exportDir: string;
  readonly artifactDir: string;
  private readonly answerWriteTails = new Map<string, Promise<void>>();
  private readonly exportWriteTails = new Map<string, Promise<void>>();

  constructor(options: { templateDir?: string; answerDir?: string; exportDir?: string } = {}) {
    const root = process.cwd();
    this.templateDir = options.templateDir ?? path.join(root, "templates");
    this.answerDir = options.answerDir ?? path.join(root, "data", "answers");
    this.exportDir = options.exportDir ?? path.join(root, "exports");
    this.artifactDir = path.join(this.exportDir, ".artifacts");
  }

  async ensureDirectories(): Promise<void> {
    await Promise.all([
      fs.mkdir(this.templateDir, { recursive: true }),
      fs.mkdir(this.answerDir, { recursive: true }),
      fs.mkdir(this.exportDir, { recursive: true }),
    ]);
  }

  async getTemplate(templateId: string): Promise<AnswerTemplate> {
    const filename = path.join(this.templateDir, `${safeId(templateId)}.json`);
    try {
      const raw = await fs.readFile(filename, "utf8");
      return templateSchema.parse(JSON.parse(raw));
    } catch (error) {
      if (isStoreNotFound(error)) throw new StoreNotFoundError("找不到模板。");
      throw error;
    }
  }

  async listTemplates(): Promise<AnswerTemplate[]> {
    await this.ensureDirectories();
    const filenames = (await fs.readdir(this.templateDir)).filter((name) => name.endsWith(".json"));
    const templates = await Promise.all(
      filenames.map(async (filename) => {
        const raw = await fs.readFile(path.join(this.templateDir, filename), "utf8");
        return templateSchema.parse(JSON.parse(raw));
      }),
    );
    return templates.sort((left, right) => left.id.localeCompare(right.id));
  }

  async getAnswer(answerId: string): Promise<AnswerDocument> {
    const filename = path.join(this.answerDir, `${safeId(answerId)}.json`);
    const raw = await fs.readFile(filename, "utf8");
    return answerDocumentSchema.parse(JSON.parse(raw));
  }

  private async withAnswerWriteLock<T>(answerId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.answerWriteTails.get(answerId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.answerWriteTails.set(answerId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.answerWriteTails.get(answerId) === queued) this.answerWriteTails.delete(answerId);
    }
  }

  async saveAnswer(answer: AnswerDocument, options: { expectedVersion?: number } = {}): Promise<void> {
    await this.ensureDirectories();
    const normalized = answerDocumentSchema.parse(answer);
    const answerId = safeId(normalized.id);
    // Keep invalid 166 formatting/font settings from being persisted before reflow.
    // Overflow is still saved so the caller can preview and revise the answer.
    if (normalized.templateId === "police_information_essay_166") {
      layoutSections(await this.getTemplate(normalized.templateId), normalized.sections);
    }
    await this.withAnswerWriteLock(answerId, async () => {
      const filename = path.join(this.answerDir, `${answerId}.json`);
      let current: AnswerDocument | undefined;
      try {
        current = await this.getAnswer(answerId);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }

      if (options.expectedVersion !== undefined) {
        if (!current || current.version !== options.expectedVersion) {
          throw new Error(
            `Version conflict: expected ${options.expectedVersion}, current version is ${current?.version ?? "missing"}. Read the answer again before editing.`,
          );
        }
      } else if (current) {
        throw new Error(`答案 ${answerId} 已存在；更新既有答案時必須提供 expectedVersion。`);
      }

      const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
        await fs.rename(temporary, filename);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    });
  }

  async listAnswers(): Promise<AnswerDocument[]> {
    await this.ensureDirectories();
    const filenames = (await fs.readdir(this.answerDir)).filter((name) => name.endsWith(".json"));
    const answers = await Promise.all(
      filenames.map(async (filename) => {
        const raw = await fs.readFile(path.join(this.answerDir, filename), "utf8");
        return answerDocumentSchema.parse(JSON.parse(raw));
      }),
    );
    return answers.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  resolveExportPath(filename: string, extension: ExportFormat): string {
    const normalized = filename.endsWith(`.${extension}`) ? filename : `${filename}.${extension}`;
    const allowedFilename = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\\.${extension}$`);
    if (!allowedFilename.test(normalized)) {
      throw new Error(`Invalid export filename; expected a simple .${extension} filename.`);
    }
    return path.join(this.exportDir, normalized);
  }

  async withExportWriteLock<T>(outputPath: string, operation: () => Promise<T>): Promise<T> {
    // Keep rendering and the immutable artifact copy together. Case folding also
    // serializes filename aliases on case-insensitive filesystems.
    const key = path.resolve(outputPath).toLowerCase();
    const previous = this.exportWriteTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.exportWriteTails.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.exportWriteTails.get(key) === queued) this.exportWriteTails.delete(key);
    }
  }

  async createExportHandle(
    outputPath: string,
    details: ExportDetails,
  ): Promise<{ handle: string; name: string; mimeType: string; expiresAt: string }> {
    await this.ensureDirectories();
    await fs.mkdir(this.artifactDir, { recursive: true });
    const name = path.basename(outputPath);
    const sourceRoot = details.temporaryDir ?? this.exportDir;
    const safeSource = path.resolve(sourceRoot, path.basename(this.resolveExportPath(name, details.format)));
    if (path.resolve(outputPath) !== safeSource) throw new Error("Export artifact not found.");

    const exportRoot = await fs.realpath(sourceRoot);
    const stats = await fs.lstat(safeSource);
    const source = await fs.realpath(safeSource);
    if (!stats.isFile() || !source.startsWith(exportRoot + path.sep)) {
      throw new Error("Export artifact not found.");
    }

    const handle = randomUUID();
    const artifactFilename = `${handle}.${details.format}`;
    const artifactPath = path.join(this.artifactDir, artifactFilename);
    const manifestPath = path.join(this.artifactDir, `${handle}.json`);
    const temporaryPath = `${manifestPath}.${process.pid}.${randomUUID()}.tmp`;
    const createdAt = Date.now();
    const expiresAt = createdAt + EXPORT_ARTIFACT_TTL_MS;
    const manifest: ExportArtifactManifest = {
      schemaVersion: 1,
      handle,
      artifactFilename,
      name,
      answerId: safeId(details.answerId),
      answerVersion: details.answerVersion,
      format: details.format,
      createdAt,
      expiresAt,
    };

    try {
      await fs.copyFile(source, artifactPath);
      await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      await fs.rename(temporaryPath, manifestPath);
    } catch (error) {
      await Promise.all([
        fs.rm(artifactPath, { force: true }).catch(() => undefined),
        fs.rm(temporaryPath, { force: true }).catch(() => undefined),
      ]);
      throw error;
    }

    return {
      handle,
      name,
      mimeType: exportMimeType(name),
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  async readExport(handle: string): Promise<{
    name: string;
    mimeType: string;
    answerId: string;
    answerVersion: number;
    format: ExportFormat;
    expiresAt: string;
    data: Buffer;
  }> {
    if (!exportArtifactHandlePattern.test(handle)) throw new Error("Export artifact not found.");

    const manifestPath = path.join(this.artifactDir, `${handle}.json`);
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!isExportArtifactManifest(value, handle)) throw new Error("Export artifact not found.");
      if (value.expiresAt <= Date.now()) {
        await Promise.all([
          fs.rm(manifestPath, { force: true }).catch(() => undefined),
          fs.rm(path.join(this.artifactDir, value.artifactFilename), { force: true }).catch(() => undefined),
        ]);
        throw new Error("Export artifact not found.");
      }

      const artifactRoot = path.resolve(this.artifactDir);
      const artifactPath = path.resolve(artifactRoot, value.artifactFilename);
      if (!artifactPath.startsWith(artifactRoot + path.sep)) throw new Error("Export artifact not found.");
      const stats = await fs.lstat(artifactPath);
      const real = await fs.realpath(artifactPath);
      if (!stats.isFile() || !real.startsWith((await fs.realpath(artifactRoot)) + path.sep)) {
        throw new Error("Export artifact not found.");
      }
      const data = await fs.readFile(real);
      return {
        name: value.name,
        mimeType: exportMimeType(value.name),
        answerId: value.answerId,
        answerVersion: value.answerVersion,
        format: value.format,
        expiresAt: new Date(value.expiresAt).toISOString(),
        data,
      };
    } catch {
      throw new Error("Export artifact not found.");
    }
  }

}

export const EXPORT_ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

export type ExportFormat = "docx" | "pdf" | "txt";

interface ExportArtifactManifest {
  schemaVersion: 1;
  handle: string;
  artifactFilename: string;
  name: string;
  answerId: string;
  answerVersion: number;
  format: ExportFormat;
  createdAt: number;
  expiresAt: number;
}

export const exportArtifactHandlePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const exportFilenamePattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.(docx|pdf|txt)$/;

function isExportFormat(value: unknown): value is ExportFormat {
  return value === "docx" || value === "pdf" || value === "txt";
}

function isExportArtifactManifest(value: unknown, handle: string): value is ExportArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  const formatValue = manifest.format;
  if (manifest.schemaVersion !== 1 || manifest.handle !== handle || !isExportFormat(formatValue)) return false;
  const format = formatValue;
  return typeof manifest.artifactFilename === "string"
    && manifest.artifactFilename === `${handle}.${format}`
    && typeof manifest.name === "string"
    && exportFilenamePattern.test(manifest.name)
    && manifest.name.endsWith(`.${format}`)
    && typeof manifest.answerId === "string"
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(manifest.answerId)
    && typeof manifest.answerVersion === "number"
    && Number.isSafeInteger(manifest.answerVersion)
    && manifest.answerVersion > 0
    && typeof manifest.createdAt === "number"
    && Number.isSafeInteger(manifest.createdAt)
    && typeof manifest.expiresAt === "number"
    && Number.isSafeInteger(manifest.expiresAt)
    && manifest.expiresAt === manifest.createdAt + EXPORT_ARTIFACT_TTL_MS;
}

export function exportMimeType(filename: string): string {
  if (filename.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (filename.endsWith(".pdf")) return "application/pdf";
  if (filename.endsWith(".txt")) return "text/plain";
  throw new Error(`Unsupported export extension: ${filename}`);
}

