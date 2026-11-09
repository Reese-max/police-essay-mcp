import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { test } from "node:test";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import { createAnswerDocument, normalizeSection, templateSchema } from "../src/domain.js";
import { displayWidth, layoutSections, lineIndentColumns } from "../src/layout.js";
import { exportDocx, exportPdf } from "../src/exporters.js";
import { encodeAnswer, decodeAnswer } from "../src/answer-codec.js";
import { gridMetrics, pointsToTwips } from "../src/metrics.js";
import { originalPaperAvailableWidth, originalPaperMeasure } from "../src/original-paper.js";

const general = templateSchema.parse(JSON.parse(readFileSync(new URL("../templates/police_information_essay.json", import.meta.url), "utf8")));
const paper = templateSchema.parse(JSON.parse(readFileSync(new URL("../templates/police_information_essay_165.json", import.meta.url), "utf8")));
const hasPaperFont = Boolean(process.env.ESSAY_MCP_PAPER_FONT);

test("hangingIndent uses continuation columns and widths on a general template", () => {
  const template = { ...general, columns: 18 };
  const format = { leftIndent: 2, rightIndent: 1, firstLineIndent: 2, hangingIndent: 5 };
  const text = "1." + "甲".repeat(30);
  const report = layoutSections(template, [normalizeSection({ id: "body", text, paragraphFormat: format }, 0)]);
  assert.ok(report.lines.length > 2);
  assert.equal(lineIndentColumns(report.lines[0]), 4);
  assert.ok(report.lines.slice(1).every(line => lineIndentColumns(line) === 7));
  for (const line of report.lines) {
    assert.ok(displayWidth(line.text, line.format.tabSize) <= template.columns - lineIndentColumns(line) - format.rightIndent);
  }
});

test("autoHangingIndent recognizes only paragraph-leading list numbers", () => {
  const markers = ["壹、", "拾、", "一、", "二十、", "（一）", "(一)", "1.", "1、", "１．", "（1）", "(1)", "甲、", "（二）", "(十一)", "（十）", "乙、"];
  for (const marker of markers) {
    const report = layoutSections(general, [normalizeSection({
      id: "body", text: marker + "正文", paragraphFormat: { firstLineIndent: 2 },
    }, 0)], { autoHangingIndent: true });
    assert.equal(report.lines[0].format.hangingIndent, 2 + displayWidth(marker), marker);
  }
  const middle = layoutSections(general, [normalizeSection({ id: "body", text: "政策第1.2項說明數字不算編號" }, 0)],
    { autoHangingIndent: true });
  assert.equal(middle.lines[0].format.hangingIndent, 0);
  const explicit = layoutSections(general, [normalizeSection({
    id: "body", text: "1." + "甲".repeat(30), paragraphFormat: { firstLineIndent: 2, hangingIndent: 3 },
  }, 0)], { autoHangingIndent: true });
  assert.ok(explicit.lines.every(line => line.format.hangingIndent === 3));
});

test("absent autoHangingIndent preserves legacy line wrapping and positions", () => {
  const section = normalizeSection({ id: "legacy", text: "1." + "甲".repeat(30) }, 0);
  const legacy = layoutSections(general, [section]);
  assert.deepEqual(legacy, layoutSections(general, [section], { autoHangingIndent: false }));
  assert.deepEqual(legacy.lines.map(line => line.text), ["1." + "甲".repeat(20), "甲".repeat(10)]);
  assert.ok(legacy.lines.every(line => line.format.hangingIndent === 0 && lineIndentColumns(line) === 0));
});

test("autoHangingIndent is stored in the compatible layoutExtensions envelope", () => {
  const answer = { ...createAnswerDocument({ templateId: general.id, title: "codec" }), layoutOptions: { autoHangingIndent: true } };
  const encoded = encodeAnswer(answer);
  assert.equal(encoded.layoutOptions?.autoHangingIndent, undefined);
  assert.equal(encoded.layoutExtensions?.autoHangingIndent, true);
  assert.deepEqual(decodeAnswer(encoded), answer);
  assert.throws(() => decodeAnswer({ ...encoded, layoutOptions: { autoHangingIndent: false },
    layoutExtensions: { autoHangingIndent: true } }), /Conflicting/);
});

