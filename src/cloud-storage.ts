import { encodeAnswer, decodeAnswer } from "./answer-codec.js";
import { Firestore, FieldValue, Timestamp } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { answerDocumentSchema, MAX_ANSWER_BYTES, validateExamPlan, type ExamPlan, type AnswerDocument } from "./domain.js";
import { layoutSections } from "./layout.js";
import {
  FileStore, StoreNotFoundError, StoreConflictError, assertExamVersion, safeId, exportMimeType, exportArtifactHandlePattern,
  EXPORT_ARTIFACT_TTL_MS, type DeletedAnswer, type EssayStore, type ExportDetails,
} from "./storage.js";

export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export type FirestoreClient = Pick<Firestore, "doc" | "collection" | "runTransaction">;
export type StorageClient = Pick<Storage, "bucket">;

export class StoreUnavailableError extends Error {
  constructor(cause?: unknown) {
    // Firestore gRPC statuses: deadline exceeded, resource exhausted, internal, unavailable.
    const code = Number((cause as { code?: unknown })?.code);
    const status = ({ 4: 408, 8: 429, 13: 500, 14: 503 } as Record<number, number>)[code];
    super("儲存暫時故障", { cause: status ? { status, cause } : cause });
  }
}
function errorCode(error: unknown): number | undefined {
  return Number((error as { code?: unknown })?.code) || undefined;
}
function logStorageFailure(classification: string): void {
  console.error(JSON.stringify({ requestId: randomUUID(), classification }));
}
class AnswerSizeError extends Error {
  constructor() { super("Answer exceeds 700 KiB document limit."); }
}
async function backend<T>(operation: () => Promise<T>, missing = false): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof StoreConflictError || error instanceof StoreNotFoundError || error instanceof StoreUnavailableError || error instanceof AnswerSizeError) throw error;
    if (missing && [404, 5].includes(errorCode(error)!)) throw new StoreNotFoundError("找不到");
    logStorageFailure("storage_unavailable");
    throw new StoreUnavailableError(error);
  }
}

const manifestSchema = z.object({
  schemaVersion: z.literal(1), handle: z.string().regex(exportArtifactHandlePattern),
  ownerKey: z.string(), answerId: answerDocumentSchema.shape.id, answerVersion: z.number().int().positive(),
  relatedAnswerIds: z.array(answerDocumentSchema.shape.id).max(20).optional(),
  format: z.enum(["docx", "pdf", "txt"]), name: z.string(), mimeType: z.string(),
  bucket: z.string(), objectName: z.string(), generation: z.string().regex(/^[1-9][0-9]*$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), sizeBytes: z.number().int().nonnegative(),
  createdAt: z.instanceof(Timestamp), expiresAt: z.instanceof(Timestamp),
});

export class CloudStore implements EssayStore {
  private readonly files: FileStore;
  private readonly userPath: string;
  private readonly bucket;
  private readonly now: () => number;

  constructor(private readonly options: {
    firestore: FirestoreClient; storage: StorageClient; environment: "staging" | "production";
    ownerKey: string; artifactBucket: string; templateDir?: string; now?: () => number;
    readOnly?: boolean;
  }) {
    if (!/^[a-f0-9]{64}$/.test(options.ownerKey)) throw new Error("Invalid cloud owner key.");
    if (!["staging", "production"].includes(options.environment) || !options.artifactBucket) {
      throw new Error("Missing cloud storage configuration.");
    }
    this.userPath = "essayEnvironments/" + options.environment + "/users/" + options.ownerKey;
    this.bucket = options.storage.bucket(options.artifactBucket);
    this.now = options.now ?? Date.now;
    this.files = new FileStore({ templateDir: options.templateDir,
      answerDir: path.join(os.tmpdir(), "essay-cloud-unused"), exportDir: os.tmpdir() });
  }

  forPrincipal(ownerKey: string, readOnly: boolean): CloudStore {
    return new CloudStore({ ...this.options, ownerKey, readOnly });
  }

