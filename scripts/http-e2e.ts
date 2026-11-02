// Synthetic HTTP E2E against a running police-essay MCP (local container or Cloud Run revision).
// Usage: npx tsx scripts/http-e2e.ts <baseUrl> [ownerToken]   — creates and deletes one synthetic answer per template.
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

if (!process.argv[2]) {
  console.error("Usage: npx tsx scripts/http-e2e.ts <baseUrl> [ownerToken] (or set E2E_OWNER_TOKEN)");
  process.exit(2);
}
const base = process.argv[2].replace(/\/+$/, "");
const token = process.env.E2E_OWNER_TOKEN || process.argv[3];
const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
const log = (...a: unknown[]) => console.log("E2E", ...a);

for (const p of ["/health", "/readyz"]) {
  const r = await fetch(base + p); log(p, r.status); assert.equal(r.status, 200, p);
}
const client = new Client({ name: "slim-http-e2e", version: "1" });
await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers } }));
const tools = (await client.listTools()).tools;
const bytes = Buffer.byteLength(JSON.stringify(tools));
log("tools", tools.length, "bytes", bytes);
for (const gone of ["export_pdf", "export_docx", "export_text", "reflow_answer"]) assert.ok(!tools.some((t) => t.name === gone), gone);
assert.ok(bytes <= 80_000);
const call = async (name: string, args: Record<string, unknown>, expectError = false) => {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text?: string }[]).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (expectError) assert.equal(r.isError, true, `${name} should fail: ${text}`);
  else assert.notEqual(r.isError, true, `${name}: ${text}`);
  return { r, text, sc: r.structuredContent as any };
};

const created: string[] = [];
try {
  for (const templateId of ["police_information_essay_165", undefined]) {
    const tag = templateId ? "165" : "default";
    const { sc } = await call("list_templates", {});
    const tpl = templateId ?? sc.templates?.find((t: any) => !t.paperProfile)?.id;
    const c = await call("create_answer", { title: `SLIM-E2E-${tag}`, templateId: tpl, exam: "E2E 合成測試", questionNo: 1,
      sections: [{ id: "intro", heading: "一、前言", text: "合成測試段落，驗證 tools/list 瘦身後的完整流程。Zero Trust 與 ISO 27001。" },
                 { id: "body", heading: "二、本文", text: "第二段內容，用於預覽、修改與匯出。".repeat(3) }] });
    const id = c.sc.answer.id; created.push(id); let v = c.sc.answer.version;
    assert.ok(c.sc.layout && typeof c.sc.layout.fits === "boolean" && c.sc.answer.title, "writeOutputSchema fields");
    // preview_change: valid, stray, wrong-type
    const pv = await call("preview_change", { answerId: id, operation: "edit_text", expectedVersion: v, edits: [{ find: "合成測試段落", replace: "合成驗證段落" }] });
    assert.ok(pv.sc.summary, "preview summary");
    const stray = await call("preview_change", { answerId: id, operation: "edit_text", expectedVersion: v, edits: [{ find: "合成", replace: "x" }], bogusArg: 1 }, true);
    assert.match(stray.text, /bogusArg/); log(tag, "stray rejected:", stray.text.slice(0, 80));
    const proto = await call("preview_change", { answerId: id, operation: "delete_text", expectedVersion: v, sectionId: "body", toString: "x" }, true);
    log(tag, "toString rejected:", proto.text.slice(0, 60));
    await call("preview_change", { answerId: id, operation: "write_answer", expectedVersion: v, sections: [{ id: "a", text: 42 }] }, true);
    assert.equal((await call("read_answer", { answerId: id })).sc.answer.version, v, "preview must not write");
    // writes
    const tools12 = [
      ["edit_text", { edits: [{ find: "合成測試段落", replace: "合成驗證段落" }] }],
      ["replace_text", { sectionId: "body", newText: "改寫後的本文。".repeat(4) }],
      ["insert_text", { section: { id: "end", heading: "三、結論", text: "結論段落。" } }],
      ["format_section", { sectionId: "end", paragraphFormat: { firstLineIndent: 2 } }],
      ["move_section", { sectionId: "end", afterSectionId: "intro" }],
      ["renumber_items", {}],
      ["delete_text", { sectionId: "end" }],
    ] as const;
    for (const [name, args] of tools12) {
      const w = await call(name, { answerId: id, expectedVersion: v, ...args });
      assert.ok(w.sc.answer?.id === id && w.sc.layout, `${name} output`); v = w.sc.answer.version; log(tag, name, "v" + v);
    }
    await call("edit_text", { answerId: id, expectedVersion: v - 1, edits: [{ find: "改寫", replace: "x" }] }, true); // stale version
    const rv = await call("restore_revision", { answerId: id, version: 1, expectedVersion: v }); v = rv.sc.answer.version;
    const ui = await call("update_answer_info", { answerId: id, expectedVersion: v, title: `SLIM-E2E-${tag}-renamed` }); v = ui.sc.answer.version;
    const dup = await call("duplicate_answer", { answerId: id }); created.push(dup.sc.answer.id);
    const lay = await call("check_layout", { answerId: id }); log(tag, "fits", lay.sc.fits ?? lay.sc.layout?.fits);
    await call("render_answer_sheet", { answerId: id });
    await call("list_revisions", { answerId: id });
    // export all three formats through export_answer and fetch bytes
    const ex = await call("export_answer", { answerId: id, expectedVersion: v, formats: ["docx", "pdf", "txt"] });
    const files = ex.sc.exports ?? ex.sc.files ?? [];
    log(tag, "export keys", Object.keys(ex.sc), "count", files.length);
    for (const f of files) {
      let size = -1;
      if (f.downloadUrl) { const r = await fetch(f.downloadUrl, { headers }); size = (await r.arrayBuffer()).byteLength; assert.equal(r.status, 200); }
      else { const rr = await client.readResource({ uri: f.exportUri }); size = JSON.stringify(rr).length; }
      log(tag, f.format, f.fileName, "bytes", size); assert.ok(size > 100);
    }
    const txt = await call("export_answer", { answerId: id, expectedVersion: v, formats: ["txt"], textMode: "paragraphs" });
    log(tag, "txt paragraphs ok", Object.keys(txt.sc));
  }
} finally {
  try {
    for (const id of created.filter(Boolean)) {
      try {
        const cur = await client.callTool({ name: "read_answer", arguments: { answerId: id } });
        const ver = (cur.structuredContent as any)?.answer?.version;
        const d = await client.callTool({ name: "delete_answer", arguments: { answerId: id, expectedVersion: ver } });
        log("cleanup", id, d.isError ? "FAILED " + JSON.stringify(d.content).slice(0, 200) : "deleted");
      } catch (error) { log("cleanup", id, "FAILED", String(error).slice(0, 200)); }
    }
  } finally { await client.close(); }
}
console.log("HTTP_E2E_OK");
