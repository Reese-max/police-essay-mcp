import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describeChanges, describeTextChange } from "../src/changes.js";
import { CloudStore } from "../src/cloud-storage.js";
import { applyTextEdits, createAnswerDocument, type AnswerDocument, type AnswerTemplate } from "../src/domain.js";
import { layoutSections } from "../src/layout.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore, type EssayStore } from "../src/storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const templateDir = path.join(projectRoot, "templates");
const template = JSON.parse(readFileSync(path.join(templateDir, "police_information_essay.json"), "utf8")) as AnswerTemplate;

function sample(): AnswerDocument {
  return createAnswerDocument({
    templateId: template.id,
    title: "可行性評估",
    sections: [
      { id: "intro", heading: "一、前言", text: "政府建置資訊系統應以業務需求為本。" },
      {
        id: "body",
        heading: "二、可行性評估",
        paragraphs: [
          { text: "（一）技術可行性：評估既有設備與人力。", format: { firstLineIndent: 2 } },
          { text: "（二）經濟可行性：比較成本與效益，判斷預算是否合理。", format: { leftIndent: 2 } },
          { text: "（三）作業可行性：確認使用者接受度與教育訓練需求。" },
        ],
      },
      { id: "end", heading: "三、結論", text: "完成評估可降低浪費及失敗風險。" },
    ],
  });
}
const snap = (answer: AnswerDocument) => ({ answer, layout: layoutSections(template, answer.sections) });
const texts = (answer: AnswerDocument, id: string) => answer.sections.find((section) => section.id === id)!.paragraphs!.map((p) => p.text);

test("edit_text core: unique, anchored insert, delete, occurrence, replaceAll and heading edits", () => {
  const answer = sample();
  const { sections, replacements } = applyTextEdits(answer.sections, [
    { find: "判斷預算是否合理。", replace: "判斷預算是否合理。並須評估經費來源及長期維運負擔。" },
    { find: "與人力", replace: "" },
    { find: "可行性：", replace: "可行性——", occurrence: 2 },
    { find: "評估", replace: "檢討", sectionId: "end" },
    { find: "可行性評估", replace: "四面向可行性評估" },
  ]);
  assert.deepEqual(replacements, [1, 1, 1, 1, 1]);
  const body = sections.find((section) => section.id === "body")!;
  assert.equal(body.heading, "二、四面向可行性評估");
  assert.deepEqual(body.paragraphs!.map((p) => p.text), [
    "（一）技術可行性：評估既有設備。",
    "（二）經濟可行性——比較成本與效益，判斷預算是否合理。並須評估經費來源及長期維運負擔。",
    "（三）作業可行性：確認使用者接受度與教育訓練需求。",
  ]);
  // Formats ride along with their paragraphs; untouched sections are the same objects.
  assert.deepEqual([body.paragraphs![0].format?.firstLineIndent, body.paragraphs![1].format?.leftIndent, body.paragraphs![2].format], [2, 2, undefined]);
  assert.equal(body.text, body.paragraphs!.map((p) => p.text).join("\n"));
  assert.equal(sections[0], answer.sections[0]);
  assert.equal(sections.find((section) => section.id === "end")!.text, "完成檢討可降低浪費及失敗風險。");

  const all = applyTextEdits(answer.sections, [{ find: "可行性", replace: "可行度", replaceAll: true, sectionId: "body" }]);
  assert.deepEqual(all.replacements, [4]);
  assert.ok(texts({ ...answer, sections: all.sections }, "body").every((text) => !text.includes("可行性")));
});

