import assert from "node:assert/strict";
import { test } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { FileStore, StoreConflictError, isStoreNotFound, type EssayStore } from "../src/storage.js";
import { CloudStore } from "../src/cloud-storage.js";
import { examPlanSchema, type ExamPlan } from "../src/domain.js";
import { createEssayMcpServer } from "../src/server.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

const templateDir = path.resolve("templates");
const exam = (): ExamPlan => ({ id: "exam_test", title: "警察特考", questions: [{ questionNo: 1 }], version: 1,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const text = (r: any) => r.content?.map((c: any) => c.text ?? "").join("\n") ?? "";
const data = (r: any): any => { assert.equal(r.isError, undefined, text(r)); return r.structuredContent; };
async function connect(store: EssayStore, options: Parameters<typeof createEssayMcpServer>[1] = {}) {
  const server = createEssayMcpServer(store, options), client = new Client({ name: "exam-progress-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b); await client.listTools();
  return { client, close: async () => { await client.close(); await server.close(); } };
}
async function fixture(cloud: boolean, run: (store: EssayStore, other: EssayStore, reader: EssayStore) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "essay-progress-"));
  const firestore = new MemoryFirestore(), storage = new MemoryStorage();
  const make = (owner: string, readOnly = false) => new CloudStore({ firestore: firestore.client(), storage: storage.client(),
    environment: "staging", ownerKey: owner.repeat(64), artifactBucket: "test", templateDir, readOnly });
  const file = new FileStore({ templateDir, answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  try { await run(cloud ? make("a") : file, cloud ? make("b") : file, cloud ? make("a", true) : file); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
// These progress/rollback fixtures exercise the general template, independent of private paper fonts.
const draft = (examId: string, questionNo: number, lines = 1) => ({ templateId: "police_information_essay", examId, questionNo, title: `第${questionNo}題`,
  sections: [{ id: "body", text: Array.from({ length: lines }, () => "論述。").join("\n") }] });

for (const cloud of [false, true]) {
  test(`${cloud ? "CloudStore" : "FileStore"} plan CRUD, validation, size and CAS; scope mirrors answers`, async () => fixture(cloud, async (store, other, reader) => {
    const plan = exam(); await store.saveExam(plan);
    assert.deepEqual(await store.getExam(plan.id), plan); assert.equal((await store.listExams()).length, 1);
    await assert.rejects(store.saveExam(plan), /已存在/);
    const results = await Promise.allSettled(["A", "B"].map(title => store.saveExam({ ...plan, title }, { expectedVersion: 1 })));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
    assert.match(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason), /Version conflict/);
    assert.equal((await store.getExam(plan.id)).version, 2);
    await assert.rejects(store.deleteExam(plan.id, { expectedVersion: 1 }), /Version conflict/);
    const invalid = [ { ...plan, questions: [] }, { ...plan, title: "x".repeat(101) },
      { ...plan, questions: [{ questionNo: 1 }, { questionNo: 1 }] },
      { ...plan, questions: [{ questionNo: 21 }] }, { ...plan, questions: [{ questionNo: 1, targetPages: 0 }] },
      { ...plan, questions: [{ questionNo: 1, question: "x".repeat(10_001) }] },
      { ...plan, questions: Array.from({ length: 20 }, (_, i) => ({ questionNo: i + 1, question: "國".repeat(10_000) })) } ];
    for (const value of invalid) await assert.rejects(store.saveExam(value as ExamPlan));
    assert.equal((await store.listExams()).length, 1);
    if (cloud) {
      assert.equal((await other.listExams()).length, 0); await assert.rejects(other.getExam(plan.id), isStoreNotFound);
      await assert.rejects(other.deleteExam(plan.id, { expectedVersion: 2 }), isStoreNotFound);
      assert.equal((await reader.getExam(plan.id)).version, 2);
      await assert.rejects(reader.saveExam(plan, { expectedVersion: 2 }), /cannot write/);
      await assert.rejects(reader.deleteExam(plan.id, { expectedVersion: 2 }), /cannot write/);
    } else assert.deepEqual(await other.getExam(plan.id), await store.getExam(plan.id));
    await store.deleteExam(plan.id, { expectedVersion: 2 }); await assert.rejects(store.getExam(plan.id), isStoreNotFound);
    assert.deepEqual(await store.listExams(), []);
  }));

  test(`${cloud ? "cloud" : "file"} start replay, key misuse, resume deduplication and deletion unlink`, async () => fixture(cloud, async store => {
    const h = await connect(store); const c = h.client;
    try {
      const input = { title: "警察特考", questions: [{ questionNo: 2, question: "第二題" }, { questionNo: 1, question: "第一題" }], formats: ["pdf"], idempotencyKey: "exam-key-123" };
      const id = data(await call(c, "start_exam", input)).examId;
      assert.equal(data(await call(c, "start_exam", input)).examId, id);
      assert.equal(data(await call(c, "start_exam", input)).replayed, true); assert.equal((await store.listExams()).length, 1);
      const bad = await call(c, "start_exam", { ...input, title: "不同" }); assert.equal(bad.isError, true); assert.match(text(bad), /IDEMPOTENCY_KEY_REUSED/);
      for (const questions of [[], [{ questionNo: 1 }, { questionNo: 1 }]]) assert.equal((await call(c, "start_exam", { title: "錯誤", questions })).isError, true);
      const args = { ...draft(id, 1), idempotencyKey: "answer-key-123" };
      const first = data(await call(c, "create_answer", args));
      const same = data(await call(c, "create_answer", args)); assert.equal(same.replayed, true); assert.equal(same.answer.id, first.answer.id);
      const changed = await call(c, "create_answer", { ...args, title: "不同請求" }); assert.equal(changed.isError, true); assert.match(text(changed), /IDEMPOTENCY_KEY_REUSED/);
      const existing = data(await call(c, "create_answer", { ...draft(id, 1), title: "重啟後的不同文字" })); assert.equal(existing.replayed, true);
      const batch = data(await call(c, "create_answers", { answers: [draft(id, 1), draft(id, 2)] }));
      assert.equal(batch.answers[0].replayed, true); assert.equal((await store.listAnswers()).length, 2);
      data(await call(c, "create_answers", { answers: [draft(id, 1), draft(id, 2)] })); assert.equal((await store.listAnswers()).length, 2);
      const plan = await store.getExam(id); assert.ok(plan.questions.every(q => q.answerId));
      const saved = await store.getAnswer(first.answer.id); assert.equal(saved.exam, input.title); assert.equal(saved.question, "第一題");
      data(await call(c, "export_exam_bundle", { examId: id })); assert.ok((await store.getExam(id)).lastBundle);
      data(await call(c, "delete_answer", { answerId: saved.id, expectedVersion: saved.version }));
      assert.equal((await store.getExam(id)).questions.find(q => q.questionNo === 1)?.answerId, undefined);
      assert.equal((await store.getExam(id)).lastBundle, undefined, "deleted artifacts must not mark a recreated version-1 answer exported");
      const progress = data(await call(c, "get_exam_progress", { examId: id })); assert.equal(progress.nextStep.questionNo, 1);
      assert.equal(data(await call(c, "create_answer", draft(id, 1))).answer.id, saved.id);
      assert.equal(data(await call(c, "get_exam_progress", { examId: id })).questions[0].stage, "layout_ok");
    } finally { await h.close(); }
  }));

  test(`${cloud ? "cloud" : "file"} real stages, bundle pinning, progress and failure rollback`, async () => fixture(cloud, async store => {
    const h = await connect(store); const c = h.client;
    try {
      const id = data(await call(c, "start_exam", { title: "四題試卷", questions: [{ questionNo: 2 }, { questionNo: 1 }], formats: ["pdf"] })).examId;
      const progress = async () => {
        const r = await call(c, "get_exam_progress", { examId: id }); assert.doesNotMatch(JSON.stringify(r), /[%％]/);
        const p = data(r); assert.equal(text(r), p.summary);
        assert.ok(["create_answer", "fix_layout", "export_exam_bundle", "done"].includes(p.nextStep.action), "preserve the published action enum for legacy clients");
        return p;
      };
      assert.deepEqual((await progress()).questions.map((q: any) => q.stage), ["not_started", "not_started"]);
      assert.deepEqual((await progress()).delivery, { status: "not_ready", checks: {
        layoutCapacity: "pending", content: "not_checked", source: "not_checked", visual: "not_checked" } });
      assert.equal((await progress()).nextStep.action, "create_answer"); assert.match((await progress()).summary, /第1題尚未建立/);
      const one = data(await call(c, "create_answer", draft(id, 1, 45))).answer.id;
      assert.equal((await progress()).questions[0].stage, "drafted");
      const missing = await call(c, "export_exam_bundle", { examId: id }); assert.equal(missing.isError, true);
      assert.equal((missing.structuredContent as any).errors[0].questionNo, 2); assert.equal((await store.getExam(id)).lastBundle, undefined);
      const overview = data(await call(c, "render_exam_overview", { examId: id, responseDetail: "full" }));
      assert.deepEqual(overview.examAnswers.map((q: any) => q.questionNo), [1, 2]); assert.equal(overview.examAnswers[1].title, "未建立");
      assert.equal(overview.progress.nextStep.action, "create_answer");
      data(await call(c, "create_answer", draft(id, 2))); assert.equal((await progress()).nextStep.action, "fix_layout");
      data(await call(c, "replace_text", { answerId: one, sectionId: "body", newText: "完成論述。", expectedVersion: 1 }));
      assert.equal((await progress()).nextStep.action, "export_exam_bundle"); assert.match((await progress()).summary, /版面皆通過；尚未匯出/);
      assert.equal((await progress()).delivery.status, "not_ready");
      assert.equal((await progress()).delivery.checks.layoutCapacity, "passed");
      const create = store.createExportHandle.bind(store); store.createExportHandle = async () => { throw new Error("renderer unavailable"); };
      assert.equal((await call(c, "export_exam_bundle", { examId: id })).isError, true); assert.equal((await store.getExam(id)).lastBundle, undefined);
      store.createExportHandle = create;
      const notices: any[] = []; c.setNotificationHandler(ProgressNotificationSchema, n => { notices.push(n.params); });
      data(await call(c, "export_exam_bundle", { examId: id })); assert.equal(notices.length, 0);
      const notify = notices;
      const bundle = data(await c.callTool({ name: "export_exam_bundle", arguments: { examId: id, formats: ["pdf", "docx"] }, _meta: { progressToken: "exam-test" } }));
      assert.equal(bundle.answers.length, 2); assert.deepEqual(bundle.answers.map((a: any) => a.answerId), (await progress()).questions.map((q: any) => q.answerId));
      assert.equal(notify.length, 8); assert.deepEqual(notify.map(p => p.progress), [1,2,3,4,5,6,7,8]); assert.equal(notify.at(-1).total, 8);
      const plan = await store.getExam(id); assert.equal(plan.lastBundle?.members[0].version, 2);
      const exported = await progress();
      assert.equal(exported.bundle.status, "current"); assert.equal(exported.nextStep.action, "done", "done remains the export workflow terminal action, not an approval");
      assert.match(exported.summary, /合輯已匯出：4 頁 PDF 與 Word.*內容、來源與逐頁視覺驗收尚未完成/);
      assert.doesNotMatch(exported.summary, /成品已完成/);
      assert.deepEqual(exported.delivery, { status: "awaiting_review", checks: {
        layoutCapacity: "passed", content: "not_checked", source: "not_checked", visual: "not_checked" } });
      const review = data(await call(c, "render_exam_overview", { examId: id, responseDetail: "full" }));
      assert.deepEqual(review.progress.delivery, exported.delivery);
      assert.equal(review.progress.nextStep.action, "done");
      assert.equal(review.progress.summary, exported.summary);
      assert.deepEqual((await store.getExam(id)).lastBundle, plan.lastBundle, "reading progress must not record an approval");
      data(await call(c, "replace_text", { answerId: one, sectionId: "body", newText: "修訂論述。", expectedVersion: 2 }));
      const outdated = await progress(); assert.equal(outdated.bundle.status, "outdated"); assert.equal(outdated.questions[0].stage, "layout_ok");
      assert.equal(outdated.questions[1].stage, "exported"); assert.equal(outdated.nextStep.action, "export_exam_bundle"); assert.match(outdated.summary, /合輯已過期/);
      assert.deepEqual(outdated.delivery, { status: "not_ready", checks: {
        layoutCapacity: "passed", content: "not_checked", source: "not_checked", visual: "not_checked" } });
    } finally { await h.close(); }
  }));
}

for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} implicit question replay, batch defaults and racing creates`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    const id = data(await call(h.client, "start_exam", { title: "續寫", questions: [{ questionNo: 3 }, { questionNo: 1 }, { questionNo: 2 }] })).examId;
    const implicit = { templateId: "police_information_essay", examId: id, title: "第一題", idempotencyKey: "implicit-key-01" };
    const first = data(await call(h.client, "create_answer", implicit)); assert.equal(first.answer.questionNo, 1);
    assert.equal(data(await call(h.client, "create_answer", implicit)).answer.id, first.answer.id);
    assert.equal((await store.listAnswers()).length, 1);
    const batch = { examId: id, answers: [{ templateId: "police_information_essay", title: "第二題", idempotencyKey: "implicit-key-02" }, { templateId: "police_information_essay", title: "第三題", idempotencyKey: "implicit-key-03" }] };
    const created = data(await call(h.client, "create_answers", batch)); assert.deepEqual(created.answers.map((a: any) => a.questionNo), [2, 3]);
    const replay = data(await call(h.client, "create_answers", batch)); assert.ok(replay.answers.every((a: any) => a.replayed));
    assert.equal((await store.listAnswers()).length, 3);
    const racedId = data(await call(h.client, "start_exam", { title: "併發", questions: [{ questionNo: 1 }] })).examId;
    const raced = await Promise.all([call(h.client, "create_answer", draft(racedId, 1)), call(h.client, "create_answer", draft(racedId, 1))]);
    assert.equal(data(raced[0]).answer.id, data(raced[1]).answer.id); assert.equal((await store.listAnswers()).length, 4);
  } finally { await h.close(); }
}));
for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} plan save failure rolls back bundle handles and emits no completion`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    const id = data(await call(h.client, "start_exam", { title: "儲存失敗", questions: [{ questionNo: 1 }], formats: ["pdf"] })).examId;
    data(await call(h.client, "create_answer", draft(id, 1)));
    const save = store.saveExam.bind(store); store.saveExam = async (plan, options) => { if (plan.lastBundle) throw new Error("plan save failed"); return save(plan, options); };
    const notices: any[] = []; h.client.setNotificationHandler(ProgressNotificationSchema, n => { notices.push(n.params); });
    const removed: string[] = [], remove = store.deleteExport.bind(store);
    store.deleteExport = async handle => { removed.push(handle); await remove(handle); };
    const failed = await h.client.callTool({ name: "export_exam_bundle", arguments: { examId: id }, _meta: { progressToken: 0 } });
    assert.equal(failed.isError, true); assert.equal((await store.getExam(id)).lastBundle, undefined); assert.equal(removed.length, 1);
    assert.deepEqual(notices.map(p => p.progress), [1, 2, 3]); assert.equal(notices.at(-1).total, 4);
    assert.ok(notices.every(p => p.progress < p.total));
  } finally { await h.close(); }
}));

