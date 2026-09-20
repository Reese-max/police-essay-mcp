import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  answerDocumentSchema,
  templateSchema,
  type AnswerDocument,
  type AnswerTemplate,
} from "./domain.js";

function safeId(id: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) {
    throw new Error("Invalid identifier.");
  }
  return id;
}

export class FileStore {
  readonly templateDir: string;
  readonly answerDir: string;
  readonly exportDir: string;
  private readonly answerWriteTails = new Map<string, Promise<void>>();

  constructor(options: { templateDir?: string; answerDir?: string; exportDir?: string } = {}) {
    const root = process.cwd();
    this.templateDir = options.templateDir ?? path.join(root, "templates");
    this.answerDir = options.answerDir ?? path.join(root, "data", "answers");
    this.exportDir = options.exportDir ?? path.join(root, "exports");
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
    const raw = await fs.readFile(filename, "utf8");
    return templateSchema.parse(JSON.parse(raw));
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

  resolveExportPath(filename: string, extension: "docx" | "pdf" | "txt"): string {
    const normalized = filename.endsWith(`.${extension}`) ? filename : `${filename}.${extension}`;
    const allowedFilename = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\\.${extension}$`);
    if (!allowedFilename.test(normalized)) {
      throw new Error(`Invalid export filename; expected a simple .${extension} filename.`);
    }
    return path.join(this.exportDir, normalized);
  }
}