  async ensureDirectories(): Promise<void> { /* Cloud persistence needs no local directories. */ }
  getTemplate(id: string) { return this.files.getTemplate(id); }
  async listTemplates() {
    const names = (await fs.readdir(this.files.templateDir)).filter(name => name.endsWith(".json"));
    const templates = await Promise.all(names.map(name => this.getTemplate(name.slice(0, -5))));
    return templates.sort((a, b) => a.id.localeCompare(b.id));
  }
  resolveExportPath(filename: string, extension: ExportDetails["format"]) {
    return this.files.resolveExportPath(filename, extension);
  }
  private answerRef(id: string) { return this.options.firestore.doc(this.userPath + "/answers/" + safeId(id)); }
  private requireWriter(): void {
    if (this.options.readOnly) throw new Error("Read credential cannot write or export.");
  }
  private parseAnswer(value: unknown): AnswerDocument {
    if (!value || (value as { ownerKey?: string }).ownerKey !== this.options.ownerKey) {
      throw new StoreNotFoundError("Answer not found.");
    }
    try { return decodeAnswer(value); } catch { throw new StoreUnavailableError(); }
  }
  private examRef(id: string) { return this.options.firestore.doc(this.userPath + "/exams/" + safeId(id)); }
  private parseExam(value: unknown): ExamPlan {
    if (!value || (value as { ownerKey?: string }).ownerKey !== this.options.ownerKey) throw new StoreNotFoundError("Exam not found.");
    try { return validateExamPlan(value as ExamPlan); } catch { throw new StoreUnavailableError(); }
  }
  async getExam(id: string): Promise<ExamPlan> {
    return this.parseExam((await backend(() => this.examRef(id).get(), true)).data());
  }
  async listExams(): Promise<ExamPlan[]> {
    const result = await backend(() => this.options.firestore.collection(this.userPath + "/exams").get());
    return result.docs.flatMap(doc => {
      try { return [this.parseExam(doc.data())]; }
      catch { logStorageFailure("unreadable_exam_plan"); return []; }
    });
  }
  async saveExam(plan: ExamPlan, options: { expectedVersion?: number } = {}): Promise<void> {
    this.requireWriter();
    const normalized = JSON.parse(JSON.stringify(validateExamPlan(plan))) as ExamPlan;
    await backend(() => this.options.firestore.runTransaction(async tx => {
      const ref = this.examRef(normalized.id);
      const value = (await tx.get(ref)).data();
      const current = value ? this.parseExam(value) : undefined;
      assertExamVersion(current, options.expectedVersion);
      const keys = Object.entries(normalized.createRequests ?? {}).map(([key, request]) => ({
        ref: this.options.firestore.doc(this.userPath + "/examCreateKeys/" + key), request,
      }));
      for (const key of keys) {
        const value = (await tx.get(key.ref)).data();
        if (value && (value.examId !== normalized.id || value.requestHash !== key.request.requestHash))
          throw new StoreConflictError("IDEMPOTENCY_KEY_REUSED：此 key 已用於不同的建立請求。", "ESSAY_IDEMPOTENCY_CONFLICT");
      }
      for (const key of keys) tx.set(key.ref, { examId: normalized.id, requestHash: key.request.requestHash });
      tx.set(ref, { ...normalized, version: current ? current.version + 1 : 1,
        createdAt: current?.createdAt ?? normalized.createdAt, ownerKey: this.options.ownerKey });
    }));
  }
  async deleteExam(id: string, options: { expectedVersion: number }): Promise<void> {
    this.requireWriter();
    await backend(() => this.options.firestore.runTransaction(async tx => {
      const ref = this.examRef(id); const current = this.parseExam((await tx.get(ref)).data());
      assertExamVersion(current, options.expectedVersion);
      for (const key of Object.keys(current.createRequests ?? {})) tx.delete(this.options.firestore.doc(this.userPath + "/examCreateKeys/" + key));
      tx.delete(ref);
    }));
  }
  async getAnswer(id: string): Promise<AnswerDocument> {
    const result = await backend(() => this.answerRef(id).get(), true);
    return this.parseAnswer(result.data());
  }
  async getRevision(id: string, version: number): Promise<AnswerDocument> {
    const result = await backend(() => this.answerRef(id).collection("revisions").doc(String(version)).get(), true);
    return this.parseAnswer(result.data());
  }
  async listRevisions(id: string, options: { limit: number }): Promise<AnswerDocument[]> {
    // The revisions.version index is disabled (infra/firestore.indexes.json); revision ids are
    // the version numbers, so read them by name instead of querying.
    const current = await this.getAnswer(id);
    const versions = Array.from({ length: Math.min(options.limit, current.version) }, (_, index) => current.version - index);
    const results = await Promise.all(versions.map(version =>
      backend(() => this.answerRef(id).collection("revisions").doc(String(version)).get(), true)));
    return results.map(result => result.data()).filter(value => value !== undefined).map(value => this.parseAnswer(value));
  }
  async listAnswers(): Promise<AnswerDocument[]> {
    const result = await backend(() => this.options.firestore.collection(this.userPath + "/answers").orderBy("updatedAt", "desc").get());
    return result.docs.map(doc => this.parseAnswer(doc.data()));
  }
  async saveAnswer(answer: AnswerDocument, options: { expectedVersion?: number } = {}): Promise<void> {
    this.requireWriter();
    // JSON removes optional undefined fields; Firestore rejects those fields by default.
    const normalized = JSON.parse(JSON.stringify(answerDocumentSchema.parse(answer))) as AnswerDocument;
    const ref = this.answerRef(normalized.id);
    const ids = normalized.sections.map(section => section.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate section id.");
    if (Buffer.byteLength(JSON.stringify(encodeAnswer(normalized))) > MAX_ANSWER_BYTES) throw new AnswerSizeError();
    // An unrenderable candidate must not enter the transaction or revision history.
    // A calculable layout that exceeds the page limit remains editable and may be saved.
    layoutSections(await this.getTemplate(normalized.templateId), normalized.sections, normalized.layoutOptions);
    await backend(() => this.options.firestore.runTransaction(async transaction => {
      const existing = (await transaction.get(ref)).data();
      const current = existing ? this.parseAnswer(existing) : undefined;
      if (options.expectedVersion !== undefined) {
        if (!current || current.version !== options.expectedVersion) {
          throw new StoreConflictError("Version conflict: expected " + options.expectedVersion + ", current version is " + (current?.version ?? "missing") + ". Read the answer again before editing.");
        }
      } else if (current) {
        throw new StoreConflictError("答案 " + normalized.id + " 已存在；更新既有答案時必須提供 expectedVersion。");
      }
      const encoded = encodeAnswer(normalized, existing);
      if (Buffer.byteLength(JSON.stringify(encoded)) > MAX_ANSWER_BYTES) throw new AnswerSizeError();
      const committed = { ...encoded, version: current ? current.version + 1 : 1,
        createdAt: current?.createdAt ?? normalized.createdAt,
        schemaVersion: 1, ownerKey: this.options.ownerKey, committedAt: FieldValue.serverTimestamp() };
      transaction.set(ref, committed);
      transaction.create(ref.collection("revisions").doc(String(committed.version)), committed);
    }));
  }

  async deleteAnswer(id: string, options: { expectedVersion: number }): Promise<DeletedAnswer> {
    this.requireWriter();
    const ref = this.answerRef(id);
    // infra/firestore.indexes.json disables the artifacts.answerId index, so read the owner's
    // (small) manifest collection by document name and match the answer in memory.
    const artifacts = this.options.firestore.collection(this.userPath + "/artifacts");
    // Firestore has no 500-write cap per transaction, so the answer, its whole revision
    // history and its export manifests disappear together or not at all. Revisions are
    // read as bare references (empty field mask) to keep large histories out of memory.
    // A missing answer is decided by parseAnswer; infrastructure 404/5 stays "unavailable".
    const deleted = await backend(() => this.options.firestore.runTransaction(async transaction => {
      const answer = this.parseAnswer((await transaction.get(ref)).data());
      if (answer.version !== options.expectedVersion) {
        throw new StoreConflictError("Version conflict: expected " + options.expectedVersion + ", current version is " + answer.version + ". Read the answer again before deleting.");
      }
      const revisions = (await transaction.get(ref.collection("revisions").select())).docs;
      const manifests = (await transaction.get(artifacts)).docs.filter(doc => {
        const value = doc.data();
        return value.answerId === answer.id || (Array.isArray(value.relatedAnswerIds) && value.relatedAnswerIds.includes(answer.id));
      });
      const plans = (await transaction.get(this.options.firestore.collection(this.userPath + "/exams"))).docs;
      for (const doc of plans) {
        let plan: ExamPlan;
        try { plan = this.parseExam(doc.data()); }
        catch { logStorageFailure("unreadable_exam_plan"); continue; }
        const { lastBundle, ...rest } = plan;
        if (plan.questions.some(q => q.answerId === id)) transaction.set(doc.ref, { ...rest,
          ...(lastBundle && !lastBundle.members.some(m => m.answerId === id) ? { lastBundle } : {}),
          ownerKey: this.options.ownerKey, version: plan.version + 1, updatedAt: new Date(this.now()).toISOString(),
          questions: plan.questions.map(q => { const { answerId, ...rest } = q; return answerId === id ? rest : q; }) });
      }
      for (const doc of [...revisions, ...manifests]) transaction.delete(doc.ref);
      transaction.delete(ref);
      return { answer, revisions: revisions.length, manifests: manifests.map(doc => doc.data()) };
    }));
    // Without manifests the objects are unreachable; remove them now instead of waiting for
    // the bucket lifecycle, which still covers any delete that fails here.
    for (const value of deleted.manifests) {
      const parsed = manifestSchema.safeParse(value);
      if (!parsed.success || parsed.data.ownerKey !== this.options.ownerKey || parsed.data.bucket !== this.options.artifactBucket
        || !parsed.data.objectName.startsWith(this.options.environment + "/" + this.options.ownerKey + "/")) continue;
      const { objectName, generation } = parsed.data;
      try { await this.bucket.file(objectName, { generation }).delete({ ifGenerationMatch: generation }); }
      catch (error) { if (errorCode(error) !== 404) logStorageFailure("artifact_delete_failed"); }
    }
    return { answer: deleted.answer, revisions: deleted.revisions, exports: deleted.manifests.length };
  }

  async createExportHandle(outputPath: string, details: ExportDetails) {
    this.requireWriter();
    const relatedAnswerIds = manifestSchema.shape.relatedAnswerIds.parse(details.relatedAnswerIds);
    const answer = await this.getAnswer(details.answerId);
    // Export refers to the rendered snapshot, even if an edit has since committed.
    if (!Number.isSafeInteger(details.answerVersion) || details.answerVersion < 1 || details.answerVersion > answer.version) {
      throw new Error("Invalid export answer version.");
    }
    const name = path.basename(outputPath);
    this.resolveExportPath(name, details.format);
    const sourceRoot = details.temporaryDir ?? os.tmpdir();
    const source = await fs.realpath(outputPath);
    const stats = await fs.lstat(outputPath);
    if (!stats.isFile() || source !== path.join(await fs.realpath(sourceRoot), name)) {
      throw new StoreNotFoundError("Export artifact not found.");
    }
    if (stats.size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 16 MiB limit.");
    const data = await fs.readFile(source);
    if (data.length > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds 16 MiB limit.");
    const handle = randomUUID();
    const objectName = this.options.environment + "/" + this.options.ownerKey + "/" + handle + "." + details.format;
    const file = this.bucket.file(objectName);
    const mimeType = exportMimeType(name);
    const sha256 = createHash("sha256").update(data).digest("hex");
    let generation: string | undefined;
    const createdAt = this.now();
    const expiresAt = createdAt + EXPORT_ARTIFACT_TTL_MS;
    try {
      let retryCollision = false;
      try {
        await file.save(data, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
          metadata: { contentType: mimeType } });
      } catch (error) {
        if (errorCode(error) !== 412) throw error;
        retryCollision = true;
      }
      const [metadata] = await file.getMetadata();
      generation = String(metadata.generation ?? "");
      if (!/^[1-9][0-9]*$/.test(generation)) throw new StoreUnavailableError();
      if (retryCollision) {
        if (Number(metadata.size) !== data.length) throw new StoreUnavailableError();
        const [existing] = await this.bucket.file(objectName, { generation }).download();
        if (existing.length !== data.length
          || createHash("sha256").update(existing).digest("hex") !== sha256) throw new StoreUnavailableError();
      }
      await this.options.firestore.doc(this.userPath + "/artifacts/" + handle).create({
        schemaVersion: 1, handle, ownerKey: this.options.ownerKey,
        answerId: answer.id, answerVersion: details.answerVersion, format: details.format, name, mimeType,
        ...(relatedAnswerIds ? { relatedAnswerIds } : {}),
        bucket: this.options.artifactBucket, objectName, generation,
        sha256, sizeBytes: data.length,
        createdAt: Timestamp.fromMillis(createdAt), expiresAt: Timestamp.fromMillis(expiresAt),
      });
    } catch (error) {
      if (generation && /^[1-9][0-9]*$/.test(generation)) {
        try { await this.bucket.file(objectName, { generation }).delete({ ifGenerationMatch: generation }); }
        catch { logStorageFailure("artifact_compensation_failed"); }
      } else logStorageFailure("artifact_generation_unknown");
      logStorageFailure("storage_unavailable");
      throw new StoreUnavailableError(error);
    }
    return { handle, name, mimeType, expiresAt: new Date(expiresAt).toISOString() };
  }

  async readExport(handle: string) {
    const notFound = () => new StoreNotFoundError("Export artifact not found.");
    if (this.options.readOnly || !exportArtifactHandlePattern.test(handle)) throw notFound();
    const result = await backend(() => this.options.firestore.doc(this.userPath + "/artifacts/" + handle).get(), true);
    const parsed = manifestSchema.safeParse(result.data());
    if (!parsed.success) throw notFound();
    const value = parsed.data;
    if (value.ownerKey !== this.options.ownerKey || value.handle !== handle
      || value.bucket !== this.options.artifactBucket
      || value.objectName !== this.options.environment + "/" + this.options.ownerKey + "/" + handle + "." + value.format
      || value.expiresAt.toMillis() <= this.now()
      || value.expiresAt.toMillis() !== value.createdAt.toMillis() + EXPORT_ARTIFACT_TTL_MS
      || value.sizeBytes > MAX_ARTIFACT_BYTES) throw notFound();
    try {
      safeId(value.answerId);
      this.resolveExportPath(value.name, value.format);
      if (exportMimeType(value.name) !== value.mimeType) throw notFound();
      // A manifest committed after a concurrent delete_answer must not expose deleted content.
      for (const id of new Set([value.answerId, ...value.relatedAnswerIds ?? []])) await this.getAnswer(id);
      const file = this.bucket.file(value.objectName, { generation: value.generation });
      const [metadata] = await backend(() => file.getMetadata(), true);
      if (String(metadata.generation) !== value.generation || Number(metadata.size) !== value.sizeBytes) throw notFound();
      const [data] = await backend(() => file.download(), true);
      if (data.length !== value.sizeBytes || createHash("sha256").update(data).digest("hex") !== value.sha256) throw notFound();
      return { name: value.name, mimeType: value.mimeType, answerId: value.answerId,
        answerVersion: value.answerVersion, format: value.format,
        expiresAt: value.expiresAt.toDate().toISOString(), data };
    } catch (error) {
      if (error instanceof StoreUnavailableError) throw error;
      throw notFound();
    }
  }

  async deleteExport(handle: string): Promise<void> {
    this.requireWriter();
    if (!exportArtifactHandlePattern.test(handle)) throw new StoreNotFoundError("Export artifact not found.");
    const ref = this.options.firestore.doc(this.userPath + "/artifacts/" + handle);
    const result = await backend(() => ref.get());
    const raw = result.data();
    if (raw === undefined) return;
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.ownerKey !== this.options.ownerKey || parsed.data.handle !== handle
      || parsed.data.bucket !== this.options.artifactBucket
      || parsed.data.objectName !== this.options.environment + "/" + this.options.ownerKey + "/" + handle + "." + parsed.data.format) {
      throw new StoreNotFoundError("Export artifact not found.");
    }
    const { objectName, generation } = parsed.data;
    // Keep the manifest on a byte-delete failure so rollback can be retried by handle.
    await backend(async () => {
      try { await this.bucket.file(objectName, { generation }).delete({ ifGenerationMatch: generation }); }
      catch (error) { if (errorCode(error) !== 404) throw error; }
      await ref.delete();
    });
  }

  async checkReadiness(): Promise<void> {
    await Promise.all([
      this.options.firestore.collection(this.userPath + "/answers").limit(1).get(),
      this.bucket.getFiles({ prefix: this.options.environment + "/" + this.options.ownerKey + "/", maxResults: 1, autoPaginate: false }).then(async ([files]) => {
        if (files[0]) await files[0].download({ start: 0, end: 0 });
      }),
    ]);
  }
}

export function createRuntimeStore(env: NodeJS.ProcessEnv = process.env): EssayStore {
  if (env.MCP_TRANSPORT === "stdio" || !env.STORAGE_BACKEND || env.STORAGE_BACKEND === "file") {
    return new FileStore({ templateDir: env.ESSAY_MCP_TEMPLATE_DIR,
      answerDir: env.ESSAY_MCP_ANSWER_DIR, exportDir: env.ESSAY_MCP_EXPORT_DIR });
  }
  if (env.STORAGE_BACKEND !== "cloud") throw new Error("STORAGE_BACKEND must be file or cloud.");
  const oauthOnly = env.AUTH_MODE === "oauth";
  for (const name of ["GOOGLE_CLOUD_PROJECT", "ESSAY_FIRESTORE_DATABASE", "ESSAY_ENVIRONMENT", "ESSAY_ARTIFACT_BUCKET", ...(oauthOnly ? [] : ["ESSAY_OWNER_KEY"])]) {
    if (!env[name]?.trim()) throw new Error("Cloud mode requires " + name + ".");
  }
  if (env.ESSAY_ENVIRONMENT !== "staging" && env.ESSAY_ENVIRONMENT !== "production") throw new Error("Invalid ESSAY_ENVIRONMENT.");
  // Fixed Bearer remains a synthetic staging owner; production requires OAuth-only mode.
  if (env.ESSAY_ENVIRONMENT !== "staging" && !oauthOnly) throw new Error("Cloud production requires verified OAuth principals (AUTH_MODE=oauth).");
  const ownerKey = oauthOnly ? "0".repeat(64) : env.ESSAY_OWNER_KEY!;
  if (!/^[a-f0-9]{64}$/.test(ownerKey)) throw new Error("Invalid ESSAY_OWNER_KEY.");
  return new CloudStore({ firestore: new Firestore({ projectId: env.GOOGLE_CLOUD_PROJECT, databaseId: env.ESSAY_FIRESTORE_DATABASE }),
    storage: new Storage({ projectId: env.GOOGLE_CLOUD_PROJECT }), environment: env.ESSAY_ENVIRONMENT,
    ownerKey, artifactBucket: env.ESSAY_ARTIFACT_BUCKET!, templateDir: env.ESSAY_MCP_TEMPLATE_DIR });
}
