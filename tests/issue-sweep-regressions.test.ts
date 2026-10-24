import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnswerDocument, templateSchema } from "../src/domain.js";
import { layoutSections, renderTextLine, displayWidth } from "../src/layout.js";
import { exportDocx, exportPdf } from "../src/exporters.js";
import { createEssayMcpServer } from "../src/server.js";
import { createHttpHandler } from "../src/index.js";
import { FileStore } from "../src/storage.js";
import { planLines } from "../src/planning.js";

const template = templateSchema.parse(JSON.parse(await fs.readFile("templates/police_information_essay.json", "utf8")));
const textResult = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text?: string }>).map(item => item.text ?? "").join("\n");
const available = (command: string, args: string[]) => {
  try { execFileSync(command, args, { stdio: "ignore" }); return true; } catch { return false; }
};
const pdfReady = existsSync("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc") && available("pdftotext", ["-v"]);
const docxReady = pdfReady && available("soffice", ["--version"]) && available("python3", ["--version"]);
const newlineParts = ["前甲", "後乙", "段丙", "段丁", "段戊", "末己"];
const newlineSource = newlineParts.map((part, index) => part + (["\u2028", "\u2029", "\u0085", "\u000b", "\u000c"][index] ?? "")).join("");
const newlineAnswer = () => createAnswerDocument({ templateId: template.id, title: "換行", sections: [{ id: "body", text: newlineSource }] });

