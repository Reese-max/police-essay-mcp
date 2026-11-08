import { encodeAnswer, decodeAnswer } from "./answer-codec.js";
import { promises as fs } from "node:fs";
import { layoutSections } from "./layout.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  answerDocumentSchema, validateExamPlan, type ExamPlan,
  templateSchema,
  type AnswerDocument,
  type AnswerTemplate,
} from "./domain.js";

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename() that rides out Windows' brief locks: replacing a file that another handle (a concurrent
 * read, antivirus, the indexer) holds open fails with EPERM, EACCES or EBUSY for a moment.
 */
export async function renameReplacing(from: string, to: string, rename: (from: string, to: string) => Promise<void> = fs.rename): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await rename(from, to);
    } catch (error) {
      if (attempt >= 8 || !TRANSIENT_RENAME_ERRORS.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // 10 ms doubling to 1.28 s: about 2.5 s in all before the error is reported.
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}

export function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error("Invalid identifier.");
  }
  return id;
}

export interface ExportDetails {
  answerId: string;
  relatedAnswerIds?: string[];
  answerVersion: number;
  format: ExportFormat;
  temporaryDir?: string;
}

export interface DeletedAnswer {
  answer: AnswerDocument;
  revisions: number;
  exports: number;
}

export interface EssayStore {
  ensureDirectories(): Promise<void>;
  getTemplate(templateId: string): Promise<AnswerTemplate>;
  listTemplates(): Promise<AnswerTemplate[]>;
  getExam(id: string): Promise<ExamPlan>;
  listExams(): Promise<ExamPlan[]>;
  saveExam(plan: ExamPlan, options?: { expectedVersion?: number }): Promise<void>;
  deleteExam(id: string, options: { expectedVersion: number }): Promise<void>;
  getAnswer(answerId: string): Promise<AnswerDocument>;
  saveAnswer(answer: AnswerDocument, options?: { expectedVersion?: number }): Promise<void>;
  /** Permanently removes the answer, its revision history and its export artifacts. */
  deleteAnswer(answerId: string, options: { expectedVersion: number }): Promise<DeletedAnswer>;
  /** One committed version of an answer, kept after later edits. */
  getRevision(answerId: string, version: number): Promise<AnswerDocument>;
  /** Up to `limit` committed versions counting down from the current one, newest first; missing ones are skipped. */
  listRevisions(answerId: string, options: { limit: number }): Promise<AnswerDocument[]>;
  listAnswers(): Promise<AnswerDocument[]>;
  resolveExportPath(filename: string, extension: ExportFormat): string;
  createExportHandle(outputPath: string, details: ExportDetails): Promise<{
    handle: string; name: string; mimeType: string; expiresAt: string;
  }>;
  deleteExport(handle: string): Promise<void>;
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

export class StoreConflictError extends Error {
  constructor(message: string, readonly code = "ESSAY_VERSION_CONFLICT") { super(message); }
}
export function isStoreConflict(error: unknown): boolean {
  return error instanceof StoreConflictError && error.code === "ESSAY_VERSION_CONFLICT";
}
export const conflictBackoff = (attempt: number) => new Promise<void>(resolve => setTimeout(resolve, 10 * 2 ** attempt));

export function isStoreNotFound(error: unknown): boolean {
  return error instanceof StoreNotFoundError
    || (error instanceof Error && "code" in error && error.code === "ENOENT");
}

export function assertExamVersion(current: ExamPlan | undefined, expectedVersion?: number): void {
  if (expectedVersion !== undefined) {
    if (!current || current.version !== expectedVersion) throw new StoreConflictError(`Version conflict: expected ${expectedVersion}, current version is ${current?.version ?? "missing"}.`);
  } else if (current) throw new StoreConflictError(`考試 ${current.id} 已存在；更新必須提供 expectedVersion。`, "ESSAY_ALREADY_EXISTS");
}
export async function unlinkExamAnswer(store: EssayStore, id: string): Promise<void> {
  for (const initial of await store.listExams()) for (let attempt = 0; ; attempt++) {
    let plan: ExamPlan;
    try { plan = attempt ? await store.getExam(initial.id) : initial; }
    catch (error) { if (isStoreNotFound(error)) break; throw error; }
    if (!plan.questions.some(q => q.answerId === id)) break;
    try { await store.saveExam({ ...plan, ...(plan.lastBundle?.members.some(m => m.answerId === id) ? { lastBundle: undefined } : {}), updatedAt: new Date().toISOString(), questions: plan.questions.map(q => {
      if (q.answerId !== id) return q;
      const { answerId: _, ...question } = q; return question;
    }) }, { expectedVersion: plan.version }); break; }
    catch (error) { if (attempt >= 4 || !isStoreConflict(error)) throw error; await conflictBackoff(attempt); }
  }
}

export class FileStore implements EssayStore {
  readonly templateDir: string;
  readonly answerDir: string;
  readonly revisionDir: string;
  readonly exportDir: string;
  readonly artifactDir: string;
  private readonly answerWriteTails = new Map<string, Promise<void>>();
  private readonly exportWriteTails = new Map<string, Promise<void>>();

