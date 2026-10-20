import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnswerDocument, headingStyleInputSchema, paragraphFormatInputSchema, updateSectionFormatting, type AnswerTemplate } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

const templateDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "templates");
const grid = JSON.parse(readFileSync(path.join(templateDir, "police_information_essay.json"), "utf8")) as AnswerTemplate;
const firstLines = (template: AnswerTemplate, sections: Parameters<typeof layoutSections>[1]) =>
  layoutSections(template, sections).lines.filter((line) => line.isFirstLineOfParagraph);

test("format inputs keep only the fields given", () => {
  assert.deepEqual(paragraphFormatInputSchema.parse({ leftIndent: 2 }), { leftIndent: 2 });
  assert.deepEqual(headingStyleInputSchema.parse({ numbered: true }), { numbered: true });
});

test("a paragraph format patch changes only its own fields; the rest still inherits from the section", () => {
  const answer = createAnswerDocument({ templateId: grid.id, title: "t", sections: [
    { id: "s", heading: "一、測試", paragraphFormat: { firstLineIndent: 2 }, text: "第一段。\n第二段。" }] });
  const patched = updateSectionFormatting(answer.sections[0], { paragraphFormats: [{ index: 1, format: { leftIndent: 2 } }] });
  assert.deepEqual(patched.paragraphs?.[1]?.format, { leftIndent: 2 });
  const body = firstLines(grid, [patched]).filter((line) => !line.isHeading);
  assert.deepEqual(body.map((line) => [line.format.firstLineIndent, line.format.leftIndent]), [[2, 0], [2, 2]]);
});

test("a partial heading style keeps the template's heading defaults", () => {
  // Like the 166 paper: headings default to non-bold.
  const plainHeadings = { ...grid, headingDefaults: { ...grid.headingDefaults, bold: false } };
  const answer = createAnswerDocument({ templateId: grid.id, title: "t", sections: [
    { id: "a", heading: "前言", headingStyle: { numbered: true }, text: "內容。" },
    { id: "b", heading: "結論", headingStyle: { numbered: true }, text: "內容。" }] });
  const headings = firstLines(plainHeadings, answer.sections).filter((line) => line.isHeading);
  assert.deepEqual(headings.map((line) => line.format.bold), [false, false]);
  assert.ok(headings[0].text.startsWith("壹") && headings[1].text.startsWith("貳"), headings.map((line) => line.text).join("|"));
});

const paperFont = process.env.ESSAY_MCP_PAPER_FONT;
test("the 166 paper accepts numbered headings without asking to turn off bold",
  { skip: !(paperFont && existsSync(paperFont)) && "ESSAY_MCP_PAPER_FONT not set" }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "police-essay-format-"));
    const server = createEssayMcpServer(new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "format-inheritance-test", version: "1" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const created = await client.callTool({ name: "create_answer", arguments: { templateId: "police_information_essay_166", title: "編號",
        sections: [{ id: "a", heading: "前言", headingStyle: { numbered: true }, text: "內容。" }] } });
      assert.equal(created.isError, undefined, JSON.stringify(created.content));
      const layout = (created.structuredContent as { layout: { lines: Array<{ isHeading: boolean; text: string; format: { bold: boolean } }> } }).layout;
      const heading = layout.lines.find((line) => line.isHeading)!;
      assert.equal(heading.format.bold, false);
      assert.match(heading.text, /^壹/);
    } finally {
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });
