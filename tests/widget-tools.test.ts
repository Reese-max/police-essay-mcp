import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM, VirtualConsole, type DOMWindow } from "jsdom";
import { POLICE_ESSAY_WIDGET_HTML } from "../src/widget.js";

// A fake MCP Apps host for the widget's phrase, order, numbering and history controls.
type Args = Record<string, unknown> & { answerId?: string; expectedVersion?: number; operation?: string };
type Section = { id: string; heading: string; text: string; order: number };

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
// Arguments come from the widget's window, so compare them as plain JSON.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

async function host(options: { readOnly?: boolean } = {}) {
  let version = 1;
  let sections: Section[] = [
    { id: "a", heading: "一、前言", text: "政府建置資訊系統應以業務需求為本。", order: 0 },
    { id: "b", heading: "三、本文", text: "（一）技術可行性。", order: 1 },
    { id: "c", heading: "二、結論", text: "完成評估。", order: 2 },
  ];
  const calls: Array<{ name: string; args: Args }> = [];
  const snapshot = () => {
    const lines = [...sections].sort((x, y) => x.order - y.order).flatMap((section, index) => [
      { page: 1, lineOnPage: index * 2 + 1, text: section.heading, sectionId: section.id, paragraphIndex: 0, isHeading: true, format: {} },
      { page: 1, lineOnPage: index * 2 + 2, text: section.text, sectionId: section.id, paragraphIndex: 1, isHeading: false, format: {} },
    ]);
    return { answer: { id: "ans_widget", title: "測試", version, sections }, layout: { pagesConfigured: 2, linesPerPage: 22, columns: 38, totalLines: lines.length, capacity: 44, remainingLines: 44 - lines.length, overflowLines: 0, fits: true, lines } };
  };
  const result = () => ({ structuredContent: snapshot(), _meta: { readOnly: Boolean(options.readOnly) } });
  const write = (text: string) => { version += 1; return { structuredContent: snapshot(), content: [{ type: "text", text }] }; };
  const tools = async (name: string, args: Args) => {
    calls.push({ name, args });
    if (name === "preview_change") return { structuredContent: { summary: ["版本", "行數", "容量", `預覽 ${args.operation}`], after: snapshot() } };
    if (name === "edit_text") {
      const { find, replace } = (args.edits as Array<{ find: string; replace: string }>)[0];
      sections = sections.map((section) => ({ ...section, text: section.text.replace(find, replace) }));
      return write("已修改 1 處（版本 1 → 2）\n・「一、前言」第1段：改字");
    }
    if (name === "move_section") {
      const moving = sections.find((section) => section.id === args.sectionId)!;
      const rest = [...sections].sort((x, y) => x.order - y.order).filter((section) => section !== moving);
      const anchor = rest.findIndex((section) => section.id === (args.beforeSectionId ?? args.afterSectionId));
      rest.splice(anchor + (args.afterSectionId ? 1 : 0), 0, moving);
      sections = rest.map((section, order) => ({ ...section, order }));
      return write("已搬移");
    }
    if (name === "renumber_items") {
      sections = sections.map((section) => section.id === "b" ? { ...section, heading: "二、本文" } : section.id === "c" ? { ...section, heading: "三、結論" } : section);
      return write("已重新編號 2 處");
    }
    if (name === "list_revisions") {
      return { structuredContent: { answerId: "ans_widget", currentVersion: version, olderVersions: 0, revisions: [
        { version, changes: ["目前內容"], totalLines: 6, fits: true },
        ...(version > 1 ? [{ version: 1, changes: ["建立答案。"], totalLines: 6, fits: true }] : []),
      ] } };
    }
    if (name === "restore_revision") return write(`已把第 ${args.version} 版的內容存成第 ${version + 1} 版`);
    return result();
  };
  let window!: DOMWindow;
  const parent = { postMessage(message: { id?: number; method: string; params: { name: string; arguments: Args } }) {
    queueMicrotask(async () => {
      const reply = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { source: parent as unknown as Window, origin: "https://host.test", data }));
      if (message.method === "ui/notifications/initialized") reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result() });
      else if (message.method === "ui/initialize") reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2026-01-26" } });
      else if (message.method === "tools/call") reply({ jsonrpc: "2.0", id: message.id, result: await tools(message.params.name, message.params.arguments) });
    });
  } };
  const errors: Error[] = [];
  const console = new VirtualConsole();
  console.on("jsdomError", (error) => errors.push(error));
  const dom = new JSDOM(POLICE_ESSAY_WIDGET_HTML, { runScripts: "dangerously", url: "https://view.test", virtualConsole: console, beforeParse(w) {
    window = w;
    Object.defineProperty(w, "parent", { value: parent });
  } });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(errors, []);
  const element = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T;
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const click = async (target: string | HTMLElement) => { (typeof target === "string" ? element(target) : target).click(); await settle(); };
  const type = (id: string, value: string) => { element<HTMLInputElement>(id).value = value; element(id).dispatchEvent(new dom.window.Event("input")); };
  const select = (id: string) => { element<HTMLSelectElement>("section").value = id; element("section").dispatchEvent(new dom.window.Event("change")); };
  return { dom, calls, element, click, type, select, get version() { return version; }, get sections() { return sections; } };
}

