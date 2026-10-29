import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";
import { layoutSections } from "../src/layout.js";
import { layoutWarnings } from "../src/planning.js";
import { gridMetrics } from "../src/metrics.js";

// No API calls or formal answers: this harness uses MCP in-memory transport and its own FileStore.
const runName = process.argv[2] ?? "after";
assert.match(runName, /^[a-z0-9-]+$/);
const output = path.resolve("output/pdf", `quality-${runName}`);
const root = path.resolve("tmp/pdfs", `quality-${runName}`);
await fs.mkdir(output, { recursive: true });
const store = new FileStore({ templateDir: path.resolve("templates"), answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
const server = createEssayMcpServer(store);
const client = new Client({ name: "synthetic-quality-e2e", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a); await client.connect(b);
const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent as any;
};
const notice = "【合成測試／非正式擬答】";
const templateId = "police_information_essay";
const chineseRun = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉戌";
const terms = ["資料保全", "完整性驗證", "存取控制", "稽核軌跡", "最小權限"];
const inputs = [
  { title: "合成一：長標題與層級", sections: [
    { id: "notice", heading: notice, text: "以下均為程式測試文字，不是考試正式答案。" },
    { id: "long-heading", heading: "壹、長標題檢驗：資訊作業流程應完整保留題目要求與來源脈絡，並確認跨行標題與第一段內文的銜接情形", text: "長標題正文起點：逐項核對，不以匯出成功代替查證。" },
    { id: "hierarchy", heading: "貳、分層編號檢驗", text: "一、第一層：保存原始脈絡。\n（一）第二層：核對段落。\n1. 第三層：建立可追溯記錄。\n(1) 第四層：記下頁碼與版本。" },
    { id: "mixed", heading: "參、中英混排與滿欄字元", text: "證據 SHA256 hash、API request 與 TCP/IP 必須完整保留。\n" + "m".repeat(42) + "\n" + "W".repeat(42) + "\n" + "@".repeat(42) + "\n前段\u2028後段\u2029末段\nQ1-END" },
  ] },
  { title: "合成二：跨頁長標題", sections: [
    { id: "lead", text: [notice, ...Array.from({ length: 19 }, (_, i) => `前置第${String(i + 1).padStart(2, "0")}行：保留順序。`)].join("\n") },
    { id: "boundary", heading: "肆、跨頁多行長標題：本節用來核對標題群組是否與首段同行保留並避免單獨留在上一頁的最後數行", text: "跨頁正文起點：標題和本段必須在同一頁。\n本段第二行：不得為了填頁刪除題意。\nQ2-END" },
  ] },
  { title: "合成三：標點與整字換行", sections: [
    { id: "notice", text: notice },
    { id: "punctuation", heading: "伍、自然換行的純標點負例", text: chineseRun + "，\n" + chineseRun + "。\n明確輸入的分隔線如下。\n---\n括號與引號：「完整性」（測試）。" },
    { id: "latin", heading: "陸、可容納的英文詞組", text: "甲".repeat(17) + " Authentication protocol 與 JSON Web Token。\nQ3-END" },
  ] },
  { title: "合成四：五個名詞區塊", sections: [
    { id: "notice", text: notice },
    ...terms.map((term, i) => ({ id: `term-${i + 1}`, heading: `${["一", "二", "三", "四", "五"][i]}、${term}`, text: `名詞${i + 1}定義起點：${term}在本合成案例中只代表測試用名詞。` + "每個區塊均保留自己的解釋與可識別結尾，不從其他區塊借用定義，也不把短標題單獨放在頁尾。".repeat(2) + `名詞${i + 1}定義結尾。` })),
    { id: "end", text: "Q4-END" },
  ] },
];
const manifest: any = { synthetic: true, formalAnswer: false, templateId, runName, fonts: {
  regular: process.env.ESSAY_MCP_PDF_FONT, bold: process.env.ESSAY_MCP_PDF_BOLD_FONT,
}, files: [], delivery: {}, cases: inputs, notes: ["166 not tested: no configured verified paper font", "External visual review is not persisted by this API"] };
manifest.grid = gridMetrics(await store.getTemplate(templateId));
async function saveBundle(bundle: any, basename: string) {
  const file = bundle.files.find((f: any) => f.format === "pdf");
  const artifact = await store.readExport(file.exportUri.split("/").at(-1));
  await fs.writeFile(path.join(output, basename + ".pdf"), artifact.data);
  const pages: string[] = [];
  const members = [];
  for (const member of bundle.answers) {
    const answer = await store.getAnswer(member.answerId), template = await store.getTemplate(answer.templateId);
    const layout = layoutSections(template, answer.sections, answer.layoutOptions);
    for (let page = 1; page <= member.pages; page++) pages.push(layout.lines.filter(l => l.page === page && !l.isSpacer).map(l => l.text).join("\n"));
    const source = answer.sections.flatMap(s => [s.heading ?? "", ...(s.paragraphs?.map(p => p.text) ?? [s.text])]).join("\n");
    assert.equal(pages.slice(-member.pages).join("").replace(/\s/gu, ""), source.replace(/\s/gu, ""), "layout must preserve source text");
    members.push({ ...member, layout, warnings: layoutWarnings(layout, template) });
  }
  manifest.files.push({ name: basename + ".pdf", pages: file.pages, fontWarning: file.fontWarning ?? null, expectedPageText: pages, members });
}
try {
  const examId = (await call("start_exam", { title: "合成測試／非正式擬答", questions: inputs.map((_, i) => ({ questionNo: i + 1 })), formats: ["pdf", "docx"] })).examId;
  await call("create_answers", { examId, answers: inputs.map((input, i) => ({ ...input, templateId, questionNo: i + 1 })) });
  manifest.delivery.beforeExport = await call("get_exam_progress", { examId });
  assert.equal(manifest.delivery.beforeExport.delivery.status, "not_ready");
  const partial = await call("export_exam_bundle", { examId, formats: ["pdf"] });
  manifest.initialPdfFontWarning = partial.files[0].fontWarning ?? null;
  const raw = await store.readExport(partial.files[0].exportUri.split("/").at(-1));
  await fs.writeFile(path.join(root, "unrepaired-wide-ascii.pdf"), raw.data);
  manifest.unrepairedFixture = path.join(root, "unrepaired-wide-ascii.pdf");
  manifest.delivery.missingFormat = await call("get_exam_progress", { examId });
  assert.equal(manifest.delivery.missingFormat.bundle.status, "outdated");
  assert.equal(manifest.delivery.missingFormat.delivery.status, "not_ready");
  await call("export_exam_bundle", { examId });
  manifest.delivery.afterExport = await call("get_exam_progress", { examId });
  assert.equal(manifest.delivery.afterExport.nextStep.action, "done");
  assert.equal(manifest.delivery.afterExport.delivery.status, "awaiting_review");
  const firstId = partial.answers[0].answerId;
  const first = await store.getAnswer(firstId);
  const last = first.sections.at(-1)!;
  // Repair the observed synthetic wide-ASCII rows through the same public MCP edit tool;
  // retain every character and font size, making the line breaks explicit.
  const repaired = runName === "before" ? last.text : ["m", "W", "@"].reduce((value, c) => value.replace(c.repeat(42), c.repeat(21) + "\n" + c.repeat(21)), last.text);
  await call("replace_text", { answerId: firstId, sectionId: last.id, expectedVersion: first.version, newText: repaired + "\n【修訂驗證：版本二】" });
  manifest.delivery.afterEdit = await call("get_exam_progress", { examId });
  assert.equal(manifest.delivery.afterEdit.bundle.status, "outdated");
  assert.equal(manifest.delivery.afterEdit.delivery.status, "not_ready");
  await saveBundle(await call("export_exam_bundle", { examId }), "synthetic-exam");
  if (runName !== "before") {
    assert.match(manifest.initialPdfFontWarning, /實際字形.*超出/);
    assert.equal(manifest.files[0].fontWarning, null);
    assert.equal(manifest.files[0].members.flatMap((m: any) => m.warnings).some((w: any) => w.code === "PUNCTUATION_ONLY_LINE"), false);
  }
  manifest.delivery.final = await call("get_exam_progress", { examId });
  assert.deepEqual(manifest.delivery.final.delivery.checks, { layoutCapacity: "passed", content: "not_checked", source: "not_checked", visual: "not_checked" });

  const overflow = await call("create_answer", { templateId, title: "合成長段落溢出負例", sections: [{ id: "long", heading: notice, text: "長段落起點。" + "這是用於驗證長段落跨頁完整性的合成文字。".repeat(55) + "長段落結尾。OVERFLOW-END" }] });
  const rejected = await client.callTool({ name: "export_exam_bundle", arguments: { answers: [{ answerId: overflow.answer.id, expectedVersion: 1 }], formats: ["pdf"] } });
  assert.equal(rejected.isError, true);
  manifest.overflowRejected = rejected.structuredContent;
  await saveBundle(await call("export_exam_bundle", { answers: [{ answerId: overflow.answer.id, expectedVersion: 1 }], formats: ["pdf"], allowOverflow: true }), "synthetic-overflow");

  const warningExam = (await call("start_exam", { title: "孤立標題合成負例", questions: [{ questionNo: 1 }], formats: ["pdf"] })).examId;
  const warningAnswer = await call("create_answer", { examId: warningExam, questionNo: 1, templateId, title: "故意保留的品質警告", layoutOptions: { keepHeadingWithNext: false, avoidPunctuationOnlyLines: false }, sections: [
    { id: "lead", text: [notice, ...Array.from({ length: 20 }, (_, i) => `負例第${i + 1}行。`)].join("\n") },
    { id: "orphan", heading: "故意孤立的標題（負例）", text: "這是下一頁正文，警告應保留。\n" + chineseRun + "，\nWARNING-END" },
  ] });
  const warningCheck = await call("check_layout", { answerId: warningAnswer.answer.id });
  assert.ok(warningCheck.warnings.some((w: any) => w.code === "PUNCTUATION_ONLY_LINE"));
  const warningBundle = await call("export_exam_bundle", { examId: warningExam });
  assert.ok(warningBundle.answers[0].warnings.some((w: any) => w.code === "ORPHAN_HEADING"));
  assert.ok(warningBundle.answers[0].warnings.some((w: any) => w.code === "PUNCTUATION_ONLY_LINE"));
  await saveBundle(warningBundle, "synthetic-warnings");
  manifest.delivery.withWarnings = await call("get_exam_progress", { examId: warningExam });
  assert.equal(manifest.delivery.withWarnings.questions[0].warningCount > 0, true);
  assert.equal(manifest.delivery.withWarnings.delivery.status, "awaiting_review");
  assert.equal(manifest.delivery.withWarnings.delivery.checks.visual, "not_checked");
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ output, files: manifest.files.map((f: any) => ({ name: f.name, pages: f.pages })), deliveryChecksPassed: true }, null, 2));
} finally { await client.close(); await server.close(); }