for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} concurrent key misuse across plans creates only one answer`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    const ids = [];
    for (const title of ["A", "B"]) ids.push(data(await call(h.client, "start_exam", { title, questions: [{ questionNo: 1 }] })).examId);
    const results = await Promise.all(ids.map(id => call(h.client, "create_answer", { ...draft(id, 1), idempotencyKey: "shared-racing-key" })));
    assert.equal(results.filter(r => !r.isError).length, 1); assert.match(text(results.find(r => r.isError)), /IDEMPOTENCY_KEY_REUSED/);
    assert.equal((await store.listAnswers()).length, 1);
    const winner = results.findIndex(r => !r.isError), loser = 1 - winner;
    const plan = await store.getExam(ids[winner]); await store.deleteExam(plan.id, { expectedVersion: plan.version });
    data(await call(h.client, "create_answer", { ...draft(ids[loser], 1), idempotencyKey: "shared-racing-key" }));
    assert.equal((await store.listAnswers()).length, 2, "deleting a plan releases its create-key reservation");
  } finally { await h.close(); }
}));

test("read-only and OAuth scope surfaces allow progress and deny plan creation", async () => fixture(false, async store => {
  await store.saveExam(exam());
  for (const options of [{ readOnly: true }, { scopes: ["essay.read"] }, { scopes: ["essay.read", "essay.export"] }, { scopes: ["essay.read", "essay.write"] }]) {
    const h = await connect(store, options);
    try {
      const tools = (await h.client.listTools()).tools; const progress = tools.find(t => t.name === "get_exam_progress")!;
      assert.equal(progress.annotations?.readOnlyHint, true);
      assert.deepEqual((progress._meta?.ui as any)?.visibility, ["model", "app"]);
      assert.equal(Boolean(tools.find(t => t.name === "start_exam")), options.scopes?.includes("essay.write") ?? false);
      if (options.scopes) assert.deepEqual(progress._meta?.securitySchemes, [{ type: "oauth2", scopes: ["essay.read"] }]);
      data(await call(h.client, "get_exam_progress", { examId: exam().id }));
      const overview = data(await call(h.client, "render_exam_overview", { examId: exam().id, responseDetail: "full" })); assert.equal(overview.examAnswers[0].title, "未建立");
      if (!options.scopes?.includes("essay.write")) assert.equal((await call(h.client, "start_exam", { title: "denied", questions: [{ questionNo: 1 }] })).isError, true);
    } finally { await h.close(); }
  }
}));


for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} invalid legacy layouts stay per-question and overview remains usable`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    const id = data(await call(h.client, "start_exam", { title: "舊版面", questions: [{ questionNo: 1 }, { questionNo: 2 }] })).examId;
    const first = data(await call(h.client, "create_answer", draft(id, 1))).answer.id;
    data(await call(h.client, "create_answer", draft(id, 2)));
    const get = store.getAnswer.bind(store), template = store.getTemplate.bind(store);
    for (const failure of ["layout", "template"]) {
      store.getAnswer = async answerId => {
        const answer = await get(answerId);
        return answerId === first ? { ...answer, ...(failure === "template" ? { templateId: "broken" }
          : { sections: answer.sections.map(s => ({ ...s, paragraphFormat: { leftIndent: 100 } })) }) } : answer;
      };
      store.getTemplate = async templateId => {
        if (templateId === "broken") throw new Error("Cannot read 'C:\\private\\paper.json'\n at internal (/private/source.ts:1)");
        return template(templateId);
      };
      const progress = data(await call(h.client, "get_exam_progress", { examId: id }));
      assert.deepEqual(progress.questions.map((q: any) => q.stage), ["drafted", "layout_ok"]);
      assert.equal(progress.nextStep.action, "fix_layout"); assert.equal(progress.nextStep.questionNo, 1);
      assert.equal(progress.delivery.status, "not_ready"); assert.equal(progress.delivery.checks.layoutCapacity, "pending");
      assert.ok(progress.questions[0].error); assert.doesNotMatch(progress.questions[0].error, /private|internal/);
      const overview = data(await call(h.client, "render_exam_overview", { examId: id, responseDetail: "full" }));
      assert.equal(overview.examAnswers.length, 2); assert.equal(overview.progress.questions[0].error, progress.questions[0].error);
      assert.equal(overview.answer.questionNo, 2);
    }
  } finally { await h.close(); }
}));

