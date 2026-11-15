import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileStore } from "../src/storage.js";
import { createEssayMcpServer } from "../src/server.js";
import { LAW_TEXTS } from "../src/law-references-data.js";
import { lawReferencesFor } from "../src/law-references.js";

const names = (questions: string[]) => lawReferencesFor(questions)?.laws.map(law => law.name) ?? [];

test("every bundled law is reachable by its own name and carries labelled, non-empty articles", () => {
  for (const law of LAW_TEXTS) {
    assert.ok(names([`依${law.name}說明`]).includes(law.name), law.name);
    assert.ok(law.articles.length > 0 && law.articles.every(a => a.text.trim()), law.name);
  }
  const ccp = lawReferencesFor(["說明搜索票之聲請程序"])!.laws[0];
  assert.deepEqual(ccp.articles.map(a => a.article), ["第122條", "第128條", "第128條之1", "第128條之2", "第130條", "第131條", "第131條之1", "第133條", "第137條", "第152條"]);
  assert.match(ccp.articles[2].text, /^偵查中檢察官認有搜索之必要者[\s\S]*司法警察官因調查犯罪嫌疑人犯罪情形及蒐集證據/);
});

test("law references attach only to questions that name their subject", () => {
  assert.deepEqual(names(["（一）依刑事訴訟法說明搜索票應記載事項及聲請程序（11分）。（二）說明電腦搜索之執行要領（14分）。"]), ["刑事訴訟法"]);
  assert.deepEqual(names(["請問114年新修正之資通安全管理法，修正之內容重點為何？（25分）"]), ["資通安全管理法"]);
  assert.deepEqual(names(["告警未即時成為事件通報：夜間值班表未列資訊事件聯絡窗口"]), ["資通安全管理法", "資通安全事件通報應變及演練辦法"]);
  assert.deepEqual(names(["（三）演算法偏誤、個人資料保護及決策責任與因應措施（5分）？"]), ["個人資料保護法"]);
  assert.deepEqual(names(["針對個資或機敏資料外洩提出管理措施"]), ["個人資料保護法"]);
  assert.deepEqual(names(["說明數位證據搜扣程序"]), ["刑事訴訟法"]);
  assert.deepEqual(names(["比較深度優先搜索與廣度優先搜索，並依刑事訴訟法說明電腦搜索"]), ["刑事訴訟法"]); // algorithm words removed, legal ones kept
  for (const unrelated of ["何謂零信任（Zero Trust）概念？", "試簡述RFI、RFP、RFQ、RFC", "警方與交通機關試辦道路障礙通報介接，同一通報重送兩次",
    "說明搜索引擎最佳化之原理", "說明資訊安全管理措施", "比較深度優先搜索與廣度優先搜索", "說明啟發式搜索演算法",
    "說明ITIL事件管理之事件通報流程"]) assert.equal(lawReferencesFor([unrelated]), undefined, unrelated);
  assert.equal(lawReferencesFor([undefined, ""]), undefined);
});

test("start_exam and standalone create_answer hand the verbatim articles to the assistant once", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-law-"));
  const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store), client = new Client({ name: "law-references-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const text = r.content.map((c: any) => c.text ?? "").join("\n");
    assert.equal(r.isError, undefined, text);
    return { data: r.structuredContent, text };
  };
  try {
    const law = await call("start_exam", { title: "刑訴", questions: [{ questionNo: 1, question: "依刑事訴訟法說明搜索票之聲請程序。（25分）" }] });
    assert.deepEqual(law.data.lawReferences.laws.map((l: any) => l.name), ["刑事訴訟法"]);
    assert.match(law.text, /已附刑事訴訟法（民國\d+年\d+月\d+日修正）相關條文原文 10 條（lawReferences，全國法規資料庫/);
    assert.match(law.text, /題目要求的其他法規照常作答，條號沒把握時只寫法規名稱與要件，不捏造條號/);

    // Resuming skips start_exam: progress carries references only for questions not yet written.
    const resumed = await call("get_exam_progress", { examId: law.data.examId });
    assert.deepEqual(resumed.data.lawReferences.laws.map((l: any) => l.name), ["刑事訴訟法"]);
    assert.match(resumed.text, /已附刑事訴訟法/);

    const plain = await call("start_exam", { title: "資管", questions: [{ questionNo: 1, question: "何謂零信任？（25分）" }] });
    assert.equal(plain.data.lawReferences, undefined);
    assert.doesNotMatch(plain.text, /lawReferences/);

    const sections = [{ id: "body", text: "論述。" }];
    const standalone = await call("create_answer", { templateId: "police_information_essay", title: "個資", question: "說明個人資料外洩之通知義務。", sections });
    assert.deepEqual(standalone.data.lawReferences.laws.map((l: any) => l.name), ["個人資料保護法"]);
    assert.match(standalone.text, /已附個人資料保護法/);

    const inExam = await call("create_answer", { templateId: "police_information_essay", title: "刑訴", examId: law.data.examId, questionNo: 1,
      question: "依刑事訴訟法說明搜索票之聲請程序。（25分）", sections });
    assert.equal(inExam.data.lawReferences, undefined);
    assert.doesNotMatch(inExam.text, /lawReferences/);
    const written = await call("get_exam_progress", { examId: law.data.examId });
    assert.equal(written.data.lawReferences, undefined);
  } finally {
    await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true });
  }
});
