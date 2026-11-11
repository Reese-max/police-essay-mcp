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
  // Listing the tools makes the client check every structuredContent against its outputSchema.
  await client.listTools();
  try { await run(client, store); }
  finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
}
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0].text;
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("overflow edits return a fresh plan until fits, while first drafts still require check_layout", async () => {
  await withClient(async (client, store) => {
    for (const responseDetail of ["summary", "full"]) {
      const created = await client.callTool({ name: "create_answer", arguments: { templateId: "police_information_essay",
        title: "動態減行", sections: [{ id: "body", text: "甲".repeat(21 * 50) }], responseDetail } });
      assert.equal(created.isError, undefined, text(created));
      type Result = { answer: AnswerDocument; layout: { fits: boolean; totalLines: number }; compressionPlan?: string };
      let current = created.structuredContent as Result;
      assert.equal(current.layout.fits, false);
      assert.equal(current.compressionPlan, undefined);
      for (const lines of [46, 49, 20]) {
        const edited = await client.callTool({ name: "replace_text", arguments: { answerId: current.answer.id,
          sectionId: "body", newText: "甲".repeat(21 * lines), expectedVersion: current.answer.version, responseDetail } });
        assert.equal(edited.isError, undefined, text(edited));
        current = edited.structuredContent as Result;
        if (current.layout.fits) assert.equal(current.compressionPlan, undefined);
        else {
          assert.match(current.compressionPlan ?? "", new RegExp(`總計 ${current.layout.totalLines}/44 行`));
          assert.match(current.compressionPlan ?? "", /body \d+→\d+ 行/);
          assert.match(current.compressionPlan ?? "", /replace_text/);
          assert.ok((text(edited) + "\n" + JSON.stringify(edited.structuredContent)).slice(0, 12_000).includes('"compressionPlan"'), "計畫必須在評估回應截斷前可見");
        }
      }
      assert.equal(current.layout.fits, true);
      assert.equal((await store.getAnswer(current.answer.id)).version, 4);
    }
  });
});

test("tool recovery: no-op writes preserve revisions and stale versions still fail", async () => {
  await withClient(async (client, store) => {
    const answer = answerWith([{ id: "body", heading: "一、內容", text: "1.內容。" }]);
    answer.lineTargets = { body: 3 };
    await store.saveAnswer(answer);
    for (const [name, args] of [
      ["update_answer_info", { title: answer.title }],
      ["set_line_targets", { targets: [{ sectionId: "body", lines: 3 }] }],
      ["edit_text", { edits: [{ find: "內容。", replace: "內容。" }] }],
      ["renumber_items", {}],
    ] as const) {
      const result = await client.callTool({ name, arguments: { answerId: answer.id, expectedVersion: 1, ...args } });
      assert.equal(result.isError, undefined, text(result));
      assert.match(text(result), /沒有需要儲存的變更/);
      assert.deepEqual(await store.getAnswer(answer.id), plain(answer));
      assert.equal((await store.listRevisions(answer.id, { limit: 10 })).length, 1);
      const stale = await client.callTool({ name, arguments: { answerId: answer.id, expectedVersion: 2, ...args } });
      assert.equal(stale.isError, true);
      assert.match(text(stale), /Version conflict/);
    }
  });
});