test("edit_text core: ambiguous, missing and no-op edits fail with actionable messages and change nothing", () => {
  const answer = sample();
  const before = JSON.stringify(answer);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "可行性：", replace: "x" }]),
    /第 1 項修改：「可行性：」出現 3 次：1\) 「二、可行性評估」第 1 段：…（一）技術【可行性：】評估既有設備與人力。….*occurrence/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "成本與效益,判斷", replace: "x" }]), /忽略空白與全形／半形標點後可以找到/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "不存在的句子", replace: "x" }]), /找不到「不存在的句子」.*read_answer/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "前言", replace: "x", sectionId: "body" }]), /找不到「前言」（限區塊 body）/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "可行性：", replace: "x", occurrence: 4 }]), /只出現 3 次，沒有第 4 處/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "前言", replace: "前言" }]), /與原文相同/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "一、前言", replace: "一、\n前言" }]), /標題的 replace 不可包含換行/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "政府建置資訊系統應以業務需求為本。", replace: "" }]), /清空區塊「一、前言」.*delete_text/);
  // The second edit fails, so the first one is not applied either.
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "前言", replace: "緒論" }, { find: "前言", replace: "y" }]), /第 2 項修改：找不到「前言」/);
  assert.equal(JSON.stringify(answer), before);
});

test("edit_text core: parts emptied after a split are dropped and later edits see the new paragraph numbers", () => {
  const answer = sample();
  const splitThenDelete = applyTextEdits(answer.sections, [
    { find: "比較成本與效益，", replace: "比較成本與效益。\n" },
    { find: "判斷預算是否合理。", replace: "" },
  ]).sections;
  assert.deepEqual(texts({ ...answer, sections: splitThenDelete }, "body"),
    ["（一）技術可行性：評估既有設備與人力。", "（二）經濟可行性：比較成本與效益。", "（三）作業可行性：確認使用者接受度與教育訓練需求。"]);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: "政府建置資訊系統應以業務需求為本。", replace: "\n" }]), /第 1 項修改：會清空區塊「一、前言」/);
  assert.throws(() => applyTextEdits(answer.sections, [
    { find: "比較成本與效益，", replace: "比較成本與效益。\n另應" },
    { find: "可行性：", replace: "x" },
  ]), /第 2 項修改：「可行性：」出現 3 次：.*2\) 「二、可行性評估」第 2 段.*3\) 「二、可行性評估」第 4 段/);
  assert.throws(() => applyTextEdits(answer.sections, [{ find: " ", replace: "x" }]), (error: Error) =>
    /read_answer/.test(error.message) && !/忽略空白/.test(error.message));
});

test("change descriptions report a rewritten paragraph's format change too", () => {
  const before = sample();
  const body = before.sections[1];
  const after = { ...before, sections: [before.sections[0], { ...body, paragraphs: body.paragraphs!.map((p, i) => i === 1
    ? { text: "（二）經濟可行性：比較成本與效果。", format: { ...p.format!, leftIndent: 4 } } : p) }, before.sections[2]] };
  const lines = describeChanges(snap(before), snap(after));
  assert.equal(lines[0], "「二、可行性評估」第2段（第1頁第5行）：「益，判斷預算是否合理」改為「果」；格式：leftIndent 2→4");
});

test("edit_text core: chained replaceAll growth is capped before any text is built", () => {
  const answer = sample();
  const edits = Array.from({ length: 6 }, () => ({ find: "可", replace: "可".repeat(10_000), replaceAll: true }));
  assert.throws(() => applyTextEdits(answer.sections, edits), /第 2 項修改：修改後全文會超過 300000 字元的上限/);
});

test("change descriptions fall back to positional pairing for very long sections", () => {
  const paragraphs = Array.from({ length: 600 }, (_, index) => ({ text: `第${index}段。` }));
  const before = createAnswerDocument({ templateId: template.id, title: "長", sections: [{ id: "long", paragraphs }] });
  const after = { ...before, sections: [{ ...before.sections[0], paragraphs: paragraphs.map((p, index) => ({ text: index === 3 ? "改過。" : p.text })) }] };
  const lines = describeChanges({ answer: before, layout: layoutSections(template, before.sections) },
    { answer: after, layout: layoutSections(template, after.sections) });
  assert.equal(lines[0], "「long」第4段（第1頁第4行）：「第3段」改為「改過」");
});

