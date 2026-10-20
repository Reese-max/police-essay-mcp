import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnswerDocument, type AnswerDocument, type AnswerSection } from "../src/domain.js";
import { renumberItems } from "../src/numbering.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

const templateDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "templates");

function answerWith(sections: Parameters<typeof createAnswerDocument>[0]["sections"]): AnswerDocument {
  return createAnswerDocument({ templateId: "police_information_essay", title: "寫作工具測試", sections });
}
const texts = (section: AnswerSection) => section.paragraphs?.length ? section.paragraphs.map((paragraph) => paragraph.text) : section.text.split("\n");

async function withClient(run: (client: Client, store: FileStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-writing-"));
  const store = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "writing-tools-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client, store); }
  finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0].text;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("renumberItems counts each level and restarts it under a higher-level item", () => {
  const answer = answerWith([
    { id: "a", heading: "貳、前言", text: "引言。" },
    { id: "b", heading: "壹、本文", paragraphs: [
      { text: "（二）技術可行性：", format: { leftIndent: 2 } },
      { text: "3. 設備。" },
      { text: "1. 人力。" },
      { text: "（五）經濟可行性：" },
      { text: "４．成本。" },
      { text: "1.5 億元的預算不是編號。" },
      { text: "沒有編號的段落。" },
    ] },
  ]);
  const { sections, renumbered } = renumberItems(answer.sections);
  assert.deepEqual(sections.map((section) => section.heading), ["壹、前言", "貳、本文"]);
  assert.deepEqual(texts(sections[1]), ["（一）技術可行性：", "1. 設備。", "2. 人力。", "（二）經濟可行性：", "１．成本。", "1.5 億元的預算不是編號。", "沒有編號的段落。"]);
  assert.equal(sections[1].paragraphs![0].format?.leftIndent, 2);
  assert.equal(renumbered, 7);
  // Limited to one section: headings stay as they are.
  const only = renumberItems(answer.sections, "b");
  assert.deepEqual(only.sections.map((section) => section.heading), ["貳、前言", "壹、本文"]);
  assert.throws(() => renumberItems(sections), /編號已經是連續的/);
  assert.throws(() => renumberItems(answer.sections, "missing"), /找不到 sectionId missing/);
});

test("move_section reorders sections, previews exactly, and suggests renumbering", async () => {
  await withClient(async (client, store) => {
    const answer = answerWith([
      { id: "intro", heading: "一、前言", text: "前言。" },
      { id: "body", heading: "二、本文", text: "本文。" },
      { id: "end", heading: "三、結論", text: "結論。" },
    ]);
    await store.saveAnswer(answer);
    const order = async () => [...(await store.getAnswer(answer.id)).sections].sort((a, b) => a.order - b.order).map((section) => section.id);
    for (const [args, message] of [
      [{ sectionId: "end" }, /擇一/],
      [{ sectionId: "end", beforeSectionId: "intro", afterSectionId: "body" }, /擇一/],
      [{ sectionId: "end", afterSectionId: "end" }, /自己/],
      [{ sectionId: "end", afterSectionId: "body" }, /已經在這個位置/],
      [{ sectionId: "end", afterSectionId: "missing" }, /找不到 sectionId missing/],
    ] as const) {
      const result = await client.callTool({ name: "move_section", arguments: { answerId: answer.id, expectedVersion: 1, ...args } });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(text(result), message);
    }
    const args = { sectionId: "end", beforeSectionId: "body" };
    const preview = await client.callTool({ name: "preview_change", arguments: { answerId: answer.id, operation: "move_section", expectedVersion: 1, ...args } });
    assert.equal(preview.isError, undefined, text(preview));
    const moved = await client.callTool({ name: "move_section", arguments: { answerId: answer.id, expectedVersion: 1, ...args } });
    assert.equal(moved.isError, undefined, text(moved));
    assert.deepEqual(await order(), ["intro", "end", "body"]);
    assert.deepEqual(plain((preview.structuredContent as { after: { answer: AnswerDocument } }).after.answer.sections),
      plain((await store.getAnswer(answer.id)).sections));
    assert.match(text(moved), /區塊順序改變/);
    assert.match(text(moved), /編號已不連續/);

    const renumbered = await client.callTool({ name: "renumber_items", arguments: { answerId: answer.id, expectedVersion: 2 } });
    assert.equal(renumbered.isError, undefined, text(renumbered));
    assert.equal((renumbered.structuredContent as { renumbered: number }).renumbered, 2);
    const headings = [...(await store.getAnswer(answer.id)).sections].sort((a, b) => a.order - b.order).map((section) => section.heading);
    assert.deepEqual(headings, ["一、前言", "二、結論", "三、本文"]);
    assert.doesNotMatch(text(renumbered), /編號已不連續/);
  });
});

test("line targets drive check_layout's per-section report and survive later edits", async () => {
  await withClient(async (client, store) => {
    const answer = answerWith([
      { id: "intro", heading: "一、前言", text: "前言。" },
      { id: "body", heading: "二、本文", text: "第一段。\n第二段。" },
    ]);
    await store.saveAnswer(answer);
    let result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 1,
      targets: [{ sectionId: "intro", lines: 3 }, { sectionId: "body", lines: 2 }] } });
    assert.equal(result.isError, undefined, text(result));
    assert.match(text(result), /「一、前言」目標行數：未設定→3 行/);
    assert.deepEqual((await store.getAnswer(answer.id)).lineTargets, { intro: 3, body: 2 });

    result = await client.callTool({ name: "check_layout", arguments: { answerId: answer.id } });
    const report = result.structuredContent as { sections: Array<{ sectionId: string; lines: number; targetLines?: number; overTarget?: number }>; notes: string[] };
    assert.deepEqual(report.sections.map((section) => [section.sectionId, section.lines, section.targetLines, section.overTarget]),
      [["intro", 2, 3, -1], ["body", 3, 2, 1]]);
    assert.match(text(result), /各節：「一、前言」2 行（目標 3）、「二、本文」3 行（目標 2）/);
    assert.ok(report.notes.some((note) => /低於目標的區塊：「一、前言」少 1 行/.test(note)), report.notes.join("|"));
    assert.ok(report.notes.some((note) => /超過目標：「二、本文」多 1 行/.test(note)), report.notes.join("|"));

    // Targets stay through ordinary edits and show up in the version history.
    result = await client.callTool({ name: "edit_text", arguments: { answerId: answer.id, expectedVersion: 2, edits: [{ find: "前言。", replace: "前言內容。" }] } });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual((await store.getAnswer(answer.id)).lineTargets, { intro: 3, body: 2 });
    result = await client.callTool({ name: "list_revisions", arguments: { answerId: answer.id } });
    const revisions = (result.structuredContent as { revisions: Array<{ version: number; changes: string[] }> }).revisions;
    assert.deepEqual(revisions.find((revision) => revision.version === 2)!.changes,
      ["「一、前言」目標行數：未設定→3 行", "「二、本文」目標行數：未設定→2 行"]);

    result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 3, targets: [{ sectionId: "intro", lines: null }] } });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual((await store.getAnswer(answer.id)).lineTargets, { body: 2 });
    result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 4, targets: [{ sectionId: "body", lines: 2 }] } });
    assert.equal(result.isError, true);
    assert.match(text(result), /沒有需要儲存的變更/);
    result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 4, targets: [{ sectionId: "nope", lines: 2 }] } });
    assert.equal(result.isError, true);
    assert.equal((await store.getAnswer(answer.id)).version, 4);
  });
});

test("the read-only server lists none of the new writing tools", async () => {
  const server = createEssayMcpServer(new FileStore({ templateDir }), { readOnly: true });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "writing-tools-reader", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of ["move_section", "renumber_items", "set_line_targets"]) assert.ok(!names.includes(name), name);
    assert.ok(names.includes("check_layout") && names.includes("preview_change"));
  } finally { await client.close(); }
});
