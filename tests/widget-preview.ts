// Test-only local preview of the answer-sheet widget with a real server and a real-length essay, for screenshots.
// Usage: ESSAY_MCP_PAPER_FONT=<edukai ttf> npx tsx tests/widget-preview.ts [port]  → open http://127.0.0.1:<port>/
// The page is the widget itself; a hidden same-origin frame plays the MCP Apps host and forwards tools/call to the server.
import http from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FileStore } from "../src/storage.js";
import { createEssayMcpServer } from "../src/server.js";

const port = Number(process.argv[2] ?? 8792);
const dir = mkdtempSync(join(tmpdir(), "essay-widget-preview-"));
const server = createEssayMcpServer(new FileStore({ answerDir: join(dir, "answers"), exportDir: join(dir, "exports") }));
const client = new Client({ name: "widget-preview", version: "1" });
const [a, b] = InMemoryTransport.createLinkedPair();
await server.connect(a);
await client.connect(b);

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.content)}`);
  return result;
}

const sections = [
  { id: "intro", heading: "壹、前言", text: "政府機關推動數位服務，資訊系統已成為警政業務不可或缺的基礎。然而系統越集中，一旦遭受勒索軟體或內部人員濫權存取，影響範圍越大。因此，資通安全不應只是技術部門的責任，而應納入機關整體治理，從風險評估、管理制度到技術防護同步規劃，以下分述之。" },
  { id: "body", heading: "貳、本文", text: [
    "（一）風險評估與資產盤點：",
    "1. 依資通安全管理法及其施行細則，機關應先盤點核心資通系統，區分資料類別與敏感等級，並依可能性與衝擊程度評定風險值。",
    "2. 針對警政資料庫等高風險系統，應優先導入存取控制與稽核紀錄，確保每一次查詢都能追溯至個人帳號。",
    "（二）管理制度面：",
    "1. 建立資安長與資安專責人員制度，明定權責分工，並定期召開資安會議檢討事件與改善進度。",
    "2. 落實最小權限原則與職務輪調，離職或調職人員之帳號應即時停用，避免權限累積。",
    "3. 委外廠商應簽訂保密協定，並於契約中明定資安要求、稽核權利與違約責任。",
    "（三）技術防護面：",
    "1. 導入多因素驗證、端點偵測與回應（EDR）及網路分段，降低單一帳號外洩造成的橫向擴散。",
    "2. 定期執行弱點掃描與滲透測試，並建立修補時程管控，高風險弱點應於期限內完成修補。",
    "3. 落實 3-2-1 備份原則並定期演練還原，確保遭受勒索軟體攻擊時能於可接受時間內恢復服務。",
    "（四）人員訓練與演練：",
    "1. 依職務別規劃資安教育訓練時數，並以社交工程演練檢驗成效。",
    "2. 每年辦理資安事件應變演練，驗證通報流程與跨單位協調機制。",
  ].join("\n") },
  { id: "end", heading: "參、結論", text: "資通安全是持續改善的循環，機關應以風險為導向，結合管理制度、技術防護與人員訓練，並透過定期稽核與演練檢驗成效，方能在提升數位服務效率的同時，確保民眾資料安全與機關公信力。" },
];

const exam = await call("start_exam", { title: "113年警察三等・資訊管理", questions: [{ questionNo: 1 }, { questionNo: 2 }] });
const examId = (exam.structuredContent as { examId: string }).examId;
const created = await call("create_answer", { examId, questionNo: 1, title: "機關資通安全管理之規劃", sections, responseDetail: "full" });
const answerId = (created.structuredContent as { answer: { id: string } }).answer.id;
const initial = await call("render_answer_sheet", { answerId });

const hostShim = `<script>
(() => {
  const frame = document.createElement("iframe");
  frame.hidden = true;
  document.documentElement.appendChild(frame);
  const host = frame.contentWindow;
  // Created in the frame's realm, so the widget sees event.source === window.parent.
  const send = host.Function("d", "top.postMessage(d, '*')");
  const post = (path, body) => fetch(path, { method: "POST", body: JSON.stringify(body) }).then(r => r.json());
  host.addEventListener("message", async (event) => {
    const m = event.data || {};
    if (m.method === "ui/initialize") send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2026-01-26", hostCapabilities: { serverTools: {} } } });
    else if (m.method === "ui/notifications/initialized") send({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: await post("/initial", {}) });
    else if (m.method === "tools/call") send({ jsonrpc: "2.0", id: m.id, result: await post("/call", m.params) });
    else if (m.id !== undefined) send({ jsonrpc: "2.0", id: m.id, result: {} });
  });
  Object.defineProperty(window, "parent", { value: host, configurable: true });
})();
</script>`;

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      // Re-read the source on every load so edits show without restarting (the HTML is a String.raw literal with no interpolation).
      const html = readFileSync(new URL("../src/widget.ts", import.meta.url), "utf8").split("String.raw`")[1].split("</html>`;")[0] + "</html>";
      res.end(html.replace("<head>", "<head>" + hostShim));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const params = JSON.parse(body || "{}");
    const result = req.url === "/initial" ? initial : await client.callTool({ name: params.name, arguments: params.arguments });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(result));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ isError: true, content: [{ type: "text", text: String(error) }] }));
  }
}).listen(port, "127.0.0.1", () => console.log(`WIDGET_PREVIEW_URL=http://127.0.0.1:${port}/ answer=${answerId} exam=${examId}`));