test("edit_text core: a newline splits a paragraph keeping its format and an emptied paragraph is removed", () => {
  const answer = sample();
  const split = applyTextEdits(answer.sections, [{ find: "比較成本與效益，", replace: "比較成本與效益。\n另應" }]).sections;
  const body = split.find((section) => section.id === "body")!;
  assert.deepEqual(body.paragraphs!.map((p) => p.text), [
    "（一）技術可行性：評估既有設備與人力。", "（二）經濟可行性：比較成本與效益。", "另應判斷預算是否合理。", "（三）作業可行性：確認使用者接受度與教育訓練需求。",
  ]);
  // The first paragraph never set leftIndent, so it still inherits it.
  assert.deepEqual(body.paragraphs!.map((p) => p.format?.leftIndent), [undefined, 2, 2, undefined]);
  const removed = applyTextEdits(answer.sections, [{ find: "（三）作業可行性：確認使用者接受度與教育訓練需求。", replace: "" }]).sections;
  assert.deepEqual(texts({ ...answer, sections: removed }, "body").length, 2);
});

test("change descriptions name the edited fragment, its page and line, and where the grid shifts", () => {
  assert.equal(describeTextChange("判斷預算是否合理。", "判斷預算是否合理。並須評估經費來源。"), "在「判斷預算是否合理。」之後加入「並須評估經費來源。」");
  assert.equal(describeTextChange("比較成本與效益，判斷預算是否合理。", "比較成本與效益，判斷預算。"), "刪除「是否合理」");
  assert.equal(describeTextChange("比較成本與效益", "比較成本與效果"), "「益」改為「果」");
  assert.equal(describeTextChange("效益", "新增效益"), "在段首加入「新增」");
  const before = sample();
  const edited = { ...before, version: 2, sections: applyTextEdits(before.sections, [
    { find: "判斷預算是否合理。", replace: "判斷預算是否合理。並須評估經費來源及長期維運負擔，以及跨年度預算編列與審議時程。" },
  ]).sections };
  const changes = describeChanges(snap(before), snap(edited));
  assert.equal(changes[0], "「二、可行性評估」第2段（第1頁第5–7行）：在「…，判斷預算是否合理。」之後加入「並須評估經費來源及長期維運負擔，以及跨年度預算編列與審議時程。」");
  // The paragraph's first line (line 5) is untouched; the added text starts on line 6 and adds one line.
  assert.equal(changes[1], "版面自第1頁第6行起改變；第1頁 10→11 行。");
  assert.deepEqual(describeChanges(snap(before), snap(before)), ["版面沒有改變。"]);

  const restructured = { ...before, sections: [before.sections[2], { ...before.sections[1], paragraphFormat: { firstLineIndent: 4 } },
    ...createAnswerDocument({ templateId: template.id, title: "x", sections: [{ id: "new", heading: "四、補充", text: "新增內容。" }] }).sections] };
  const lines = describeChanges(snap(before), snap(restructured));
  assert.ok(lines.includes("「二、可行性評估」全區塊段落格式：firstLineIndent 預設→4"), lines.join("\n"));
  assert.ok(lines.some((line) => /^新增區塊「四、補充」（第1頁第\d+–\d+行）$/.test(line)), lines.join("\n"));
  assert.ok(lines.some((line) => /^刪除區塊「一、前言」（原第1頁第1–2行）$/.test(line)), lines.join("\n"));
  assert.ok(lines.includes("區塊順序改變：「三、結論」、「二、可行性評估」、「四、補充」"), lines.join("\n"));
});

async function connect(store: EssayStore, readOnly = false) {
  const server = createEssayMcpServer(store, { readOnly });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "edit-text-test", version: "1" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}
