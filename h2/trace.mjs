// Readable trace of a `codex exec --json` run for the harness2 improver.
// Usage: node h2/trace.mjs <events.jsonl>
import fs from "node:fs";

const clip = (text, n) => (text.length > n ? `${text.slice(0, n)}… [${text.length - n} more chars]` : text);
const lines = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/);
const seen = new Set();
let calls = 0;
let failed = 0;
console.log("=== AGENT TRACE ===");
for (const line of lines) {
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  const item = event.item;
  if (event.type === "turn.completed" && event.usage) {
    console.log(`[usage] input=${event.usage.input_tokens} output=${event.usage.output_tokens}`);
    continue;
  }
  if (event.type !== "item.completed" || !item || seen.has(item.id)) continue;
  seen.add(item.id);
  if (item.type === "agent_message") {
    console.log(`\n[assistant] ${clip(item.text ?? "", 1500)}`);
  } else if (item.type === "mcp_tool_call") {
    calls += 1;
    const result = item.result ?? {};
    const isError = item.status === "failed" || !!item.error || result.isError === true || result.is_error === true;
    if (isError) failed += 1;
    const text = (result.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n");
    const errorText = typeof item.error === "string" ? item.error : item.error ? JSON.stringify(item.error) : "";
    console.log(`\n[call ${calls}] ${item.tool}(${clip(JSON.stringify(item.arguments ?? {}), 800)})`);
    console.log(`  -> ${isError ? "ERROR " : ""}${clip(errorText || text || JSON.stringify(result.structured_content ?? result.structuredContent ?? {}), 1200)}`);
  } else if (item.type === "command_execution") {
    console.log(`\n[shell] ${clip(item.command ?? "", 300)} (exit ${item.exit_code ?? "?"})`);
  }
}
console.log(`\n=== ${calls} tool calls, ${failed} failed ===`);