test("the phrase panel previews and applies edit_text, and can take the selection from the section text", async () => {
  const h = await host();
  try {
    assert.equal(h.element<HTMLButtonElement>("apply-phrase").disabled, true);
    const text = h.element<HTMLTextAreaElement>("text");
    text.setSelectionRange(2, 4);
    await h.click("use-selection");
    assert.equal(h.element<HTMLInputElement>("find").value, "建置");
    h.type("replace", "推動");
    h.type("occurrence", "1");
    await h.click("preview-phrase");
    const preview = h.calls.find((call) => call.name === "preview_change")!;
    assert.deepEqual(plain(preview.args), { operation: "edit_text", answerId: "ans_widget", expectedVersion: 1, edits: [{ find: "建置", replace: "推動", occurrence: 1 }] });
    assert.match(h.element("phrase-preview").textContent!, /預覽 edit_text/);
    // Changing the inputs drops the preview, so a stale one cannot be applied.
    h.type("replace", "推廣");
    assert.equal(h.element<HTMLButtonElement>("apply-phrase").disabled, true);
    await h.click("preview-phrase");
    await h.click("apply-phrase");
    const edit = h.calls.find((call) => call.name === "edit_text")!;
    assert.deepEqual(plain(edit.args.edits), [{ find: "建置", replace: "推廣", occurrence: 1 }]);
    assert.equal(h.version, 2);
    assert.equal(h.element<HTMLInputElement>("find").value, "");
    assert.match(h.element("notice").textContent!, /已修改 1 處/);
    assert.equal(h.element("version").textContent, "版本：2");
  } finally { h.dom.window.close(); }
});

test("sections move up and down, and renumbering asks for a second click after its preview", async () => {
  const h = await host();
  try {
    h.select("a");
    assert.equal(h.element<HTMLButtonElement>("move-up").disabled, true);
    h.select("c");
    assert.equal(h.element<HTMLButtonElement>("move-down").disabled, true);
    await h.click("move-up");
    const move = h.calls.find((call) => call.name === "move_section")!;
    assert.deepEqual(plain(move.args), { answerId: "ans_widget", sectionId: "c", expectedVersion: 1, beforeSectionId: "b" });
    assert.deepEqual([...h.sections].sort((x, y) => x.order - y.order).map((section) => section.id), ["a", "c", "b"]);

    await h.click("renumber");
    assert.equal(h.calls.filter((call) => call.name === "renumber_items").length, 0);
    assert.equal(h.element("renumber").textContent, "確認重新編號");
    assert.match(h.element("tools-preview").textContent!, /預覽 renumber_items/);
    await h.click("renumber");
    const renumber = h.calls.find((call) => call.name === "renumber_items")!;
    assert.deepEqual(plain(renumber.args), { answerId: "ans_widget", expectedVersion: 2 });
    assert.equal(h.element("renumber").textContent, "重新編號");
    assert.equal(h.version, 3);
  } finally { h.dom.window.close(); }
});

test("the history lists each version and restores an older one as a new version", async () => {
  const h = await host();
  try {
    h.type("find", "前言");
    await h.click("preview-phrase");
    await h.click("apply-phrase");
    await h.click("load-revisions");
    const items = [...h.element("revisions").querySelectorAll("li")];
    assert.equal(items.length, 2);
    assert.match(items[0].textContent!, /第 2 版.*目前/);
    const restore = items[1].querySelector("button")!;
    assert.equal(restore.textContent, "還原成這一版");
    await h.click(restore);
    const call = h.calls.find((item) => item.name === "restore_revision")!;
    assert.deepEqual(plain(call.args), { answerId: "ans_widget", version: 1, expectedVersion: 2 });
    assert.equal(h.version, 3);
    // The listed history is stale after the restore.
    assert.equal(h.element("revisions").children.length, 0);
  } finally { h.dom.window.close(); }
});

test("read-only views can list the history but not change anything", async () => {
  const h = await host({ readOnly: true });
  try {
    for (const id of ["find", "replace", "use-selection", "preview-phrase", "apply-phrase", "move-up", "move-down", "renumber"]) {
      assert.equal(h.element<HTMLButtonElement>(id).disabled, true, id);
    }
    assert.equal(h.element<HTMLButtonElement>("load-revisions").disabled, false);
    await h.click("load-revisions");
    assert.equal(h.element("revisions").querySelectorAll("button").length, 0);
  } finally { h.dom.window.close(); }
});
