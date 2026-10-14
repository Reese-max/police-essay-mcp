import { Firestore, FieldValue, Timestamp } from "@google-cloud/firestore";
import { Storage } from "@google-cloud/storage";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { answerDocumentSchema, type AnswerDocument } from "./domain.js";
import { layoutSections } from "./layout.js";
import {
  FileStore, StoreNotFoundError, safeId, exportMimeType, exportArtifactHandlePattern,
  EXPORT_ARTIFACT_TTL_MS, type EssayStore, type ExportDetails,
} from "./storage.js";

export const MAX_ANSWER_BYTES = 700 * 1024;
export const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export type FirestoreClient = Pick<Firestore, "doc" | "collection" | "runTransaction">;
export type StorageClient = Pick<Storage, "bucket">;

const manifestSchema = z.object({
  schemaVersion: z.literal(1), handle: z.string().regex(exportArtifactHandlePattern),
  ownerKey: z.string(), answerId: z.string(), answerVersion: z.number().int().positive(),
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
    return answerDocumentSchema.parse(value);
  }
  async getAnswer(id: string): Promise<AnswerDocument> {
    const result = await this.answerRef(id).get();
    return this.parseAnswer(result.data());
  }
  async listAnswers(): Promise<AnswerDocument[]> {
    const result = await this.options.firestore.collection(this.userPath + "/answers").orderBy("updatedAt", "desc").get();
    return result.docs.map(doc => this.parseAnswer(doc.data()));
  }
  async saveAnswer(answer: AnswerDocument, options: { expectedVersion?: number } = {}): Promise<void> {
    this.requireWriter();
    // JSON removes optional undefined fields; Firestore rejects those fields by default.
    const normalized = JSON.parse(JSON.stringify(answerDocumentSchema.parse(answer))) as AnswerDocument;
    const ref = this.answerRef(normalized.id);
    const ids = normalized.sections.map(section => section.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate section id.");
    if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_ANSWER_BYTES) throw new Error("Answer exceeds 700 KiB document limit.");
    if (normalized.templateId === "police_information_essay_166") {
      layoutSections(await this.getTemplate(normalized.templateId), normalized.sections);
    }
    await this.options.firestore.runTransaction(async transaction => {
      const existing = (await transaction.get(ref)).data();
      const current = existing ? this.parseAnswer(existing) : undefined;
      if (options.expectedVersion !== undefined) {
        if (!current || current.version !== options.expectedVersion) {
          throw new Error("Version conflict: expected " + options.expectedVersion + ", current version is " + (current?.version ?? "missing") + ". Read the answer again before editing.");
        }
      } else if (current) {
        throw new Error("答案 " + normalized.id + " 已存在；更新既有答案時必須提供 expectedVersion。");
      }
      const committed = { ...normalized, version: current ? current.version + 1 : 1,
        createdAt: current?.createdAt ?? normalized.createdAt,
        schemaVersion: 1, ownerKey: this.options.ownerKey, committedAt: FieldValue.serverTimestamp() };
      transaction.set(ref, committed);
      transaction.create(ref.collection("revisions").doc(String(committed.version)), committed);
    });
  }

  async createExportHandle(outputPath: string, details: ExportDetails) {
    this.requireWriter();
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
    await file.save(data, { resumable: false, preconditionOpts: { ifGenerationMatch: 0 },
      metadata: { contentType: mimeType } });
    let generation: string | undefined;
    const createdAt = this.now();
    const expiresAt = createdAt + EXPORT_ARTIFACT_TTL_MS;
    try {
      const [metadata] = await file.getMetadata();
      generation = String(metadata.generation ?? "");
      if (!/^[1-9][0-9]*$/.test(generation)) throw new Error("Missing artifact generation.");
      await this.options.firestore.doc(this.userPath + "/artifacts/" + handle).create({
        schemaVersion: 1, handle, ownerKey: this.options.ownerKey,
        answerId: answer.id, answerVersion: details.answerVersion, format: details.format, name, mimeType,
        bucket: this.options.artifactBucket, objectName, generation,
        sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: data.length,
        createdAt: Timestamp.fromMillis(createdAt), expiresAt: Timestamp.fromMillis(expiresAt),
      });
    } catch {
      if (generation && /^[1-9][0-9]*$/.test(generation)) {
        try { await this.bucket.file(objectName, { generation }).delete({ ifGenerationMatch: generation }); }
        catch { console.error("artifact_compensation_failed"); }
      } else console.error("artifact_generation_unknown");
      throw new Error("Export manifest creation failed.");
    }
    return { handle, name, mimeType, expiresAt: new Date(expiresAt).toISOString() };
  }

  async readExport(handle: string) {
    const notFound = () => new StoreNotFoundError("Export artifact not found.");
    if (this.options.readOnly || !exportArtifactHandlePattern.test(handle)) throw notFound();
    const result = await this.options.firestore.doc(this.userPath + "/artifacts/" + handle).get();
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
      const file = this.bucket.file(value.objectName, { generation: value.generation });
      const [metadata] = await file.getMetadata();
      if (String(metadata.generation) !== value.generation || Number(metadata.size) !== value.sizeBytes) throw notFound();
      const [data] = await file.download();
      if (data.length !== value.sizeBytes || createHash("sha256").update(data).digest("hex") !== value.sha256) throw notFound();
      return { name: value.name, mimeType: value.mimeType, answerId: value.answerId,
        answerVersion: value.answerVersion, format: value.format,
        expiresAt: value.expiresAt.toDate().toISOString(), data };
    } catch { throw notFound(); }
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
  for (const name of ["GOOGLE_CLOUD_PROJECT", "ESSAY_FIRESTORE_DATABASE", "ESSAY_ENVIRONMENT", "ESSAY_OWNER_KEY", "ESSAY_ARTIFACT_BUCKET"]) {
    if (!env[name]?.trim()) throw new Error("Cloud mode requires " + name + ".");
  }
  if (env.ESSAY_ENVIRONMENT !== "staging" && env.ESSAY_ENVIRONMENT !== "production") throw new Error("Invalid ESSAY_ENVIRONMENT.");
  // Fixed Bearer maps only to a synthetic staging owner until OAuth principal validation exists.
  if (env.ESSAY_ENVIRONMENT !== "staging") throw new Error("Cloud production requires verified OAuth principals; Round A supports staging only.");
  if (!/^[a-f0-9]{64}$/.test(env.ESSAY_OWNER_KEY!)) throw new Error("Invalid ESSAY_OWNER_KEY.");
  return new CloudStore({ firestore: new Firestore({ projectId: env.GOOGLE_CLOUD_PROJECT, databaseId: env.ESSAY_FIRESTORE_DATABASE }),
    storage: new Storage({ projectId: env.GOOGLE_CLOUD_PROJECT }), environment: env.ESSAY_ENVIRONMENT,
    ownerKey: env.ESSAY_OWNER_KEY!, artifactBucket: env.ESSAY_ARTIFACT_BUCKET!, templateDir: env.ESSAY_MCP_TEMPLATE_DIR });
}
