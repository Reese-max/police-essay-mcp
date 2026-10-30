import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer, DEFAULT_TEMPLATE_ID } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import { CloudStore } from "../src/cloud-storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";
import { withBaseTemplateDefault } from "../scripts/check-mcp-contract.js";

const general = "police_information_essay", paper = "police_information_essay_165", legacyPaper = "police_information_essay_166";
async function withClient(run: (client: Client, store: FileStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-default-template-"));
  const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  const server = createEssayMcpServer(store), client = new Client({ name: "default-template-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b); await client.listTools();
  try { await run(client, store); }
  finally { await client.close(); await server.close(); await fs.rm(root, { recursive: true, force: true }); }
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent as any;
}
const body = [{ id: "body", text: "資料與流程須相互配合。" }];

test("contract normalization guards only the authorized template default", () => {
  const input = { tools: [{ name: "create_answer", inputSchema: { properties: { templateId: { type: "string", default: paper }, title: { type: "string" } } } }] };
  const before = structuredClone(input), normalized = withBaseTemplateDefault(input);
  assert.equal(normalized.tools[0].inputSchema.properties.templateId.default, general);
  assert.deepEqual(input, before);
  assert.deepEqual(normalized.tools[0].inputSchema.properties.title, input.tools[0].inputSchema.properties.title);
  assert.throws(() => withBaseTemplateDefault({ tools: [{ ...input.tools[0], inputSchema: { properties: { templateId: { default: general } } } }] }), /authorized template default/);
});

test("template-only load defaults to 165 and named general resource remains general", async () => withClient(async client => {
  assert.equal(DEFAULT_TEMPLATE_ID, paper);
  assert.equal((await call(client, "load_exam_paper")).template.id, paper);
  assert.equal((await call(client, "load_exam_paper", { templateId: general })).template.id, general);
  const resource = await client.readResource({ uri: "essay://templates/police_information_essay" });
  assert.equal(JSON.parse((resource.contents[0] as { text: string }).text).id, general);
  assert.equal((await call(client, "load_exam_paper", { templateId: legacyPaper })).template.id, legacyPaper);
  assert.match(client.getInstructions()!, /165 原稿紙模板/);
  assert.match(client.getInstructions()!, /police_information_essay_166 保留為相容別名/);
}));

test("165 changes only template identity; the 166 compatibility template keeps every rendering setting", async () => {
  const store = new FileStore();
  const current = await store.getTemplate(paper), legacy = await store.getTemplate(legacyPaper);
  assert.equal(current.name, "165 原稿紙・兩頁申論");
  assert.equal(legacy.name, "165 原稿紙・兩頁申論");
  assert.deepEqual(current, { ...legacy, id: paper, name: current.name });
  assert.equal(current.paperProfile, "original_166", "the internal rendering profile must remain unchanged");
  const templates = await store.listTemplates();
  assert.deepEqual(templates.map(t => t.id), [general, paper, legacyPaper]);
});

test("both file and cloud template lists display 165 for canonical and legacy IDs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-template-names-"));
  try {
    const stores = [new FileStore({ answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") }),
      new CloudStore({ firestore: new MemoryFirestore().client(), storage: new MemoryStorage().client(), environment: "staging",
        ownerKey: "a".repeat(64), artifactBucket: "synthetic-artifacts", templateDir: path.resolve("templates") })];
    for (const store of stores) {
      const templates = await store.listTemplates();
      for (const id of [paper, legacyPaper]) {
        assert.equal(templates.find(t => t.id === id)?.name, "165 原稿紙・兩頁申論");
        assert.equal((await store.getTemplate(id)).name, "165 原稿紙・兩頁申論");
      }
      assert.equal(templates.find(t => t.id === general)?.name, (await store.getTemplate(general)).name);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("MCP names, load messages, defaults, tool descriptions and workflow identify 165 through both IDs", async () => withClient(async (client, store) => {
  const listed = await call(client, "list_templates");
  for (const id of [paper, legacyPaper]) {
    assert.equal(listed.templates.find((t: { id: string }) => t.id === id).name, "165 原稿紙・兩頁申論");
    const loaded = await client.callTool({ name: "load_exam_paper", arguments: { templateId: id } });
    assert.equal((loaded.structuredContent as any).template.name, "165 原稿紙・兩頁申論");
    assert.match(JSON.stringify(loaded.content), /已載入「165 原稿紙・兩頁申論」/);
    assert.doesNotMatch(JSON.stringify(loaded.content), /166 原稿紙/);
    const created = await call(client, "create_answer", { templateId: id, title: "使用者自訂題名", sections: [] });
    const before = await store.getAnswer(created.answer.id);
    const reopened = await call(client, "load_exam_paper", { answerId: before.id });
    assert.equal(reopened.template.name, "165 原稿紙・兩頁申論");
    assert.equal(reopened.answer.templateId, id);
    assert.equal(reopened.answer.title, "使用者自訂題名");
    assert.deepEqual(await store.getAnswer(before.id), before);
  }
  const tools = (await client.listTools()).tools;
  for (const name of ["create_answer", "load_exam_paper"]) {
    const tool = tools.find(t => t.name === name)!;
    assert.equal((tool.inputSchema.properties!.templateId as { default: string }).default, paper);
  }
  for (const tool of tools) assert.doesNotMatch(tool.description ?? "", /166/);
  assert.match(client.getInstructions()!, /165 原稿紙模板/);
  assert.doesNotMatch(client.getInstructions()!, /166 原稿紙/);
  const workflow = await client.readResource({ uri: "essay://instructions/workflow" });
  const text = (workflow.contents[0] as { text: string }).text;
  assert.match(text, /165 原稿紙模板/);
  assert.doesNotMatch(text, /166 原稿紙/);
}));

test("font errors and export failures name 165 even when invoked with the legacy ID", async () => withClient(async (client, store) => {
  const previous = process.env.ESSAY_MCP_PAPER_FONT;
  try {
    delete process.env.ESSAY_MCP_PAPER_FONT;
    for (const templateId of [paper, legacyPaper]) {
      const created = await call(client, "create_answer", { templateId, title: "名稱核對", sections: [] });
      const before = await store.getAnswer(created.answer.id);
      for (const request of [
        { name: "create_answer", arguments: { templateId, title: "缺字型", sections: body } },
        { name: "export_docx", arguments: { answerId: before.id, expectedVersion: before.version } },
        { name: "export_pdf", arguments: { answerId: before.id, expectedVersion: before.version } },
      ]) {
        const result = await client.callTool(request);
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.content), /165 原稿紙/);
        assert.doesNotMatch(JSON.stringify(result.content), /166 原稿紙/);
      }
      assert.deepEqual(await store.getAnswer(before.id), before);
    }
  } finally {
    if (previous === undefined) delete process.env.ESSAY_MCP_PAPER_FONT; else process.env.ESSAY_MCP_PAPER_FONT = previous;
  }
}));

test("empty creates use 165 without migrating saved 166 answers, revisions or idempotent requests", async () => withClient(async (client, store) => {
  // Empty sections exercise template selection and persistence without needing the optional paper font.
  const fresh = await call(client, "create_answer", { title: "新預設", sections: [] });
  assert.equal(fresh.answer.templateId, paper);
  await call(client, "create_answers", { answers: [{ title: "批次預設", sections: [] }, { title: "批次明確舊代碼", templateId: legacyPaper, sections: [] }] });
  assert.deepEqual((await store.listAnswers()).map(a => a.templateId).sort(), [paper, paper, legacyPaper].sort());
  const plan = await call(client, "start_exam", { title: "全卷預設", questions: [{ questionNo: 1 }, { questionNo: 2 }] });
  await call(client, "create_answers", { examId: plan.examId, answers: [{ title: "全卷預設一", sections: [] }, { title: "全卷明確一般", templateId: general, sections: [] }] });
  const exam = await store.getExam(plan.examId);
  assert.equal((await store.getAnswer(exam.questions[0].answerId!)).templateId, paper);
  assert.equal((await store.getAnswer(exam.questions[1].answerId!)).templateId, general);
  const args = { title: "既有166", sections: [], idempotencyKey: "old-166-retry" };
  const created = await call(client, "create_answer", { ...args, templateId: legacyPaper });
  const before = await store.getAnswer(created.answer.id);
  const filename = path.join(store.answerDir, `${before.id}.json`);
  const bytes = await fs.readFile(filename);
  const revision = await store.getRevision(before.id, before.version);
  assert.equal((await call(client, "load_exam_paper", { answerId: before.id })).template.id, legacyPaper);
  assert.equal((await call(client, "read_answer", { answerId: before.id })).answer.templateId, legacyPaper);
  assert.equal((await call(client, "reflow_answer", { answerId: before.id })).layout.templateId, legacyPaper);
  const replay = await call(client, "create_answer", args);
  assert.equal(replay.replayed, true);
  assert.equal(replay.answer.id, before.id);
  assert.equal(replay.answer.templateId, legacyPaper);
  assert.equal((await client.callTool({ name: "create_answer", arguments: { ...args, templateId: paper } })).isError, true);
  const copied = await call(client, "duplicate_answer", { answerId: before.id });
  assert.equal(copied.answer.templateId, legacyPaper);
  assert.deepEqual(await store.getAnswer(before.id), before);
  assert.deepEqual(await fs.readFile(filename), bytes, "read/replay/copy must not rewrite the saved answer");
  assert.deepEqual(await store.getRevision(before.id, before.version), revision);
}));

test("missing paper font rejects omitted-template creation and saves no answer; explicit general still works", async () => withClient(async (client, store) => {
  const prior = process.env.ESSAY_MCP_PAPER_FONT;
  try {
    delete process.env.ESSAY_MCP_PAPER_FONT;
    const result = await client.callTool({ name: "create_answer", arguments: { title: "字型不可偷換", sections: body } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result), /ESSAY_MCP_PAPER_FONT/);
    assert.equal((await store.listAnswers()).length, 0);
    const batch = await client.callTool({ name: "create_answers", arguments: { answers: [
      { templateId: general, title: "可用的一般模板", sections: body },
      { title: "缺字型的預設模板", sections: body },
    ] } });
    assert.equal(batch.isError, true);
    assert.match(JSON.stringify(batch), /ESSAY_MCP_PAPER_FONT/);
    assert.equal((await store.listAnswers()).length, 0, "batch must not partially save when its default-template validation fails");
    const created = await call(client, "create_answer", { templateId: general, title: "明確選一般", sections: body });
    assert.equal((await store.getAnswer(created.answer.id)).templateId, general);
  } finally { if (prior === undefined) delete process.env.ESSAY_MCP_PAPER_FONT; else process.env.ESSAY_MCP_PAPER_FONT = prior; }
}));

test("single, batch and exam omitted templates use 165; explicit overrides and existing answers survive", { skip: !process.env.ESSAY_MCP_PAPER_FONT }, async () => withClient(async (client, store) => {
  const first = await call(client, "create_answer", { title: "單題", sections: body });
  assert.equal((await store.getAnswer(first.answer.id)).templateId, paper);
  assert.equal((await call(client, "preview_change", { answerId: first.answer.id, operation: "replace_text", sectionId: "body", newText: "預覽保留原稿紙。" })).after.answer.templateId, paper);
  await call(client, "create_answers", { answers: [{ title: "批次一", sections: body }, { title: "批次二", templateId: general, sections: body }] });
  assert.deepEqual((await store.listAnswers()).map(a => a.templateId).sort(), [general, paper, paper].sort());
  const plan = await call(client, "start_exam", { title: "全卷", questions: [{ questionNo: 1 }, { questionNo: 2 }] });
  await call(client, "create_answers", { examId: plan.examId, answers: [{ title: "全卷一", sections: body }, { title: "全卷二", templateId: general, sections: body }] });
  const savedPlan = await store.getExam(plan.examId);
  assert.equal((await store.getAnswer(savedPlan.questions[0].answerId!)).templateId, paper);
  assert.equal((await store.getAnswer(savedPlan.questions[1].answerId!)).templateId, general);
  const old = await call(client, "create_answer", { title: "既有一般答案", templateId: general, sections: body });
  const before = await store.getAnswer(old.answer.id);
  assert.equal((await call(client, "load_exam_paper", { answerId: before.id })).template.id, general);
  assert.equal((await client.callTool({ name: "load_exam_paper", arguments: { answerId: before.id, templateId: paper } })).isError, true);
  await call(client, "preview_change", { answerId: before.id, operation: "replace_text", sectionId: "body", newText: "預覽內容。" });
  const copied = await call(client, "duplicate_answer", { answerId: before.id });
  assert.equal((await store.getAnswer(copied.answer.id)).templateId, general);
  await call(client, "export_text", { answerId: before.id });
  assert.deepEqual(await store.getAnswer(before.id), before);
  assert.equal((await call(client, "get_exam_progress", { examId: plan.examId })).delivery.status, "not_ready");
}));

test("old omitted-template idempotent retries retain saved template and still reject changed payloads", async () => withClient(async (client, store) => {
  // Old default hashes equal an explicit general request: defaults are resolved before hashing.
  const args = { title: "舊單題重試", sections: body, idempotencyKey: "old-default-single" };
  const created = await call(client, "create_answer", { ...args, templateId: general });
  const before = await store.getAnswer(created.answer.id);
  const replay = await call(client, "create_answer", args);
  assert.equal(replay.replayed, true); assert.equal(replay.answer.id, before.id);
  for (const changed of [{ ...args, title: "不同內容" }, { ...args, templateId: paper }])
    assert.equal((await client.callTool({ name: "create_answer", arguments: changed })).isError, true);
  const plan = await call(client, "start_exam", { title: "舊全卷重試", questions: [{ questionNo: 1 }] });
  const examArgs = { title: "舊全卷一", examId: plan.examId, questionNo: 1, sections: body, idempotencyKey: "old-default-exam" };
  const examCreated = await call(client, "create_answer", { ...examArgs, templateId: general });
  const examBefore = await store.getAnswer(examCreated.answer.id);
  assert.equal((await call(client, "create_answer", examArgs)).replayed, true);
  assert.equal((await client.callTool({ name: "create_answer", arguments: { ...examArgs, title: "不同全卷內容" } })).isError, true);
  assert.deepEqual(await store.getAnswer(before.id), before);
  assert.deepEqual(await store.getAnswer(examBefore.id), examBefore);
  const getAnswer = store.getAnswer.bind(store);
  store.getAnswer = async id => id === before.id ? { ...before, templateId: "missing_replay_template" } : getAnswer(id);
  const damaged = await client.callTool({ name: "create_answer", arguments: args });
  assert.equal(damaged.isError, true);
  assert.match(JSON.stringify(damaged), /TEMPLATE_NOT_FOUND/);
  assert.ok(JSON.stringify(damaged).includes(before.id), "old omitted-template retry must retain replay diagnostics");
}));