for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} default bundle files, plan formats and recorded page counts`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    const id = data(await call(h.client, "start_exam", { title: "預設格式", questions: [{ questionNo: 1 }] })).examId;
    assert.deepEqual((await store.getExam(id)).formats, ["pdf", "docx"]);
    data(await call(h.client, "create_answer", { ...draft(id, 1), templateId: "police_information_essay" }));
    const result = data(await call(h.client, "export_exam_bundle", { examId: id }));
    assert.deepEqual(result.files.map((f: any) => f.format), ["pdf", "docx"]);
    assert.deepEqual((await store.getExam(id)).lastBundle?.pages, { pdf: 2, docx: 2 });
    const template = store.getTemplate.bind(store);
    store.getTemplate = async id => ({ ...await template(id), pages: 4 });
    const progress = data(await call(h.client, "get_exam_progress", { examId: id }));
    assert.match(progress.summary, /合輯已匯出：2 頁 PDF 與 Word/);
    assert.deepEqual(progress.bundle.pages, { pdf: 2, docx: 2 });
    store.getTemplate = template;
    const plan = await store.getExam(id); await store.saveExam({ ...plan, formats: ["docx"] }, { expectedVersion: plan.version });
    const word = data(await call(h.client, "export_exam_bundle", { examId: id }));
    assert.deepEqual(word.files.map((f: any) => f.format), ["docx"]);
    const wordPlan = await store.getExam(id);
    await store.saveExam({ ...wordPlan, formats: ["pdf", "docx"] }, { expectedVersion: wordPlan.version });
    const missingFormat = data(await call(h.client, "get_exam_progress", { examId: id }));
    assert.equal(missingFormat.bundle.status, "outdated"); assert.equal(missingFormat.delivery.status, "not_ready");
    assert.equal(missingFormat.nextStep.action, "export_exam_bundle");
    assert.equal((await call(h.client, "export_exam_bundle", { examId: id, formats: ["txt"] })).isError, true);
    assert.equal((await call(h.client, "start_exam", { title: "TXT拒絕", questions: [{ questionNo: 1 }], formats: ["txt"] })).isError, true);
  } finally { await h.close(); }
}));

for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} export with layout warnings still awaits delivery review`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    const id = data(await call(h.client, "start_exam", { title: "待驗收", questions: [{ questionNo: 1 }], formats: ["docx"] })).examId;
    data(await call(h.client, "create_answer", { ...draft(id, 1), layoutOptions: { keepHeadingWithNext: false }, sections: [
      { id: "padding", text: Array.from({ length: 21 }, () => "論述。").join("\n") },
      { id: "orphan", heading: "標題", text: "正文。" },
    ] }));
    const result = data(await call(h.client, "export_exam_bundle", { examId: id }));
    assert.ok(result.answers[0].warnings.some((w: any) => w.code === "ORPHAN_HEADING"));
    const progress = data(await call(h.client, "get_exam_progress", { examId: id }));
    assert.equal(progress.questions[0].warningCount, 1);
    assert.equal(progress.bundle.status, "current");
    assert.equal(progress.delivery.checks.layoutCapacity, "passed");
    assert.equal(progress.delivery.status, "awaiting_review");
    assert.equal(progress.delivery.checks.visual, "not_checked");
    assert.equal(progress.nextStep.action, "done");
    assert.match(progress.summary, /Word.*容量檢查通過/);
    assert.doesNotMatch(progress.summary, /成品已完成|版面檢查通過/);
  } finally { await h.close(); }
}));