type Structured = { answer: AnswerDocument; changes: string[]; replacements: number; summary: string[]; applied: boolean;
  revisions: Array<{ version: number; changes: string[]; totalLines: number; fits: boolean }>; currentVersion: number; olderVersions: number };
const structured = (result: Awaited<ReturnType<Client["callTool"]>>) => result.structuredContent as Structured;
const text = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as Array<{ text: string }>)[0].text;

async function exerciseStore(store: EssayStore) {
  const answer = sample();
  await store.saveAnswer(answer);
  const client = await connect(store);
  try {
    // The user-reported case: four short additions used to need a full write_answer.
    const edits = [
      { find: "判斷預算是否合理。", replace: "判斷預算是否合理。並須評估經費來源及長期維運負擔。" },
      { find: "教育訓練需求。", replace: "教育訓練需求。若人員不願使用，亦應納入評估。" },
      { find: "既有設備與人力。", replace: "既有設備與人力。另須預留資安測試時間。" },
      { find: "降低浪費及失敗風險。", replace: "降低浪費及失敗風險，兼顧依法行政與公共服務品質。" },
    ];
    const preview = await client.callTool({ name: "preview_change", arguments: { answerId: answer.id, operation: "edit_text", edits, expectedVersion: 1 } });
    assert.equal(preview.isError, undefined, JSON.stringify(preview));
    assert.equal(structured(preview).applied, false);
    assert.equal(structured(preview).summary[0], "版本 1 → 2（尚未套用）");
    assert.ok(structured(preview).summary.some((line) => line.startsWith("「二、可行性評估」第2段（第1頁") && line.includes("加入「並須評估經費來源及長期維運負擔。」")));
    assert.equal((await store.getAnswer(answer.id)).version, 1);

    const edited = await client.callTool({ name: "edit_text", arguments: { answerId: answer.id, edits, expectedVersion: 1 } });
    assert.equal(edited.isError, undefined, JSON.stringify(edited));
    assert.equal(structured(edited).replacements, 4);
    assert.equal(structured(edited).answer.version, 2);
    assert.equal(structured(edited).changes.length, 5, structured(edited).changes.join("\n"));
    assert.match(text(edited), /^已修改 4 處（版本 1 → 2）；/);
    assert.match(text(edited), /\n・「三、結論」第1段（第1頁第\d+(–\d+)?行）：在「…可降低浪費及失敗風險」之後加入「，兼顧依法行政與公共服務品質」\n/);
    assert.equal((await store.getAnswer(answer.id)).version, 2);

    const conflict = await client.callTool({ name: "edit_text", arguments: { answerId: answer.id, edits: [{ find: "前言", replace: "緒論" }], expectedVersion: 1 } });
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /Version conflict/);
    const ambiguous = await client.callTool({ name: "edit_text", arguments: { answerId: answer.id, edits: [{ find: "可行性：", replace: "x" }] } });
    assert.equal(ambiguous.isError, true);
    assert.match(text(ambiguous), /出現 3 次/);
    assert.equal((await store.getAnswer(answer.id)).version, 2);

    const replaced = await client.callTool({ name: "replace_text", arguments: { answerId: answer.id, sectionId: "intro", newText: "政府建置系統應以需求為本。", expectedVersion: 2 } });
    // Existing write tools now report the same change list.
    assert.match(text(replaced), /\n・「一、前言」第1段（第1頁第2行）：「資訊系統應以業務」改為「系統應以」\n・版面自第1頁第2行起改變。$/);

    const listed = await client.callTool({ name: "list_revisions", arguments: { answerId: answer.id } });
    assert.equal(listed.isError, undefined, JSON.stringify(listed));
    assert.equal(structured(listed).currentVersion, 3);
    assert.deepEqual(structured(listed).revisions.map((revision) => revision.version), [3, 2, 1]);
    assert.deepEqual(structured(listed).revisions[2].changes, ["建立答案。"]);
    assert.ok(structured(listed).revisions[1].changes.some((line) => line.includes("加入「並須評估經費來源及長期維運負擔。」")));
    assert.match(text(listed), /^第 3 版（.*）：「一、前言」第1段/);
    const limited = await client.callTool({ name: "list_revisions", arguments: { answerId: answer.id, limit: 1 } });
    assert.deepEqual(structured(limited).revisions.map((revision) => revision.version), [3]);
    assert.equal(structured(limited).olderVersions, 2);
    assert.ok(!structured(limited).revisions[0].changes[0].includes("無法比較"));

    for (const [version, message] of [[3, /就是目前的版本/], [9, /沒有第 9 版/]] as const) {
      const failed = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version, expectedVersion: 3 } });
      assert.equal(failed.isError, true);
      assert.match(text(failed), message);
    }
    const restored = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version: 1, expectedVersion: 3 } });
    assert.equal(restored.isError, undefined, JSON.stringify(restored));
    assert.match(text(restored), /^已還原第 1 版的內容，存為第 4 版；/);
    const current = await store.getAnswer(answer.id);
    assert.equal(current.version, 4);
    assert.deepEqual(current.sections, JSON.parse(JSON.stringify(answer.sections)));
    assert.deepEqual((await store.getRevision(answer.id, 2)).sections.find((section) => section.id === "end")!.text,
      "完成評估可降低浪費及失敗風險，兼顧依法行政與公共服務品質。");
  } finally { await client.close(); }

  const reader = await connect(store, true);
  try {
    const names = (await reader.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes("preview_change") && names.includes("list_revisions"));
    assert.ok(!names.includes("edit_text") && !names.includes("restore_revision"));
  } finally { await reader.close(); }
}

