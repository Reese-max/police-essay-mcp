import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createAnswerDocument, type AnswerDocument } from "../src/domain.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

const templateDir = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "templates");

function sample(): AnswerDocument {
  return createAnswerDocument({
    templateId: "police_information_essay",
    title: "預覽測試",
    sections: [
      { id: "intro", heading: "一、前言", text: "政府建置資訊系統應以業務需求為本。" },
      {
        id: "body",
        heading: "二、可行性評估",
        paragraphs: [
          { text: "（一）技術可行性：評估既有設備與人力。", format: { firstLineIndent: 2 } },
          { text: "（二）經濟可行性：比較成本與效益，判斷預算是否合理。", format: { leftIndent: 2 } },
        ],
      },
      { id: "end", heading: "三、結論", text: "完成評估可降低浪費及失敗風險。" },
    ],
  });
}

async function withClient(run: (client: Client, store: FileStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-preview-"));
  const store = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "preview-change-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try { await run(client, store); }
  finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
}

type Preview = { operation: string; applied: boolean; summary: string[]; after: { answer: AnswerDocument } };
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0].text;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("preview_change shows exactly the sections each write tool then saves", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["write_answer", { sections: [{ id: "intro", heading: "一、前言", text: "新的前言。" }, { id: "end", text: "結論。" }] }],
    ["replace_text", { sectionId: "body", newText: "（一）只剩一段。", heading: "二、評估" }],
    ["format_section", { sectionId: "body", paragraphFormats: [{ index: 1, format: { leftIndent: 4 } }] }],
    ["insert_text", { afterSectionId: "intro", section: { id: "extra", heading: "補充", text: "補充說明。" } }],
    ["delete_text", { sectionId: "intro" }],
    ["edit_text", { edits: [{ find: "判斷預算是否合理。", replace: "判斷預算是否合理，並評估維運成本。" }] }],
  ];
  await withClient(async (client, store) => {
    for (const [operation, args] of cases) {
      const answer = sample();
      await store.saveAnswer(answer);
      const previewed = await client.callTool({ name: "preview_change", arguments: { answerId: answer.id, operation, expectedVersion: 1, ...args } });
      assert.equal(previewed.isError, undefined, `${operation}: ${text(previewed)}`);
      const preview = previewed.structuredContent as Preview;
      assert.equal(preview.operation, operation);
      assert.equal(preview.applied, false);
      assert.equal(preview.summary[0], "版本 1 → 2（尚未套用）");
      assert.equal((await store.getAnswer(answer.id)).version, 1, `${operation} preview must not save`);

      const written = await client.callTool({ name: operation, arguments: { answerId: answer.id, expectedVersion: 1, ...args } });
      assert.equal(written.isError, undefined, `${operation}: ${text(written)}`);
      const saved = await store.getAnswer(answer.id);
      assert.equal(saved.version, 2);
      assert.deepEqual(plain(preview.after.answer.sections), plain(saved.sections), operation);
    }
  });
});

test("edits keep the layout order when stored sections are not in array order", async () => {
  await withClient(async (client, store) => {
    // `order` decides the layout: this answer shows end before intro although intro comes first in the array.
    const base = sample();
    const answer = { ...base, sections: [{ ...base.sections[0], order: 2 }, { ...base.sections[1], order: 0 }, { ...base.sections[2], order: 1 }] };
    await store.saveAnswer(answer);
    const laidOut = (doc: AnswerDocument) => [...doc.sections].sort((a, b) => a.order - b.order).map((section) => section.id);
    assert.deepEqual(laidOut(answer), ["body", "end", "intro"]);
    let version = 1;
    for (const [name, args] of [
      ["replace_text", { sectionId: "intro", newText: "新的前言。" }],
      ["format_section", { sectionId: "end", paragraphFormat: { leftIndent: 2 } }],
      ["edit_text", { edits: [{ find: "降低浪費", replace: "減少浪費" }] }],
    ] as const) {
      const previewed = await client.callTool({ name: "preview_change", arguments: { answerId: answer.id, operation: name, expectedVersion: version, ...args } });
      assert.deepEqual(laidOut((previewed.structuredContent as Preview).after.answer), ["body", "end", "intro"], name);
      const written = await client.callTool({ name, arguments: { answerId: answer.id, expectedVersion: version, ...args } });
      assert.equal(written.isError, undefined, `${name}: ${text(written)}`);
      assert.deepEqual(laidOut(await store.getAnswer(answer.id)), ["body", "end", "intro"], name);
      version += 1;
    }
    const restored = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version: 1, expectedVersion: version } });
    assert.equal(restored.isError, undefined, text(restored));
    assert.deepEqual(laidOut(await store.getAnswer(answer.id)), ["body", "end", "intro"]);
  });
});

test("preview_change explains arguments that do not fit the previewed tool and saves nothing", async () => {
  await withClient(async (client, store) => {
    const answer = sample();
    await store.saveAnswer(answer);
    const preview = (args: Record<string, unknown>) => client.callTool({ name: "preview_change", arguments: { answerId: answer.id, ...args } });

    let result = await preview({ operation: "delete_text", sectionId: "intro", edits: [{ find: "政府", replace: "機關" }] });
    assert.equal(result.isError, true);
    assert.match(text(result), /delete_text 不使用 edits；它的參數是 sectionId/);

    result = await preview({ operation: "replace_text", newText: "新內容" });
    assert.equal(result.isError, true);
    assert.match(text(result), /replace_text 的參數不正確：sectionId/);

    result = await preview({ operation: "replace_text", sectionId: "body" });
    assert.equal(result.isError, true);
    assert.match(text(result), /必須提供 newText，或提供至少一個 paragraphs 項目/);

    result = await preview({ operation: "format_section", sectionId: "missing", paragraphFormat: { leftIndent: 2 } });
    assert.equal(result.isError, true);
    assert.match(text(result), /找不到 sectionId missing/);

    result = await preview({ operation: "edit_text", edits: [{ find: "不存在的字", replace: "x" }] });
    assert.equal(result.isError, true);
    assert.match(text(result), /找不到「不存在的字」/);

    result = await preview({ operation: "edit_text", expectedVersion: 2, edits: [{ find: "政府", replace: "機關" }] });
    assert.equal(result.isError, true);
    assert.match(text(result), /Version conflict/);

    result = await preview({ operation: "rename_answer", sectionId: "intro" });
    assert.equal(result.isError, true);

    // Arguments no tool takes are reported too, not silently dropped.
    result = await preview({ operation: "delete_text", sectionId: "intro", newTitle: "x" });
    assert.equal(result.isError, true);
    assert.match(text(result), /newTitle/);

    assert.deepEqual(plain(await store.getAnswer(answer.id)), plain(answer));
  });
});