test("tool recovery: create, batch and replace prefer paragraphs; conflicts return continuation IDs", async () => {
  await withClient(async (client, store) => {
    const args = { examId: null, templateId: "police_information_essay", title: "容錯", idempotencyKey: "recovery-single",
      sections: [{ id: "body", text: "過時文字", paragraphs: [{ text: "正確內容。", format: { bold: true } }] }] };
    const created = await client.callTool({ name: "create_answer", arguments: args });
    assert.equal(created.isError, undefined, text(created));
    const answer = (created.structuredContent as { answer: AnswerDocument }).answer;
    assert.equal((await store.getAnswer(answer.id)).sections[0].text, "正確內容。");
    const unchanged = await client.callTool({ name: "update_answer_info", arguments: { answerId: answer.id, title: args.title, responseDetail: "full" } });
    assert.equal(unchanged.isError, undefined, text(unchanged));
    assert.ok(!JSON.stringify(unchanged).includes("createRequestHash"));
    assert.equal((await store.listExams()).length, 0);
    const { examId: _noExam, ...withoutExam } = args;
    const replay = await client.callTool({ name: "create_answer", arguments: withoutExam });
    assert.equal(replay.isError, undefined, text(replay));
    assert.equal((replay.structuredContent as { answer: AnswerDocument }).answer.id, answer.id);
    const conflict = await client.callTool({ name: "create_answer", arguments: { ...args, title: "異動" } });
    assert.equal(conflict.isError, true);
    assert.ok(text(conflict).includes(answer.id));
    const replaced = await client.callTool({ name: "replace_text", arguments: { answerId: answer.id, sectionId: "body", expectedVersion: 1,
      newText: "過時替換", paragraphs: [{ text: "新內容。", format: { bold: true } }] } });
    assert.equal(replaced.isError, undefined, text(replaced));
    const section = (await store.getAnswer(answer.id)).sections[0];
    assert.equal(section.text, "新內容。");
    assert.equal(section.paragraphs![0].format?.bold, true);
    const started = await client.callTool({ name: "start_exam", arguments: { title: "容錯", questions: [{ questionNo: 1 }], idempotencyKey: "recovery-exam" } });
    assert.equal(started.isError, undefined, text(started));
    const { examId } = started.structuredContent as { examId: string };
    const batchArgs = { ...args, examId, idempotencyKey: "recovery-batch" };
    const batch = await client.callTool({ name: "create_answers", arguments: { examId, answers: [batchArgs] } });
    assert.equal(batch.isError, undefined, text(batch));
    const saved = (await store.getExam(examId)).questions[0].answerId!;
    assert.equal((await store.getAnswer(saved)).sections[0].text, "正確內容。");
    const reused = await client.callTool({ name: "create_answers", arguments: { examId, answers: [{ ...batchArgs, title: "異動" }] } });
    assert.equal(reused.isError, true);
    assert.ok(text(reused).includes(saved), text(reused));
    assert.ok(text(reused).includes(examId), text(reused));
    assert.equal((await store.listAnswers()).length, 2);
  });
});

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
      [{ sectionId: "end", beforeSectionId: "intro", afterSectionId: "body" }, /指向不同位置/],
      [{ sectionId: "end", beforeSectionId: "x", afterSectionId: "y" }, /擇一/],
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

    // Strict-schema clients fill both anchors: a placeholder or an agreeing pair still moves.
    const back = await client.callTool({ name: "move_section", arguments: { answerId: answer.id, expectedVersion: 2, sectionId: "end", beforeSectionId: "x", afterSectionId: "body" } });
    assert.equal(back.isError, undefined, text(back)); assert.deepEqual(await order(), ["intro", "body", "end"]);
    const again = await client.callTool({ name: "move_section", arguments: { answerId: answer.id, expectedVersion: 3, sectionId: "end", beforeSectionId: "body", afterSectionId: "intro" } });
    assert.equal(again.isError, undefined, text(again)); assert.deepEqual(await order(), ["intro", "end", "body"]);
    const renumbered = await client.callTool({ name: "renumber_items", arguments: { answerId: answer.id, expectedVersion: 4 } });
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
    assert.equal(result.isError, undefined);
    assert.match(text(result), /沒有需要儲存的變更/);
    result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 4, targets: [{ sectionId: "nope", lines: 2 }] } });
    assert.equal(result.isError, true);
    assert.equal((await store.getAnswer(answer.id)).version, 4);
  });
});

test("deleting a section drops its line target, and reinserting the same id does not inherit it", async () => {
  await withClient(async (client, store) => {
    const answer = answerWith([
      { id: "intro", heading: "一、前言", text: "前言。" },
      { id: "body", heading: "二、本文", text: "第一段。\n第二段。" },
    ]);
    await store.saveAnswer(answer);

    let result = await client.callTool({ name: "set_line_targets", arguments: { answerId: answer.id, expectedVersion: 1,
      targets: [{ sectionId: "body", lines: 2 }] } });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual((await store.getAnswer(answer.id)).lineTargets, { body: 2 });

    result = await client.callTool({ name: "delete_text", arguments: { answerId: answer.id, sectionId: "body", expectedVersion: 2 } });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual((await store.getAnswer(answer.id)).lineTargets, {});

    result = await client.callTool({ name: "insert_text", arguments: { answerId: answer.id, expectedVersion: 3,
      section: { id: "body", heading: "二、新本文", text: "全新內容。" } } });
    assert.equal(result.isError, undefined, text(result));
    assert.deepEqual((await store.getAnswer(answer.id)).lineTargets, {});

    result = await client.callTool({ name: "check_layout", arguments: { answerId: answer.id } });
    const report = result.structuredContent as { sections: Array<{ sectionId: string; lines: number; targetLines?: number; overTarget?: number }>; notes: string[] };
    const bodySection = report.sections.find((section) => section.sectionId === "body");
    assert.ok(bodySection, "reinserted body section should appear in the layout report");
    assert.equal(bodySection.targetLines, undefined);
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

test("renumbering notes reach the preview, and an impossible renumbering is still reported after an edit", async () => {
  await withClient(async (client, store) => {
    const answer = answerWith([{ id: "a", heading: "一、說明", text: "二、三級機關應依規定辦理。\n一、組織。\n三、預算。" }]);
    await store.saveAnswer(answer);
    const preview = await client.callTool({ name: "preview_change", arguments: { answerId: answer.id, operation: "renumber_items", expectedVersion: 1 } });
    assert.equal(preview.isError, undefined, text(preview));
    assert.ok((preview.structuredContent as { summary: string[] }).summary.some((line) => /未計入.*「一、說明」第1段/.test(line)));
    const renumbered = await client.callTool({ name: "renumber_items", arguments: { answerId: answer.id, expectedVersion: 1 } });
    assert.equal(renumbered.isError, undefined, text(renumbered));
    assert.deepEqual((renumbered.structuredContent as { skipped: string[] }).skipped.length, 1);

    const inserted = await client.callTool({ name: "insert_text", arguments: { answerId: answer.id, expectedVersion: 2,
      section: { id: "long", text: Array.from({ length: 100 }, () => "（一）項目").join("\n") } } });
    assert.equal(inserted.isError, undefined, text(inserted));
    assert.match(text(inserted), /無法自動重新編號：.*第 100 項/);
  });
});