for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} saved answers survive exhausted linking conflicts and retries self-heal`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    for (const batch of [false, true]) {
      const id = data(await call(h.client, "start_exam", { title: "連結重試", questions: [{ questionNo: 1 }] })).examId;
      const save = store.saveExam.bind(store); let attempts = 0;
      store.saveExam = async (plan, options) => {
        if (plan.questions.some(q => q.answerId)) { attempts++; throw new StoreConflictError("opaque conflict with no version wording"); }
        return save(plan, options);
      };
      const name = batch ? "create_answers" : "create_answer", input = batch ? { answers: [draft(id, 1)] } : draft(id, 1);
      const result = data(await call(h.client, name, input));
      const saved = batch ? result.answers[0] : result;
      assert.equal(saved.linkPending, true); assert.match(saved.message, /get_exam_progress.*重試/); assert.equal(attempts, 5);
      const answerId = batch ? saved.answerId : saved.answer.id;
      assert.equal((await store.getAnswer(answerId)).version, 1);
      assert.equal((await store.getExam(id)).questions[0].answerId, undefined);
      store.saveExam = save;
      data(await call(h.client, name, input)); assert.equal((await store.getExam(id)).questions[0].answerId, answerId);
    }
  } finally { await h.close(); }
}));

for (const cloud of [false, true]) test(`${cloud ? "cloud" : "file"} lastBundle retries plan CAS but rejects changed members or versions`, async () => fixture(cloud, async store => {
  const h = await connect(store);
  try {
    for (const change of ["reservation", "version", "member"]) {
      const id = data(await call(h.client, "start_exam", { title: change, questions: [{ questionNo: 1 }], formats: ["docx"] })).examId;
      const answerId = data(await call(h.client, "create_answer", draft(id, 1))).answer.id;
      const save = store.saveExam.bind(store); let attempts = 0;
      store.saveExam = async (plan, options) => {
        if (plan.lastBundle && ++attempts === 1) {
          const latest = await store.getExam(id);
          if (change === "version") {
            const answer = await store.getAnswer(answerId);
            await store.saveAnswer({ ...answer, version: answer.version + 1 }, { expectedVersion: answer.version });
          } else await save({ ...latest, title: "保留併發更新", ...(change === "member" ? { questions: [{ questionNo: 1 }] } : {}) }, { expectedVersion: latest.version });
          throw new StoreConflictError("opaque CAS");
        }
        return save(plan, options);
      };
      const handles: string[] = [], create = store.createExportHandle.bind(store);
      store.createExportHandle = async (...args) => { const a = await create(...args); handles.push(a.handle); return a; };
      const result = await call(h.client, "export_exam_bundle", { examId: id });
      if (change === "reservation") {
        data(result); assert.equal(attempts, 2); assert.equal((await store.getExam(id)).title, "保留併發更新");
      } else {
        assert.equal(result.isError, true); assert.equal((result.structuredContent as any).errors[0].code, "VERSION_CONFLICT");
        for (const handle of handles) await assert.rejects(store.readExport(handle), isStoreNotFound);
        assert.equal((await store.getExam(id)).lastBundle, undefined);
      }
      store.saveExam = save; store.createExportHandle = create;
    }
  } finally { await h.close(); }
}));

test("FileStore deletion retries unlink before touching history and skips corrupt plans", async () => fixture(false, async store => {
  const file = store as FileStore, h = await connect(store);
  try {
    const id = data(await call(h.client, "start_exam", { title: "刪除", questions: [{ questionNo: 1 }] })).examId;
    const answerId = data(await call(h.client, "create_answer", draft(id, 1))).answer.id;
    await fs.writeFile(path.join(`${file.answerDir}-exams`, "exam_corrupt.json"), "{bad json");
    const save = store.saveExam.bind(store); let attempts = 0;
    store.saveExam = async (plan, options) => {
      await store.getRevision(answerId, 1); // A failed unlink must preserve saved revisions.
      if (++attempts === 1) throw new StoreConflictError("opaque CAS");
      return save(plan, options);
    };
    await store.deleteAnswer(answerId, { expectedVersion: 1 }); assert.equal(attempts, 2);
    assert.equal((await store.getExam(id)).questions[0].answerId, undefined);
    await assert.rejects(store.getAnswer(answerId), isStoreNotFound);
    await assert.rejects(store.getRevision(answerId, 1), isStoreNotFound);
    assert.equal(await fs.readFile(path.join(`${file.answerDir}-exams`, "exam_corrupt.json"), "utf8"), "{bad json");
  } finally { await h.close(); }
}));

test("cross-owner exam IDs are indistinguishable from unknown IDs for all exam entry points", async () => fixture(true, async (store, other) => {
  await store.saveExam(exam()); const h = await connect(other);
  try {
    for (const name of ["create_answer", "create_answers", "export_exam_bundle", "render_exam_overview", "get_exam_progress"]) {
      const args = (id: string) => name === "create_answer" ? draft(id, 1)
        : name === "create_answers" ? { examId: id, answers: [{ title: "draft" }] } : { examId: id };
      const foreign = await call(h.client, name, args(exam().id)), unknown = await call(h.client, name, args("exam_unknown"));
      assert.equal(foreign.isError, true, name); assert.equal(unknown.isError, true, name);
      assert.deepEqual(foreign, unknown, name); assert.doesNotMatch(text(foreign), /警察特考/);
    }
    assert.equal((await other.listAnswers()).length, 0);
  } finally { await h.close(); }
}));


test("CloudStore skips corrupt plans in listing and transactional answer deletion", async () => {
  const firestore = new MemoryFirestore(), storage = new MemoryStorage();
  const store = new CloudStore({ firestore: firestore.client(), storage: storage.client(), environment: "staging",
    ownerKey: "a".repeat(64), artifactBucket: "test", templateDir });
  const h = await connect(store);
  try {
    const id = data(await call(h.client, "start_exam", { title: "刪除", questions: [{ questionNo: 1 }] })).examId;
    const answerId = data(await call(h.client, "create_answer", draft(id, 1))).answer.id;
    const entry = [...firestore.documents.entries()].find(([key]) => key.endsWith(`/exams/${id}`))!;
    const corruptPath = entry[0].replace(id, "exam_corrupt");
    firestore.documents.set(corruptPath, { revision: 1, value: { ...entry[1].value, questions: "corrupt" } });
    assert.deepEqual((await store.listExams()).map(p => p.id), [id]);
    await store.deleteAnswer(answerId, { expectedVersion: 1 });
    assert.equal((await store.getExam(id)).questions[0].answerId, undefined);
    await assert.rejects(store.getAnswer(answerId), isStoreNotFound);
    await assert.rejects(store.getRevision(answerId, 1), isStoreNotFound);
    assert.equal(firestore.documents.get(corruptPath)?.value.questions, "corrupt");
  } finally { await h.close(); }
});