  constructor(options: { templateDir?: string; answerDir?: string; exportDir?: string } = {}) {
    const root = process.cwd();
    this.templateDir = options.templateDir ?? path.join(root, "templates");
    this.answerDir = options.answerDir ?? path.join(root, "data", "answers");
    // A sibling directory, so the answer directory keeps holding only answer files.
    this.revisionDir = `${this.answerDir}-revisions`;
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

  async getExam(id: string): Promise<ExamPlan> {
    try { return validateExamPlan(JSON.parse(await fs.readFile(path.join(`${this.answerDir}-exams`, `${safeId(id)}.json`), "utf8"))); }
    catch (error) { if (isStoreNotFound(error)) throw new StoreNotFoundError("找不到考試計畫。"); throw error; }
  }
  async listExams(): Promise<ExamPlan[]> {
    const names = await fs.readdir(`${this.answerDir}-exams`).catch(error => {
      if (isStoreNotFound(error)) return [] as string[]; throw error;
    });
    const plans = await Promise.all(names.filter(n => n.endsWith(".json")).map(async n => {
      try { return await this.getExam(n.slice(0, -5)); }
      catch (error) {
        if (isStoreNotFound(error)) return;
        console.error(JSON.stringify({ classification: "unreadable_exam_plan" }));
      }
    }));
    return plans.filter((plan): plan is ExamPlan => Boolean(plan));
  }
  async saveExam(plan: ExamPlan, options: { expectedVersion?: number } = {}): Promise<void> {
    const normalized = validateExamPlan(plan);
    // ponytail: serialize plan writes for owner-wide key uniqueness; use a key index if plan volume grows.
    await this.withAnswerWriteLock(":exam-keys", () => this.withAnswerWriteLock(normalized.id, async () => {
      if (normalized.createRequests) for (const plan of await this.listExams()) {
        if (plan.id === normalized.id) continue;
        if (Object.keys(normalized.createRequests).some(key => plan.createRequests?.[key]))
          throw new Error("IDEMPOTENCY_KEY_REUSED：此 key 已用於其他考試計畫的建立請求。");
      }
      let current: ExamPlan | undefined;
      try { current = await this.getExam(normalized.id); } catch (error) { if (!isStoreNotFound(error)) throw error; }
      assertExamVersion(current, options.expectedVersion);
      const committed = { ...normalized, version: current ? current.version + 1 : 1, createdAt: current?.createdAt ?? normalized.createdAt };
      const directory = `${this.answerDir}-exams`;
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, `${safeId(normalized.id)}.json`);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, JSON.stringify(committed), "utf8");
        await renameReplacing(temporary, filename);
      } finally { await fs.rm(temporary, { force: true }); }
    }));
  }
  async deleteExam(id: string, options: { expectedVersion: number }): Promise<void> {
    await this.withAnswerWriteLock(safeId(id), async () => {
      assertExamVersion(await this.getExam(id), options.expectedVersion);
      await fs.rm(path.join(`${this.answerDir}-exams`, `${id}.json`));
    });
  }

  async getAnswer(answerId: string): Promise<AnswerDocument> {
    const filename = path.join(this.answerDir, `${safeId(answerId)}.json`);
    const raw = await fs.readFile(filename, "utf8");
    return decodeAnswer(JSON.parse(raw));
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
    // Reject formatting that cannot be laid out before writing the answer or its history.
    // Overflow is still saved so the caller can preview and revise the answer.
    layoutSections(await this.getTemplate(normalized.templateId), normalized.sections, normalized.layoutOptions);
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

      const revisionDir = path.join(this.revisionDir, answerId);
      // Runtime parsing strips opaque fields; retain the raw envelope under the same write lock.
      const previous = current ? JSON.parse(await fs.readFile(filename, "utf8")) : undefined;
      await fs.mkdir(revisionDir, { recursive: true });
      const write = async (target: string, value: AnswerDocument) => {
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, `${JSON.stringify(encodeAnswer(value, previous), null, 2)}\n`, "utf8");
          await renameReplacing(temporary, target);
        } finally {
          await fs.rm(temporary, { force: true }).catch(() => undefined);
        }
      };
      // Answers saved before revisions existed get their current version recorded on the first
      // edit, so that edit can still be restored.
      if (current) {
        const currentRevision = path.join(revisionDir, `${current.version}.json`);
        if (!(await fs.access(currentRevision).then(() => true, () => false))) await write(currentRevision, current);
      }
      // The revision goes first: a failed answer write leaves a revision the next commit overwrites.
      await write(path.join(revisionDir, `${normalized.version}.json`), normalized);
      await write(filename, normalized);
    });
  }

  async getRevision(answerId: string, version: number): Promise<AnswerDocument> {
    const filename = path.join(this.revisionDir, safeId(answerId), `${version}.json`);
    try {
      return decodeAnswer(JSON.parse(await fs.readFile(filename, "utf8")));
    } catch (error) {
      if (isStoreNotFound(error)) throw new StoreNotFoundError("找不到版本紀錄。");
      throw error;
    }
  }

  async listRevisions(answerId: string, options: { limit: number }): Promise<AnswerDocument[]> {
    const current = await this.getAnswer(answerId);
    const revisions: AnswerDocument[] = [];
    for (let version = current.version; version >= 1 && version > current.version - options.limit; version--) {
      try {
        revisions.push(await this.getRevision(answerId, version));
      } catch (error) {
        if (!isStoreNotFound(error)) throw error;
      }
    }
    return revisions;
  }

  async deleteAnswer(answerId: string, options: { expectedVersion: number }): Promise<DeletedAnswer> {
    const id = safeId(answerId);
    return this.withAnswerWriteLock(id, async () => {
      const answer = await this.getAnswer(id);
      if (answer.version !== options.expectedVersion) {
        throw new Error(
          `Version conflict: expected ${options.expectedVersion}, current version is ${answer.version}. Read the answer again before deleting.`,
        );
      }
      // Unlink before removing any artifacts or history, so a CAS failure is retryable without data loss.
      await unlinkExamAnswer(this, id);
      let names: string[] = [];
      try {
        names = await fs.readdir(this.artifactDir);
      } catch (error) {
        if (!isStoreNotFound(error)) throw error;
      }
      let exports = 0;
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const handle = name.slice(0, -".json".length);
        let raw: string;
        try {
          raw = await fs.readFile(path.join(this.artifactDir, name), "utf8");
        } catch (error) {
          if (isStoreNotFound(error)) continue;
          throw error;
        }
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!isExportArtifactManifest(value, handle) || (value.answerId !== id && !value.relatedAnswerIds?.includes(id))) continue;
        // Bytes first, manifest second: a failure leaves the manifest for a retry to find.
        await fs.rm(path.join(this.artifactDir, value.artifactFilename), { force: true });
        await fs.rm(path.join(this.artifactDir, name), { force: true });
        exports++;
      }
      const revisionDir = path.join(this.revisionDir, id);
      let revisions = 0;
      try {
        revisions = (await fs.readdir(revisionDir)).filter((name) => name.endsWith(".json")).length;
      } catch (error) {
        if (!isStoreNotFound(error)) throw error;
      }
      await fs.rm(revisionDir, { recursive: true, force: true });
      // The answer goes last, so a failed cleanup can be retried with the same version.
      await fs.rm(path.join(this.answerDir, `${id}.json`));
      return { answer, revisions, exports };
    });
  }

  async listAnswers(): Promise<AnswerDocument[]> {
    await this.ensureDirectories();
    const filenames = (await fs.readdir(this.answerDir)).filter((name) => name.endsWith(".json"));
    const answers = await Promise.all(
      filenames.map(async (filename) => {
        const raw = await fs.readFile(path.join(this.answerDir, filename), "utf8");
        return decodeAnswer(JSON.parse(raw));
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
      ...(details.relatedAnswerIds ? { relatedAnswerIds: answerDocumentSchema.shape.id.array().max(20).parse(details.relatedAnswerIds) } : {}),
      answerVersion: details.answerVersion,
      format: details.format,
      createdAt,
      expiresAt,
    };

    try {
      await fs.copyFile(source, artifactPath);
      await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
      await renameReplacing(temporaryPath, manifestPath);
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
    if (!exportArtifactHandlePattern.test(handle)) throw new StoreNotFoundError("Export artifact not found.");

    const manifestPath = path.join(this.artifactDir, `${handle}.json`);
    try {
      const raw = await fs.readFile(manifestPath, "utf8");
      const value: unknown = JSON.parse(raw);
      if (!isExportArtifactManifest(value, handle)) throw new StoreNotFoundError("Export artifact not found.");
      if (value.expiresAt <= Date.now()) {
        await Promise.all([
          fs.rm(manifestPath, { force: true }).catch(() => undefined),
          fs.rm(path.join(this.artifactDir, value.artifactFilename), { force: true }).catch(() => undefined),
        ]);
        throw new StoreNotFoundError("Export artifact not found.");
      }
      // Never serve bytes of an answer that has been deleted.
      for (const id of new Set([value.answerId, ...value.relatedAnswerIds ?? []])) await this.getAnswer(id);

      const artifactRoot = path.resolve(this.artifactDir);
      const artifactPath = path.resolve(artifactRoot, value.artifactFilename);
      if (!artifactPath.startsWith(artifactRoot + path.sep)) throw new StoreNotFoundError("Export artifact not found.");
      const stats = await fs.lstat(artifactPath);
      const real = await fs.realpath(artifactPath);
      if (!stats.isFile() || !real.startsWith((await fs.realpath(artifactRoot)) + path.sep)) {
        throw new StoreNotFoundError("Export artifact not found.");
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
      throw new StoreNotFoundError("Export artifact not found.");
    }
  }

  async deleteExport(handle: string): Promise<void> {
    if (!exportArtifactHandlePattern.test(handle)) throw new StoreNotFoundError("Export artifact not found.");
    const manifestPath = path.join(this.artifactDir, `${handle}.json`);
    let value: unknown;
    try { value = JSON.parse(await fs.readFile(manifestPath, "utf8")); }
    catch (error) { if (isStoreNotFound(error)) return; throw error; }
    if (!isExportArtifactManifest(value, handle)) throw new StoreNotFoundError("Export artifact not found.");
    // Bytes first leaves the manifest available if cleanup must be retried.
    await fs.rm(path.join(this.artifactDir, value.artifactFilename), { force: true });
    await fs.rm(manifestPath, { force: true });
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
  relatedAnswerIds?: string[];
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
    && (manifest.relatedAnswerIds === undefined || (Array.isArray(manifest.relatedAnswerIds) && manifest.relatedAnswerIds.length <= 20
      && manifest.relatedAnswerIds.every(id => typeof id === "string" && /^ans_[A-Za-z0-9-]+$/.test(id))))
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

