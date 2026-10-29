import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer, DEFAULT_TEMPLATE_ID } from "../src/server.js";
import { FileStore } from "../src/storage.js";

// Isolated MCP run, no API calls, no production data, no reference-file transfer.
const input = JSON.parse(await fs.readFile("examples/reference-comparison-1-2.json", "utf8"));
await fs.mkdir(path.resolve("tmp/pdfs"), { recursive: true });
const root = await fs.mkdtemp(path.resolve("tmp/pdfs/default166-"));
const output = path.resolve("output/pdf/default166-reference-comparison");
await fs.mkdir(output, { recursive: true });
const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
const server = createEssayMcpServer(store), client = new Client({ name: "default166-demo", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); await client.listTools();
async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result)); return result.structuredContent as any;
}
try {
  const exam = await call("start_exam", { title: "參考文字排版比對", questions: [{ questionNo: 1 }], formats: ["pdf"] });
  // No templateId, no forced page breaks or visual-line breaks, no extra body heading.
  const created = await call("create_answer", { examId: exam.examId, questionNo: 1, title: "參考前兩頁文字", sections: [{ id: "body", text: input.text }], responseDetail: "full" });
  assert.equal(created.answer.templateId, DEFAULT_TEMPLATE_ID);
  assert.equal(created.answer.templateId, "police_information_essay_166");
  assert.equal(created.layout.fits, true);
  const before = await call("get_exam_progress", { examId: exam.examId });
  assert.equal(before.delivery.status, "not_ready");
  const exported = await call("export_exam_bundle", { examId: exam.examId });
  const file = exported.files.find((f: any) => f.format === "pdf");
  const artifact = await store.readExport(file.exportUri.split("/").at(-1));
  const pdfPath = path.join(output, "default166-reference-pages1-2.pdf");
  await fs.writeFile(pdfPath, artifact.data);
  const after = await call("get_exam_progress", { examId: exam.examId });
  assert.equal(after.delivery.status, "awaiting_review");
  const lines = created.layout.lines.filter((l: any) => !l.isSpacer);
  assert.equal(lines.map((l: any) => l.text).join("").replace(/\s/gu, ""), input.text.replace(/\s/gu, ""));
  assert.equal(file.pages, 2);
  const manifest = { source: input.source, referencePixelsViewedOnHP: false, templateId: created.answer.templateId,
    pdfPath, pdfSha256: createHash("sha256").update(artifact.data).digest("hex"), pages: file.pages,
    totalLines: created.layout.totalLines, pageLines: [1, 2].map(page => lines.filter((l: any) => l.page === page).length),
    fontWarning: file.fontWarning ?? null, deliveryBefore: before.delivery, deliveryAfter: after.delivery,
    expectedText: input.text, layout: created.layout };
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ pdfPath, pages: manifest.pages, totalLines: manifest.totalLines, pageLines: manifest.pageLines, fontWarning: manifest.fontWarning, delivery: after.delivery }, null, 2));
} finally { await client.close(); await server.close(); }
