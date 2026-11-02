// Exam flow E2E: start_exam -> create_answers -> render_exam_overview -> export_exam_bundle -> get_exam_progress, then cleanup.
// Usage: npx tsx scripts/http-exam-e2e.ts <baseUrl> <outDir> [ownerToken]
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (!process.argv[2] || !process.argv[3]) {
  console.error("Usage: npx tsx scripts/http-exam-e2e.ts <baseUrl> <outDir> [ownerToken] (or set E2E_OWNER_TOKEN)");
  process.exit(2);
}
const base = process.argv[2].replace(/\/+$/, "");
const outDir = process.argv[3];
const token = process.env.E2E_OWNER_TOKEN || process.argv[4];
mkdirSync(outDir, { recursive: true });
const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
const client = new Client({ name: "slim-exam-e2e", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers } }));
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as any[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  assert.notEqual(r.isError, true, `${name}: ${text}`);
  console.log("EXAM", name, text.split("\n")[0].slice(0, 100));
  return r.structuredContent as any;
};
const ids: string[] = [];
let examId: string | undefined;
try {
  const plan = await call("start_exam", { title: "SLIM-E2E 考試", questions: [{ questionNo: 1, question: "試述資安治理。" }, { questionNo: 2, question: "試述零信任。" }] });
  examId = plan.examId;
  const created = await call("create_answers", { examId: plan.examId, answers: [1, 2].map((n) => ({
    title: `SLIM-E2E 第${n}題`, questionNo: n, exam: "SLIM-E2E 考試", idempotencyKey: `slim_e2e_${Date.now()}_${n}`,
    sections: [{ id: "a", heading: "一、前言", text: `第${n}題合成內容：資訊安全治理與 Zero Trust 架構。`.repeat(4) }] })) });
  for (const a of created.answers) ids.push(a.answerId);
  assert.equal(ids.length, 2);
  await call("get_exam_progress", { examId: plan.examId });
  await call("render_exam_overview", { examId: plan.examId });
  const bundle = await call("export_exam_bundle", { examId: plan.examId });
  for (const f of bundle.files ?? []) {
    const r = await fetch(f.downloadUrl, { headers }); assert.equal(r.status, 200, f.fileName);
    const buf = Buffer.from(await r.arrayBuffer()); writeFileSync(`${outDir}/bundle.${f.format}`, buf);
    console.log("EXAM bundle", f.format, f.fileName, buf.byteLength);
  }
  const progress = await call("get_exam_progress", { examId: plan.examId });
  console.log("EXAM nextStep", progress.nextStep, "delivery", progress.delivery?.status);
} finally {
  for (const id of ids) {
    try {
      const cur = await client.callTool({ name: "read_answer", arguments: { answerId: id } });
      const d = await client.callTool({ name: "delete_answer", arguments: { answerId: id, expectedVersion: (cur.structuredContent as any)?.answer?.version } });
      console.log("EXAM cleanup", id, d.isError ? "FAILED" : "deleted");
    } catch (error) { console.log("EXAM cleanup", id, "FAILED", String(error).slice(0, 200)); }
  }
  try {
    if (examId) {
      const progress = await call("get_exam_progress", { examId });
      await call("delete_exam", { examId, expectedVersion: progress.version });
    }
  } finally { await client.close(); }
}
console.log("HTTP_EXAM_E2E_OK");