async function temporary(run: (root: string) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-issue-sweep-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function withClient(run: (client: Client, store: FileStore) => Promise<void>) {
  await temporary(async root => {
    const store = new FileStore({ templateDir: "templates", answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
    const server = createEssayMcpServer(store);
    const client = new Client({ name: "issue-sweep", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try { await run(client, store); } finally { await client.close(); await server.close(); }
  });
}

test("#30 Unicode paragraph separators use separate rows for new and legacy paragraphs", () => {
  const answer = newlineAnswer();
  assert.deepEqual(layoutSections(template, answer.sections).lines.map(line => line.text), newlineParts);
  assert.deepEqual(layoutSections(template, [{ ...answer.sections[0], text: newlineSource, paragraphs: [{ text: newlineSource }] }]).lines.map(line => line.text), newlineParts);
  const heading = createAnswerDocument({ templateId: template.id, title: "換行標題", sections: [{ heading: "前\u2028後", text: "本文" }] });
  assert.deepEqual(layoutSections(template, heading.sections).lines.map(line => line.text), ["前", "後", "本文"]);
});

test("#30 Unicode separators survive actual PDF and DOCX rendering", { skip: !docxReady }, async () => {
  await temporary(async root => {
    const answer = newlineAnswer();
    const report = layoutSections(template, answer.sections);
    const pdf = path.join(root, "newlines.pdf"), docx = path.join(root, "newlines.docx");
    await exportPdf(report, template, pdf); await exportDocx(report, template, docx);
    const pdfText = execFileSync("pdftotext", ["-raw", pdf, "-"], { encoding: "utf8" }).replace(/\s+/gu, "");
    for (const part of newlineParts) assert.ok(pdfText.includes(part), `PDF lost ${part}`);
    const xml = await (await JSZip.loadAsync(await fs.readFile(docx))).file("word/document.xml")!.async("string");
    execFileSync("python3", ["-c", "import sys,xml.etree.ElementTree as ET; ET.fromstring(sys.stdin.read())"], { input: xml });
    const converted = path.join(root, "converted"); await fs.mkdir(converted);
    execFileSync("soffice", ["--headless", `-env:UserInstallation=file://${root}/lo-profile`, "--convert-to", "pdf", "--outdir", converted, docx], { stdio: "pipe" });
    const convertedText = execFileSync("pdftotext", [path.join(converted, "newlines.pdf"), "-"], { encoding: "utf8" }).replace(/\s+/gu, "");
    for (const part of newlineParts) assert.ok(convertedText.includes(part), `DOCX lost ${part}`);
  });
});

test("#30 XML-invalid text fails before writing a DOCX or reporting export success", async () => {
  await temporary(async root => {
    for (const invalid of ["\u0000", "\u0001", "\u0008", "\u000e", "\u001f", "\ufffe", "\uffff", "\ud800"]) {
      const answer = createAnswerDocument({ templateId: template.id, title: "非法字元", sections: [{ id: "body", text: `甲${invalid}乙丙` }] });
      const output = path.join(root, "invalid.docx");
      await assert.rejects(exportDocx(layoutSections(template, answer.sections), template, output), /Word.*字元/u);
      await assert.rejects(fs.access(output));
    }
  });
  await withClient(async (client) => {
    const created = await client.callTool({ name: "create_answer", arguments: { title: "非法字元", sections: [{ id: "body", text: "甲\u0000乙丙" }] } });
    const id = (created.structuredContent as { answer: { id: string } }).answer.id;
    const result = await client.callTool({ name: "export_docx", arguments: { answerId: id } });
    assert.equal(result.isError, true);
    assert.doesNotMatch(textResult(result), /已輸出 Word/);
  });
});

test("#32 PDF keeps every character on a full-width ASCII line", { skip: !pdfReady }, async () => {
  await temporary(async root => {
    for (const source of ["m".repeat(42), "W".repeat(42), "@".repeat(40), "中文m".repeat(8)]) {
      const answer = createAnswerDocument({ templateId: template.id, title: "滿行", sections: [{ id: "body", text: source }] });
      const report = layoutSections(template, answer.sections);
      assert.equal(report.fits, true);
      const pdf = path.join(root, "full.pdf"); await exportPdf(report, template, pdf);
      const output = execFileSync("pdftotext", ["-raw", pdf, "-"], { encoding: "utf8" }).replace(/\s+/gu, "");
      assert.equal(output, source);
    }
  });
});

test("#34 distributed final lines span the TXT grid, while justify leaves them short", () => {
  const answer = createAnswerDocument({ templateId: template.id, title: "分散對齊", sections: [{ id: "body", text: "甲乙丙", paragraphFormat: { alignment: "distributed" } }] });
  const report = layoutSections(template, answer.sections);
  assert.equal(displayWidth(renderTextLine(report.lines[0], template)), template.columns);
  const justified = { ...report.lines[0], format: { ...report.lines[0].format, alignment: "justify" as const } };
  assert.equal(renderTextLine(justified, template), "甲乙丙");
});

test("#34 distributed final lines span the PDF grid and match the DOCX positions", { skip: !docxReady }, async () => {
  await temporary(async root => {
    const answer = createAnswerDocument({ templateId: template.id, title: "分散對齊", sections: [{ id: "body", text: "甲乙丙", paragraphFormat: { alignment: "distributed" } }] });
    const report = layoutSections(template, answer.sections);
    assert.equal(displayWidth(renderTextLine(report.lines[0], template)), template.columns);
    const justified = { ...report.lines[0], format: { ...report.lines[0].format, alignment: "justify" as const } };
    assert.equal(renderTextLine(justified, template), "甲乙丙");
    const pdf = path.join(root, "distributed.pdf"); await exportPdf(report, template, pdf);
    const bbox = execFileSync("pdftotext", ["-bbox", pdf, "-"], { encoding: "utf8" });
    const positions = [...bbox.matchAll(/<word\s+[^>]*xMin="([\d.]+)"[^>]*>([^<]+)<\/word>/g)].map(match => ({ x: Number(match[1]), text: match[2] }));
    const xs = ["甲", "乙", "丙"].map(char => positions.find(word => word.text === char)?.x);
    assert.ok(xs.every(x => x !== undefined), JSON.stringify(positions));
    assert.ok(xs[1]! - xs[0]! > 200 && xs[2]! - xs[1]! > 200, JSON.stringify(xs));
    const docx = path.join(root, "distributed.docx"); await exportDocx(report, template, docx);
    const converted = path.join(root, "converted"); await fs.mkdir(converted);
    execFileSync("soffice", ["--headless", `-env:UserInstallation=file://${root}/lo-profile`, "--convert-to", "pdf", "--outdir", converted, docx], { stdio: "pipe" });
    const docxBbox = execFileSync("pdftotext", ["-bbox", path.join(converted, "distributed.pdf"), "-"], { encoding: "utf8" });
    const docxPositions = [...docxBbox.matchAll(/<word\s+[^>]*xMin="([\d.]+)"[^>]*>([^<]+)<\/word>/g)].map(match => ({ x: Number(match[1]), text: match[2] }));
    for (const [index, char] of ["甲", "乙", "丙"].entries()) {
      const target = docxPositions.find(word => word.text === char)?.x;
      assert.ok(target !== undefined && Math.abs(target - xs[index]!) < 2, `${char}: PDF ${xs[index]}, DOCX ${target}`);
    }
  });
});

test("#36 restore_revision restores line targets in both directions and reports their changes", async () => {
  await withClient(async (client, store) => {
    const answer = createAnswerDocument({ templateId: template.id, title: "目標版本", sections: [{ id: "body", heading: "本文", text: "內容" }] });
    await store.saveAnswer(answer);
    await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 1, targets: [{ sectionId: "body", lines: 8 }] } });
    const restored = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, expectedVersion: 2, version: 1 } });
    assert.equal(restored.isError, undefined, textResult(restored));
    assert.equal((await store.getAnswer(answer.id)).lineTargets, undefined);
    assert.match(textResult(restored), /目標行數：8 行→未設定/u);
    assert.doesNotMatch(textResult(restored), /版面沒有改變/u);
    const reset = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, expectedVersion: 3, version: 2 } });
    assert.equal(reset.isError, undefined, textResult(reset));
    assert.deepEqual((await store.getAnswer(answer.id)).lineTargets, { body: 8 });
    assert.match(textResult(reset), /目標行數：未設定→8 行/u);
  });
});

test("#39 runtime accepts IPv6 loopback public origin and rejects remote HTTP origins", async () => {
  await temporary(async root => {
    const store = new FileStore({ answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
    assert.doesNotThrow(() => createHttpHandler(store, { MCP_AUTH_TOKEN: "test-owner", ESSAY_PUBLIC_BASE_URL: "http://[::1]:8787" }));
    for (const origin of ["http://[::2]:8787", "http://example.test:8787"]) {
      assert.throws(() => createHttpHandler(store, { MCP_AUTH_TOKEN: "test-owner", ESSAY_PUBLIC_BASE_URL: origin }), /ESSAY_PUBLIC_BASE_URL/);
    }
  });
});

test("#37 fallback recommendations keep an unprotected long section before protected content", () => {
  const answer = createAnswerDocument({ templateId: template.id, title: "保護核心", sections: [
    { id: "core", heading: "核心", text: "重點", required: true, priority: 5, compressible: 5 },
    { id: "body", heading: "背景", text: Array.from({ length: 50 }, () => "背景").join("\n"), priority: 1, compressible: 0 },
  ] });
  const layout = layoutSections(template, answer.sections);
  assert.ok(layout.overflowLines > 0);
  assert.match(planLines(answer, layout).notes.join("\n"), /建議先壓縮：「背景」/u);
});