test("edit_text, list_revisions and restore_revision work end to end on the file store", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-edit-"));
  try {
    const store = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
    await exerciseStore(store);
    assert.equal((await fs.readdir(path.join(root, "answers"))).length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a file-store answer saved before revisions existed can restore the version before its first edit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-legacy-"));
  try {
    const store = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
    const answer = sample();
    await store.saveAnswer(answer);
    await fs.rm(store.revisionDir, { recursive: true });
    assert.deepEqual(await store.listRevisions(answer.id, { limit: 5 }), []);
    const client = await connect(store);
    try {
      await client.callTool({ name: "edit_text", arguments: { answerId: answer.id, edits: [{ find: "前言", replace: "緒論" }], expectedVersion: 1 } });
      assert.deepEqual((await store.listRevisions(answer.id, { limit: 5 })).map((revision) => revision.version), [2, 1]);
      const restored = await client.callTool({ name: "restore_revision", arguments: { answerId: answer.id, version: 1, expectedVersion: 2 } });
      assert.equal(restored.isError, undefined, JSON.stringify(restored));
      assert.equal((await store.getAnswer(answer.id)).sections[0].heading, "一、前言");
    } finally { await client.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("edit_text, list_revisions and restore_revision work end to end on the cloud store", async () => {
  const firestore = new MemoryFirestore();
  const store = new CloudStore({
    firestore: firestore.client(), storage: new MemoryStorage().client(), environment: "staging", ownerKey: "b".repeat(64),
    artifactBucket: "synthetic-artifacts", templateDir,
  });
  await exerciseStore(store);
  assert.equal([...firestore.documents.keys()].filter((key) => key.includes("/revisions/")).length, 4);
  // Another owner cannot read the revisions.
  const other = new CloudStore({
    firestore: firestore.client(), storage: new MemoryStorage().client(), environment: "staging", ownerKey: "c".repeat(64),
    artifactBucket: "synthetic-artifacts", templateDir,
  });
  const id = [...firestore.documents.keys()].find((key) => key.includes("/revisions/"))!.split("/answers/")[1].split("/")[0];
  await assert.rejects(other.getRevision(id, 1));
  await assert.rejects(other.listRevisions(id, { limit: 5 }));
});