test("DOCX paragraphs keep the first-line indent and apply hangingIndent to continuation rows", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hanging-docx-"));
  try {
    const format = { leftIndent: 1, rightIndent: 1, firstLineIndent: 2, hangingIndent: 5 };
    const report = layoutSections(general, [normalizeSection({ id: "body", text: "甲".repeat(100), paragraphFormat: format }, 0)]);
    assert.ok(report.lines.length > 1);
    const output = path.join(root, "answer.docx");
    await exportDocx(report, general, output);
    const xml = await (await JSZip.loadAsync(await fs.readFile(output))).file("word/document.xml")!.async("string");
    const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/gu)].map(match => match[1]);
    const columnTwips = pointsToTwips(gridMetrics(general).columnWidthPt);
    for (const [index, line] of report.lines.entries()) {
      const paragraph = paragraphs.find(item => [...item.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/gu)]
        .map(match => match[1]).join("") === line.text);
      assert.ok(paragraph, `DOCX paragraph ${index + 1} text`);
      const indent = paragraph.match(/<w:ind\b([^>]*)\/>/u)?.[1] ?? "";
      const left = Number(indent.match(/w:left="(\d+)"/u)?.[1] ?? 0);
      const firstLine = Number(indent.match(/w:firstLine="(\d+)"/u)?.[1] ?? 0);
      assert.equal(left, columnTwips * (format.leftIndent + (index === 0 ? 0 : format.hangingIndent)));
      assert.equal(firstLine, index === 0 ? columnTwips * format.firstLineIndent : 0);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("general-template PDF positions continuation text at hangingIndent", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hanging-pdf-"));
  try {
    const format = { leftIndent: 1, rightIndent: 1, firstLineIndent: 2, hangingIndent: 5 };
    const report = layoutSections(general, [normalizeSection({ id: "body", text: "甲".repeat(100), paragraphFormat: format }, 0)]);
    const draw = t.mock.method(PDFDocument.prototype, "text");
    await exportPdf(report, general, path.join(root, "answer.pdf"));
    const calls = draw.mock.calls.map((call: { arguments: unknown[] }) => call.arguments as [string, number, number]);
    const textCalls = calls.filter((call: [string, number, number]) => call[0] !== "");
    const metrics = gridMetrics(general);
    let callIndex = 0;
    for (const [index, line] of report.lines.entries()) {
      const lineCalls = textCalls.slice(callIndex, callIndex + Array.from(line.text).length);
      assert.equal(lineCalls.map((call: [string, number, number]) => call[0]).join(""), line.text);
      assert.ok(Math.abs(lineCalls[0][1] - (metrics.leftPt + metrics.columnWidthPt * lineIndentColumns(line) + 4)) < 0.01);
      callIndex += lineCalls.length;
    }
    assert.equal(callIndex, textCalls.length);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("165 auto hanging width uses measured font columns and its PDF continuation pen", { skip: !hasPaperFont }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hanging-paper-"));
  try {
    const text = "1." + "甲".repeat(80);
    const report = layoutSections(paper, [normalizeSection({ id: "body", text }, 0)], { autoHangingIndent: true });
    const markerWidth = Math.round(originalPaperMeasure(paper)("1.") / (paper.fontSizePt / 2));
    assert.ok(report.lines.length > 1);
    assert.equal(report.lines[0].format.hangingIndent, markerWidth);
    for (const [index, line] of report.lines.entries()) {
      assert.ok(originalPaperMeasure(paper)(line.text) <= originalPaperAvailableWidth(line.format, paper, index) + 0.01);
    }
    const draw = t.mock.method(PDFDocument.prototype, "text");
    await exportPdf(report, paper, path.join(root, "answer.pdf"));
    const calls = draw.mock.calls.map((call: { arguments: unknown[] }) => call.arguments as [string, number, number]);
    const textCalls = calls.filter((call: [string, number, number]) => call[0] !== "");
    assert.equal(textCalls.length, report.lines.length);
    for (const [index, line] of report.lines.entries()) {
      assert.equal(textCalls[index][0], line.text);
      const indent = line.format.leftIndent + (index === 0 ? line.format.firstLineIndent : line.format.hangingIndent);
      assert.ok(Math.abs(textCalls[index][1] - (130.32 + indent * paper.fontSizePt / 2)) < 0.02);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("create_answer defaults autoHangingIndent on and accepts explicit hangingIndent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hanging-create-"));
  const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store);
  const client = new Client({ name: "hanging-indent-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "create_answer", arguments: {
      templateId: general.id, title: "自動懸掛", sections: [{ id: "body", text: "1." + "甲".repeat(30), paragraphFormat: { hangingIndent: 3 } }],
      responseDetail: "full",
    } });
    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    const created = result.structuredContent as { answer: { layoutOptions: { autoHangingIndent?: boolean } }; layout: { lines: Array<{ format: { hangingIndent: number } }> } };
    assert.equal(created.answer.layoutOptions.autoHangingIndent, true);
    assert.ok(created.layout.lines.every(line => line.format.hangingIndent === 3));
    assert.equal((await store.getAnswer((result.structuredContent as { answer: { id: string } }).answer.id)).layoutOptions?.autoHangingIndent, true);
    const tools = (await client.listTools()).tools;
    const formatSchema = tools.find(tool => tool.name === "format_section")!.inputSchema.properties!.paragraphFormat as { properties?: Record<string, unknown> };
    assert.ok(formatSchema.properties?.hangingIndent, "format_section accepts hangingIndent");
  } finally {
    await client.close();
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
