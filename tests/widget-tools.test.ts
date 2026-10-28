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

async function host(options: { readOnly?: boolean; svgPages?: string[]; summary?: boolean; legacy?: boolean; overview?: boolean; examPlan?: boolean; emptyPlan?: boolean; warnings?: boolean; metadata?: boolean; noCallMeta?: boolean } = {}) {
  let version = 1;
  let omitPages = false;
  let answerId = "ans_widget";
  const held = new Map<string, () => void>();
  const holding = new Set<string>();
  const failing = new Map<string, "error" | "empty">();
  let sections: Section[] = [
    { id: "a", heading: "一、前言", text: "政府建置資訊系統應以業務需求為本。", order: 0 },
    { id: "b", heading: "三、本文", text: "（一）技術可行性。", order: 1 },
    { id: "c", heading: "二、結論", text: "完成評估。", order: 2 },
  ];
  const calls: Array<{ name: string; args: Args }> = [];
  const snapshot = (id = answerId) => {
    const lines = [...sections].sort((x, y) => x.order - y.order).flatMap(section => [
      { text: section.heading, sectionId: section.id, paragraphIndex: 0, isHeading: true, format: {} },
      ...section.text.split("\n").flatMap(text => (text.match(/.{1,38}/gu) ?? [""]).map(text => ({ text, sectionId: section.id, paragraphIndex: 1, isHeading: false, format: {} }))),
    ]).map((line, index) => ({ ...line, page: Math.floor(index / 22) + 1, lineOnPage: index % 22 + 1 }));
    return { answer: { id, title: id === "ans_second" ? "第二份" : "測試", version, sections }, layout: { pagesConfigured: 2, linesPerPage: 22, columns: 38, totalLines: lines.length, capacity: 44, remainingLines: Math.max(0, 44 - lines.length), overflowLines: Math.max(0, lines.length - 44), fits: lines.length <= 44, lines } };
  };
  const warningCount = () => options.warnings && sections.some(section => section.text.includes("建置")) ? 1 : 0;
  const result = () => ({ structuredContent: { ...(options.metadata ? { answer: { id: answerId, version }, layout: { totalLines: snapshot().layout.totalLines } } : snapshot()), warningCount: warningCount() },
    _meta: { readOnly: Boolean(options.readOnly), paperSvgPages: options.svgPages, ...(options.metadata ? { snapshot: snapshot() } : {}) } });
  const summary = () => ({ structuredContent: { answer: { id: answerId, title: "測試", version }, layout: { totalLines: 6 }, detail: "summary" } });
  const examSummaries = [
    { answerId: "ans_widget", title: "測試", questionNo: 4, version: 1, totalLines: 6, capacity: 44, fits: true, warnings: 0 },
    { answerId: "ans_second", title: "第二份", version: 1, totalLines: 45, capacity: 44, fits: false, warnings: 2 },
    { answerId: "ans_third", title: "第三份3", version: 1, totalLines: 3, capacity: 44, fits: true, warnings: 0 },
  ];
  const progress = () => ({ examId: "exam_widget", questions: [
    { questionNo: 1, ...(options.emptyPlan ? {} : { answerId: "ans_widget", version }), stage: options.emptyPlan ? "not_started" : version === 1 ? "exported" : "layout_ok" },
    { questionNo: 2, stage: "not_started" },
  ], nextStep: { action: "create_answer", questionNo: 2, message: "第2題尚未建立，從第2題接續。" } });
  const planned = () => ({ ...result(), structuredContent: { ...(options.emptyPlan ? {} : result().structuredContent), examId: "exam_widget", progress: progress(),
    examAnswers: progress().questions.map(q => ({ ...examSummaries[0], ...q, answerId: q.answerId, title: q.answerId ? "測試" : "未建立" })) } });
  const initial = () => options.examPlan ? planned() : options.overview ? { ...result(), structuredContent: { ...result().structuredContent, activeAnswerId: answerId, examAnswers: examSummaries } } : options.summary ? summary() : result();
  const write = (text: string, id: string | undefined) => { version += 1; return { structuredContent: snapshot(id), content: [{ type: "text", text }] }; };
  const tools = async (name: string, args: Args) => {
    calls.push({ name, args });
    if (name === "get_exam_progress") return { structuredContent: progress() };
    if (name === "render_answer_sheet" && args.answerId) answerId = args.answerId;
    const rendered = name === "render_answer_sheet" ? options.noCallMeta
      ? { structuredContent: { ...snapshot(), readOnly: Boolean(options.readOnly), warningCount: warningCount(), ...(!omitPages && options.svgPages ? { paperSvgPages: options.svgPages } : {}) }, content: [{ type: "text", text: "rendered" }] }
      : result() : undefined;
    if (name === "render_answer_sheet" && options.noCallMeta) assert.equal(args.responseDetail, "full");
    if (holding.has(name)) {
      holding.delete(name);
      await new Promise<void>((resolve) => held.set(name, resolve));
    }
    if (failing.get(name) === "error") return { isError: true, content: [{ type: "text", text: "模擬：畫板讀取失敗" }] };
    if (failing.get(name) === "empty") return { content: [{ type: "text", text: "沒有資料" }] };
    if (name === "preview_change") return { structuredContent: { summary: ["版本", "行數", "容量", `預覽 ${args.operation}`], after: snapshot() } };
    if (name === "edit_text") {
      const { find, replace } = (args.edits as Array<{ find: string; replace: string }>)[0];
      sections = sections.map((section) => ({ ...section, text: section.text.replace(find, replace) }));
      return write("已修改 1 處（版本 1 → 2）\n・「一、前言」第1段：改字", args.answerId);
    }
    if (name === "move_section") {
      const moving = sections.find((section) => section.id === args.sectionId)!;
      const rest = [...sections].sort((x, y) => x.order - y.order).filter((section) => section !== moving);
      const anchor = rest.findIndex((section) => section.id === (args.beforeSectionId ?? args.afterSectionId));
      rest.splice(anchor + (args.afterSectionId ? 1 : 0), 0, moving);
      sections = rest.map((section, order) => ({ ...section, order }));
      return write("已搬移", args.answerId);
    }
    if (name === "renumber_items") {
      sections = sections.map((section) => section.id === "b" ? { ...section, heading: "二、本文" } : section.id === "c" ? { ...section, heading: "三、結論" } : section);
      return write("已重新編號 2 處", args.answerId);
    }
    if (name === "list_revisions") {
      return { structuredContent: { answerId, currentVersion: version, olderVersions: 0, revisions: [
        { version, changes: ["目前內容"], totalLines: 6, fits: true },
        ...(version > 1 ? [{ version: 1, changes: ["建立答案。"], totalLines: 6, fits: true }] : []),
      ] } };
    }
    if (name === "restore_revision") return write(`已把第 ${args.version} 版的內容存成第 ${version + 1} 版`, args.answerId);
    if (name === "replace_text") {
      sections = sections.map((section) => section.id === args.sectionId ? { ...section, text: String(args.newText) } : section);
      return write("已修改", args.answerId);
    }
    return rendered ?? result();
  };
  let window!: DOMWindow;
  const parent = { postMessage(message: { id?: number; method: string; params: { name: string; arguments: Args } }) {
    queueMicrotask(async () => {
      const reply = (data: unknown) => window.dispatchEvent(new window.MessageEvent("message", { source: parent as unknown as Window, origin: "https://host.test", data }));
      if (message.method === "ui/notifications/initialized") reply({ jsonrpc: "2.0", method: "ui/notifications/tool-result", params: initial() });
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
    if (options.legacy) Object.defineProperty(w, "openai", { value: { toolOutput: initial().structuredContent, toolResponseMetadata: result()._meta, callTool: tools } });
  } });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepEqual(errors, []);
  const element = <T extends HTMLElement = HTMLElement>(id: string) => dom.window.document.getElementById(id) as T;
  const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
  const click = async (target: string | HTMLElement) => { (typeof target === "string" ? element(target) : target).click(); await settle(); };
  const type = (id: string, value: string) => { element<HTMLInputElement>(id).value = value; element(id).dispatchEvent(new dom.window.Event("input")); };
  const select = (id: string) => { element<HTMLSelectElement>("section").value = id; element("section").dispatchEvent(new dom.window.Event("change")); };
  // The host shows another answer (or a newer version) while the widget is busy.
  const show = async (next: { answerId?: string; bump?: boolean; empty?: boolean; summary?: boolean; full?: boolean; globals?: boolean; overviewIds?: string[]; metadata?: "missing" | "stale"; bodyText?: string }) => {
    if (next.answerId) answerId = next.answerId;
    if (next.bodyText) sections = sections.map((section, index) => index === 0 ? { ...section, text: next.bodyText! } : section);
    if (next.empty) sections = [];
    if (next.bump) version += 1;
    const value = next.overviewIds ? { ...result(), structuredContent: { ...result().structuredContent,
      examAnswers: examSummaries.filter(answer => next.overviewIds!.includes(answer.answerId)) } } : next.summary ? summary()
      : next.full ? { ...result(), structuredContent: { ...snapshot(), readOnly: Boolean(options.readOnly) } } : result();
    if (next.globals) window.dispatchEvent(new window.CustomEvent("openai:set_globals", { detail: { globals: { toolOutput: value.structuredContent, ...(next.metadata === "missing" ? {} : { toolResponseMetadata: next.metadata === "stale" ? (window as unknown as { openai: { toolResponseMetadata: unknown } }).openai.toolResponseMetadata : "_meta" in value ? value._meta : undefined }) } } }));
    else window.dispatchEvent(new window.MessageEvent("message", { source: parent as unknown as Window, origin: "https://host.test",
      data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: value } }));
    await settle();
  };
  const hold = (name: string) => holding.add(name);
  const release = async (name: string) => { holding.delete(name); held.get(name)?.(); held.delete(name); await settle(); };
  // The tool answers with an error, or with nothing the widget can show, until passed null.
  const fail = (name: string, mode: "error" | "empty" | null = "error") => { if (mode) failing.set(name, mode); else failing.delete(name); };
  return { omitPages() { omitPages = true; }, dom, calls, errors, element, click, type, select, show, hold, release, fail, snapshot, get version() { return version; }, get sections() { return sections; } };
}

for (const legacy of [true, false]) {
  test(`widget loads a create_answer summary from ${legacy ? "initial toolOutput" : "ui/notifications/tool-result"}`, async () => {
    const h = await host({ summary: true, legacy });
    try {
      assert.deepEqual(plain(h.calls), [{ name: "render_answer_sheet", args: { answerId: "ans_widget", responseDetail: "full" } }]);
      assert.match(h.element("answer-id").textContent!, /ans_widget/);
      assert.equal(h.element<HTMLTextAreaElement>("text").value, h.sections[0].text);
      assert.ok(h.dom.window.document.querySelectorAll(".answer-line").length > 0);
      assert.deepEqual(h.errors, []);
    } finally { h.dom.window.close(); }
  });
}

test("openai:set_globals summaries load full snapshots and report render failures", async () => {
  const h = await host({ legacy: true });
  try {
    await h.show({ answerId: "ans_globals", summary: true, globals: true });
    assert.deepEqual(plain(h.calls.at(-1)), { name: "render_answer_sheet", args: { answerId: "ans_globals", responseDetail: "full" } });
    assert.match(h.element("answer-id").textContent!, /ans_globals/);
    h.fail("render_answer_sheet");
    await h.show({ summary: true, globals: true });
    assert.match(h.element("notice").textContent!, /畫板讀取失敗/);
    assert.equal(h.element("notice").className, "notice error");
    h.fail("render_answer_sheet", "empty");
    await h.show({ summary: true, globals: true });
    assert.match(h.element("notice").textContent!, /沒有回傳可顯示/);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

test("a summary load cannot overwrite a later answer, version or summary", async () => {
  const h = await host();
  try {
    h.hold("render_answer_sheet");
    await h.show({ summary: true });
    await h.show({ answerId: "ans_newer" });
    await h.release("render_answer_sheet");
    assert.match(h.element("answer-id").textContent!, /ans_newer/);
    h.hold("render_answer_sheet");
    await h.show({ summary: true });
    await h.show({ bump: true });
    await h.release("render_answer_sheet");
    assert.equal(h.element("version").textContent, "版本：2");
    // A later summary also invalidates the pending load, even if its own load fails.
    h.hold("render_answer_sheet");
    await h.show({ answerId: "ans_old", summary: true });
    h.fail("render_answer_sheet");
    await h.show({ answerId: "ans_latest", summary: true });
    h.fail("render_answer_sheet", null);
    await h.release("render_answer_sheet");
    assert.match(h.element("answer-id").textContent!, /ans_newer/);
    assert.match(h.element("notice").textContent!, /畫板讀取失敗/);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

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
    assert.equal(edit.args.responseDetail, "full");
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
    assert.deepEqual(plain(move.args), { responseDetail: "full", answerId: "ans_widget", sectionId: "c", expectedVersion: 1, beforeSectionId: "b" });
    assert.deepEqual([...h.sections].sort((x, y) => x.order - y.order).map((section) => section.id), ["a", "c", "b"]);

    await h.click("renumber");
    assert.equal(h.calls.filter((call) => call.name === "renumber_items").length, 0);
    assert.equal(h.element("renumber").textContent, "確認重新編號");
    assert.match(h.element("tools-preview").textContent!, /預覽 renumber_items/);
    await h.click("renumber");
    const renumber = h.calls.find((call) => call.name === "renumber_items")!;
    assert.deepEqual(plain(renumber.args), { responseDetail: "full", answerId: "ans_widget", expectedVersion: 2 });
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
    assert.deepEqual(plain(call.args), { responseDetail: "full", answerId: "ans_widget", version: 1, expectedVersion: 2 });
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

test("previews, histories and writes that finish after the answer changed are dropped", async () => {
  const h = await host();
  try {
    // A renumbering preview for version 1 must not arm the button once version 2 is shown.
    h.hold("preview_change");
    await h.click("renumber");
    await h.show({ bump: true });
    await h.release("preview_change");
    assert.equal(h.element("renumber").textContent, "重新編號");
    await h.click("renumber");
    assert.equal(h.calls.filter((call) => call.name === "renumber_items").length, 0);
    // The second click previewed again; confirming applies exactly the previewed version.
    await h.click("renumber");
    assert.deepEqual(plain(h.calls.find((call) => call.name === "renumber_items")!.args), { responseDetail: "full", answerId: "ans_widget", expectedVersion: 2 });

    // A history listed for this answer is dropped when another answer is shown before it arrives.
    h.hold("list_revisions");
    await h.click("load-revisions");
    await h.show({ answerId: "ans_other" });
    await h.release("list_revisions");
    assert.equal(h.element("revisions").children.length, 0);

    // A write for one answer does not switch the view back after the host showed another.
    await h.show({ answerId: "ans_widget" });
    h.type("find", "前言");
    await h.click("preview-phrase");
    h.hold("edit_text");
    await h.click("apply-phrase");
    await h.show({ answerId: "ans_third" });
    await h.release("edit_text");
    assert.match(h.element("answer-id").textContent!, /ans_third/);
  } finally { h.dom.window.close(); }
});

test("restores are bound to the listed answer and version", async () => {
  const h = await host();
  try {
    h.type("find", "前言");
    await h.click("preview-phrase");
    await h.click("apply-phrase");
    await h.click("load-revisions");
    const restore = h.element("revisions").querySelector("button")!;
    await h.click(restore);
    assert.deepEqual(plain(h.calls.find((call) => call.name === "restore_revision")!.args), { responseDetail: "full", answerId: "ans_widget", version: 1, expectedVersion: 2 });
  } finally { h.dom.window.close(); }
});

test("after a write every control is usable again, and the section editor no longer blocks the panels", async () => {
  const h = await host();
  try {
    h.select("b");
    h.type("find", "技術");
    await h.click("preview-phrase");
    await h.click("apply-phrase");
    for (const id of ["section", "heading", "text", "preview-edit", "find", "move-up", "renumber"]) {
      assert.equal(h.element<HTMLButtonElement>(id).disabled, false, id);
    }
    // The original section editor: after its apply the new panels are enabled again.
    h.element<HTMLTextAreaElement>("text").value = "改寫的段落。";
    h.element("text").dispatchEvent(new h.dom.window.Event("input"));
    await h.click("preview-edit");
    await h.click("apply-edit");
    for (const id of ["find", "move-up", "move-down", "renumber", "load-revisions"]) {
      assert.equal(h.element<HTMLButtonElement>(id).disabled, false, id);
    }
  } finally { h.dom.window.close(); }
});

test("selection from an unsaved draft and a non-integer occurrence are refused", async () => {
  const h = await host();
  try {
    const text = h.element<HTMLTextAreaElement>("text");
    text.value = "草稿裡才有的字。";
    text.dispatchEvent(new h.dom.window.Event("input"));
    text.setSelectionRange(0, 2);
    await h.click("use-selection");
    assert.equal(h.element<HTMLInputElement>("find").value, "");
    assert.match(h.element("notice").textContent!, /尚未套用的修改/);

    h.type("find", "前言");
    h.type("occurrence", "1.5");
    await h.click("preview-phrase");
    assert.equal(h.calls.filter((call) => call.name === "preview_change").length, 0);
    assert.match(h.element("phrase-preview").textContent!, /正整數/);
    assert.equal(h.element<HTMLButtonElement>("apply-phrase").disabled, true);
  } finally { h.dom.window.close(); }
});

test("the section editor does not switch back either, and an answer without sections keeps editing off", async () => {
  const h = await host();
  try {
    h.element<HTMLTextAreaElement>("text").value = "改寫的段落。";
    h.element("text").dispatchEvent(new h.dom.window.Event("input"));
    await h.click("preview-edit");
    h.hold("replace_text");
    await h.click("apply-edit");
    await h.show({ answerId: "ans_other" });
    await h.release("replace_text");
    assert.match(h.element("answer-id").textContent!, /ans_other/);
    // The finished write of the other answer does not report on this one.
    assert.doesNotMatch(h.element("notice").textContent!, /修改已套用/);

    // A panel write that ends after the host showed an answer without sections leaves editing off.
    h.type("find", "前言");
    await h.click("preview-phrase");
    h.hold("edit_text");
    await h.click("apply-phrase");
    await h.show({ answerId: "ans_empty", empty: true });
    await h.release("edit_text");
    for (const id of ["heading", "text", "preview-edit", "move-up", "move-down"]) {
      assert.equal(h.element<HTMLButtonElement>(id).disabled, true, id);
    }
    assert.doesNotMatch(h.element("notice").textContent!, /已修改/);
    assert.equal(h.element("preview").textContent, "");
  } finally { h.dom.window.close(); }
});

test("disabled fields look disabled, and only a busy button shows the wait cursor", async () => {
  const h = await host({ readOnly: true });
  try {
    const style = (id: string) => h.dom.window.getComputedStyle(h.element(id));
    // A read-only view still lets the section menu choose; the fields that would change the answer do not.
    assert.equal(h.element<HTMLSelectElement>("section").disabled, false);
    for (const id of ["heading", "text", "find", "replace", "occurrence"]) {
      assert.equal(h.element<HTMLInputElement>(id).disabled, true, id);
      assert.notEqual(style(id).backgroundColor, style("section").backgroundColor, id);
      assert.equal(style(id).cursor, "not-allowed", id);
    }
    assert.equal(style("move-up").cursor, "not-allowed");
    h.hold("list_revisions");
    await h.click("load-revisions");
    assert.equal(style("load-revisions").cursor, "wait");
    await h.release("list_revisions");
    assert.equal(style("load-revisions").cursor, "pointer");
  } finally { h.dom.window.close(); }
});

test("a write whose redisplay fails still shows the saved version and says how to get the paper back", async () => {
  const h = await host();
  try {
    h.type("find", "前言");
    await h.click("preview-phrase");
    h.fail("render_answer_sheet");
    await h.click("apply-phrase");
    assert.equal(h.version, 2);
    // The view moves on to the saved version, so the next change is not refused as outdated.
    assert.equal(h.element("version").textContent, "版本：2");
    assert.equal(h.element<HTMLInputElement>("find").value, "");
    assert.match(h.element("notice").textContent!, /已修改 1 處.*模擬：畫板讀取失敗.*重新顯示/);
    assert.equal(h.element("notice").className, "notice error");
    assert.equal(h.element<HTMLButtonElement>("renumber").disabled, false);

    // The section editor's apply does the same, also when the render returns nothing to show.
    h.fail("render_answer_sheet", "empty");
    h.element<HTMLTextAreaElement>("text").value = "改寫的段落。";
    h.element("text").dispatchEvent(new h.dom.window.Event("input"));
    await h.click("preview-edit");
    await h.click("apply-edit");
    assert.deepEqual(plain(h.calls.find((call) => call.name === "replace_text")!.args.expectedVersion), 2);
    assert.equal(h.element("version").textContent, "版本：3");
    assert.match(h.element("notice").textContent!, /修改已套用.*重新顯示/);

    // A panel write whose render returns nothing is not reported as a plain success either.
    await h.click("renumber");
    await h.click("renumber");
    assert.equal(h.element("version").textContent, "版本：4");
    assert.match(h.element("notice").textContent!, /已重新編號 2 處.*重新顯示/);

    // Once the host renders again, the refresh brings the paper back.
    h.fail("render_answer_sheet", null);
    await h.click("refresh");
    assert.match(h.element("notice").textContent!, /已載入畫板/);
  } finally { h.dom.window.close(); }
});

test("the original paper is shown cropped to its printed area; a page without the paper image keeps its own view box", async () => {
  const page = (image: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595.3 841.9">${image}<g data-section-id="a"><rect x="130" y="100" width="300" height="20" fill="none"/></g></svg>`;
  const h = await host({ svgPages: [page('<image href="data:," x="60" y="50" width="480" height="700"/>'), page("")] });
  try {
    const boxes = [...h.dom.window.document.querySelectorAll(".original-paper svg")].map((svg) => svg.getAttribute("viewBox"));
    assert.deepEqual(boxes, ["52 42 496 716", "0 0 595.3 841.9"]);
    // The cropped page still selects its section.
    h.dom.window.document.querySelector(".original-paper g[data-section-id='a']")!.dispatchEvent(new h.dom.window.MouseEvent("click", { bubbles: true }));
    await tick();
    assert.equal(h.element<HTMLSelectElement>("section").value, "a");
  } finally { h.dom.window.close(); }
});

test("exam tabs keep labels, selection, focus, writes and host navigation in sync", async () => {
  for (const legacy of [true, false]) {
    const h = await host({ overview: true, legacy });
    try {
      const tabs = () => [...h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      assert.equal(h.element("exam-tabs").hidden, false);
      assert.equal(h.element("exam-tabs").getAttribute("role"), "tablist");
      assert.equal(h.element("exam-tabs").getAttribute("aria-label"), "考試題目");
      assert.equal(tabs().length, 3);
      assert.match(tabs()[0].textContent!, /第4題 測試.*6\/44 行/);
      assert.match(tabs()[1].textContent!, /第2題 第二份.*45\/44 行.*超出 1 行.*警告 2/);
      assert.deepEqual(tabs().map(tab => tab.getAttribute("aria-selected")), ["true", "false", "false"]);
      assert.deepEqual(tabs().map(tab => tab.tabIndex), [0, -1, -1]);
      assert.equal(tabs()[0].getAttribute("aria-controls"), "pages");
      tabs()[0].focus();
      tabs()[0].dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      assert.equal(h.dom.window.document.activeElement, tabs()[1]);
      assert.deepEqual(tabs().map(tab => tab.tabIndex), [-1, 0, -1]);
      tabs()[1].dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      assert.equal(h.dom.window.document.activeElement, tabs()[0]);
      tabs()[0].dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      assert.equal(h.dom.window.document.activeElement, tabs()[2]);
      await h.click(tabs()[1]);
      assert.deepEqual(plain(h.calls.at(-1)), { name: "render_answer_sheet", args: { answerId: "ans_second", responseDetail: "full" } });
      assert.match(h.element("answer-id").textContent!, /ans_second/);
      assert.equal(h.element("answer-title").textContent, "第二份");
      assert.equal(tabs().length, 3);
      assert.deepEqual(tabs().map(tab => tab.getAttribute("aria-selected")), ["false", "true", "false"]);
      assert.equal(h.element("pages").getAttribute("aria-labelledby"), tabs()[1].id);
      assert.match(tabs()[1].textContent!, /6\/44 行/);
      assert.doesNotMatch(tabs()[1].textContent!, /超出/);
      h.type("text", Array(41).fill("新論述").join("\n"));
      await h.click("preview-edit"); await h.click("apply-edit");
      assert.equal(tabs()[1].dataset.version, "2");
      assert.match(tabs()[1].textContent!, /46\/44 行.*超出 2 行/);
      assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
      await h.show({ answerId: "ans_widget" });
      assert.equal(tabs().length, 3); assert.equal(tabs()[0].getAttribute("aria-selected"), "true");
      await h.show({ answerId: "ans_outside", summary: true, globals: legacy });
      assert.equal(h.element("exam-tabs").hidden, true); assert.equal(tabs().length, 0);
      assert.equal(h.element("pages").getAttribute("role"), null);
      assert.deepEqual(h.errors, []);
    } finally { h.dom.window.close(); }
  }
});

test("slow or failed exam tab loads cannot overwrite a later tab or host output", async () => {
  const h = await host({ overview: true });
  try {
    const tabs = () => [...h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    h.hold("render_answer_sheet"); await h.click(tabs()[1]);
    await h.click(tabs()[2]); await h.release("render_answer_sheet");
    assert.match(h.element("answer-id").textContent!, /ans_third/);
    assert.deepEqual(tabs().map(tab => tab.getAttribute("aria-selected")), ["false", "false", "true"]);
    assert.doesNotMatch(h.element("notice").textContent!, /再按一次題目分頁/);
    h.fail("render_answer_sheet"); await h.click(tabs()[1]);
    assert.match(h.element("notice").textContent!, /畫板讀取失敗/);
    assert.equal(h.element("notice").className, "notice error");
    assert.match(h.element("answer-id").textContent!, /ans_third/);
    h.fail("render_answer_sheet", null);
    h.hold("render_answer_sheet"); await h.click(tabs()[0]);
    await h.show({ answerId: "ans_outside" }); await h.release("render_answer_sheet");
    assert.match(h.element("answer-id").textContent!, /ans_outside/);
    assert.equal(h.element("exam-tabs").hidden, true);
    assert.match(h.element("notice").textContent!, /畫板已更新.*再按一次題目分頁/);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

test("exam tabs fall back to the selected tab when the focused answer disappears", async () => {
  const h = await host({ overview: true });
  try {
    const tabs = () => [...h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    tabs()[1].focus();
    await h.show({ overviewIds: ["ans_widget", "ans_third"] });
    assert.deepEqual(tabs().map(tab => tab.dataset.answerId), ["ans_widget", "ans_third"]);
    assert.deepEqual(tabs().map(tab => tab.tabIndex), [0, -1]);
    assert.equal(tabs()[0].getAttribute("aria-selected"), "true");
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

test("exam tab labels separate titles, status and accessible warnings; clicking the active tab keeps the draft", async () => {
  const h = await host({ overview: true });
  try {
    const tabs = [...h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.equal(tabs[1].getAttribute("aria-label"), "第2題 第二份，45/44 行，超出 1 行，警告 2");
    assert.equal(tabs[2].textContent, "第3題 第三份3 3/44 行");
    assert.equal(tabs[2].getAttribute("aria-label"), "第3題 第三份3，3/44 行");
    h.type("text", "尚未儲存的草稿");
    const calls = h.calls.length;
    await h.click(tabs[0]);
    assert.equal(h.calls.length, calls);
    assert.equal(h.element<HTMLTextAreaElement>("text").value, "尚未儲存的草稿");
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

test("active exam tab warnings update after a write and disappear when redisplay cannot confirm them", async () => {
  for (const failedRender of [false, true]) {
    const h = await host({ overview: true, warnings: true });
    try {
      const active = () => h.element("exam-tabs").querySelector('[aria-selected="true"]')!;
      assert.match(active().textContent!, /警告 1/);
      h.type("find", "建置"); h.type("replace", "推廣");
      await h.click("preview-phrase");
      if (failedRender) h.fail("render_answer_sheet");
      await h.click("apply-phrase");
      assert.equal(active().getAttribute("data-version"), "2");
      assert.doesNotMatch(active().textContent!, /警告/);
      assert.doesNotMatch(active().getAttribute("aria-label")!, /警告/);
      assert.deepEqual(h.errors, []);
    } finally { h.dom.window.close(); }
  }
});

test("a tab load superseded by refresh shows a notice without retrying", async () => {
  const h = await host({ overview: true });
  try {
    const tabs = () => [...h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    h.hold("render_answer_sheet"); await h.click(tabs()[1]);
    await h.click("refresh");
    const calls = h.calls.length;
    await h.release("render_answer_sheet");
    assert.equal(h.calls.length, calls);
    assert.match(h.element("answer-id").textContent!, /ans_widget/);
    assert.match(h.element("notice").textContent!, /畫板已更新.*再按一次題目分頁/);
    assert.equal(h.element("notice").className, "notice");
    await h.click(tabs()[1]);
    assert.match(h.element("answer-id").textContent!, /ans_second/);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

test("writes that finish after switching tabs update the inactive tab from their full snapshot", async () => {
  for (const name of ["replace_text", "edit_text"]) {
    const h = await host({ overview: true });
    try {
      const tabs = () => [...h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      const overflow = Array(41).fill("新論述").join("\n");
      if (name === "replace_text") {
        h.type("text", overflow); await h.click("preview-edit");
      } else {
        h.type("find", h.sections[0].text); h.type("replace", "X".repeat(41 * 38)); await h.click("preview-phrase");
      }
      h.hold(name); await h.click(name === "replace_text" ? "apply-edit" : "apply-phrase");
      await h.click(tabs()[1]);
      h.type("text", "第二題尚未儲存的草稿");
      // A failed redisplay proves the inactive statistics came from the full write response.
      h.fail("render_answer_sheet");
      await h.release(name);
      assert.equal(h.calls.find(call => call.name === name)!.args.responseDetail, "full");
      assert.equal(tabs()[0].dataset.version, "2");
      assert.match(tabs()[0].textContent!, /46\/44 行.*超出 2 行/);
      assert.equal(tabs()[0].getAttribute("aria-selected"), "false");
      assert.equal(tabs()[1].getAttribute("aria-selected"), "true");
      assert.equal(h.element("version").textContent, "版本：1");
      assert.match(h.element("answer-id").textContent!, /ans_second/);
      assert.equal(h.element<HTMLTextAreaElement>("text").value, "第二題尚未儲存的草稿");
      assert.deepEqual(h.errors, []);
    } finally { h.dom.window.close(); }
  }
});

for (const legacy of [false, true]) test(`overview tabs render metadata snapshots via ${legacy ? "OpenAI" : "MCP Apps"}`, async () => {
  const h = await host({ overview: true, metadata: true, legacy });
  try {
    const tabs = () => [...h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    assert.equal(tabs().length, 3); assert.equal(h.calls.length, 0);
    assert.ok(h.dom.window.document.querySelectorAll('.line-text').length > 0);
    await h.click(tabs()[1]); assert.match(h.element("answer-id").textContent!, /ans_second/);
    assert.equal(h.calls.filter(call => call.name === "render_answer_sheet").length, 1);
    await h.show({ answerId: "ans_widget", bump: true, globals: legacy });
    assert.equal(h.element("version").textContent, "版本：2");
    assert.match(h.element("answer-id").textContent!, /ans_widget/);
    assert.equal(h.calls.filter(call => call.name === "render_answer_sheet").length, 1);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});


for (const legacy of [true, false]) test(`${legacy ? "OpenAI" : "MCP Apps"} callTool without metadata renders tab switches and edit_text versions from full structuredContent`, async () => {
  const h = await host({ legacy, overview: true, metadata: true, noCallMeta: true });
  try {
    await h.click(h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]);
    assert.match(h.element("answer-id").textContent!, /ans_second/);
    assert.equal(h.element("version").textContent, "版本：1");
    assert.equal(h.element<HTMLTextAreaElement>("text").disabled, false);
    h.type("find", "建置"); h.type("replace", "推廣");
    await h.click("preview-phrase"); await h.click("apply-phrase");
    assert.equal(h.calls.filter(call => call.name === "edit_text").length, 1);
    assert.match(h.element("answer-id").textContent!, /ans_second/);
    assert.equal(h.element("version").textContent, "版本：2");
    assert.match(h.element("pages").textContent!, /推廣/);
    assert.doesNotMatch(h.element("pages").textContent!, /建置/);
    assert.equal(h.calls.filter(call => call.name === "render_answer_sheet").length, 2);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

for (const legacy of [true, false]) for (const readOnly of [false, true])
  test(`${legacy ? "OpenAI" : "MCP Apps"} initial summary renders without metadata and preserves ${readOnly ? "reader" : "writer"} permissions`, async () => {
    const h = await host({ legacy, readOnly, summary: true, noCallMeta: true });
    try {
      assert.equal(h.calls.filter(call => call.name === "render_answer_sheet").length, 1);
      assert.equal(h.element<HTMLTextAreaElement>("text").disabled, readOnly);
      h.type("find", "建置"); h.type("replace", "推廣");
      assert.equal(h.element<HTMLButtonElement>("preview-phrase").disabled, readOnly);
      await h.click("preview-phrase"); await h.click("apply-phrase");
      assert.equal(h.calls.filter(call => call.name === "edit_text").length, readOnly ? 0 : 1);
      assert.equal(h.element("version").textContent, readOnly ? "版本：1" : "版本：2");
      assert.equal(h.element<HTMLTextAreaElement>("text").disabled, readOnly);
      if (!readOnly) assert.match(h.element("pages").textContent!, /推廣/);
      assert.deepEqual(h.errors, []);
    } finally { h.dom.window.close(); }
  });

test("readOnly prefers result metadata, then structured content, and inherits state only for the same answer", async () => {
  const h = await host({ legacy: true });
  try {
    const output = async (answerId: string, readOnly?: boolean, directReadOnly?: boolean, hostReadOnly?: boolean) => {
      const structuredContent = { ...h.snapshot(answerId), ...(readOnly === undefined ? {} : { readOnly }) };
      if (hostReadOnly !== undefined) h.dom.window.dispatchEvent(new h.dom.window.CustomEvent("openai:set_globals", {
        detail: { globals: { toolOutput: structuredContent, toolResponseMetadata: { snapshot: structuredContent, readOnly: hostReadOnly } } },
      }));
      else h.dom.window.dispatchEvent(new h.dom.window.MessageEvent("message", { source: h.dom.window.parent, origin: "https://host.test",
        data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent,
          ...(directReadOnly === undefined ? {} : { _meta: { readOnly: directReadOnly } }) } } }));
      for (let i = 0; i < 4; i++) await tick();
    };
    const disabled = () => h.element<HTMLTextAreaElement>("text").disabled;
    await output("ans_widget", false, true); assert.equal(disabled(), true);
    await output("ans_widget", true, false); assert.equal(disabled(), false);
    await output("ans_widget", undefined, undefined, true); assert.equal(disabled(), false);
    await output("ans_other"); assert.equal(disabled(), true);
    await output("ans_other", false, undefined, true); assert.equal(disabled(), false);
    await output("ans_other"); assert.equal(disabled(), false);
    await output("ans_third", undefined, undefined, false); assert.equal(disabled(), true);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

test("OpenAI full render keeps 166 SVG pages without metadata, only for the same answer and version", async () => {
  const svgPages = [1, 2].map(page => `<svg xmlns="http://www.w3.org/2000/svg" data-paper="166-${page}"><g data-section-id="a"><path d="M0 0"/></g></svg>`);
  const h = await host({ legacy: true, overview: true, metadata: true, noCallMeta: true, svgPages });
  try {
    const papers = () => h.dom.window.document.querySelectorAll('.original-paper svg[data-paper^="166-"]');
    assert.equal(papers().length, 2);
    await h.click("refresh"); assert.equal(papers().length, 2);
    h.omitPages(); await h.click("refresh"); assert.equal(papers().length, 2);
    // A different answer cannot inherit the previous answer's original paper.
    await h.click(h.element("exam-tabs").querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]);
    assert.equal(papers().length, 0);
    assert.match(h.element("answer-id").textContent!, /ans_second/);
    await h.show({ answerId: "ans_widget", globals: true, full: true }); assert.equal(papers().length, 2);
    h.type("find", "建置"); h.type("replace", "推廣");
    await h.click("preview-phrase"); await h.click("apply-phrase");
    assert.equal(h.element("version").textContent, "版本：2");
    assert.equal(papers().length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

for (const metadata of ["missing", "stale"] as const) test(`set_globals ignores ${metadata} metadata for another answer or version`, async () => {
  const h = await host({ legacy: true, metadata: true, noCallMeta: true });
  try {
    h.hold("render_answer_sheet");
    await h.show({ answerId: "ans_second", summary: true, globals: true, metadata, bodyText: "B 的獨立論述。" });
    assert.match(h.element("answer-id").textContent!, /ans_widget/);
    assert.equal(h.calls.filter(call => call.name === "render_answer_sheet").length, 1);
    await h.release("render_answer_sheet");
    assert.match(h.element("answer-id").textContent!, /ans_second/);
    assert.match(h.element("pages").textContent!, /B 的獨立論述/);
    assert.doesNotMatch(h.element("pages").textContent!, /政府建置/);
    await h.show({ answerId: "ans_widget", bump: true, summary: true, globals: true, metadata });
    assert.equal(h.element("version").textContent, "版本：2");
    assert.equal(h.calls.filter(call => call.name === "render_answer_sheet").length, 2);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});


test("set_globals prefers full B content over stale A metadata without reloading", async () => {
  const h = await host({ legacy: true, metadata: true, noCallMeta: true });
  try {
    const metadata = (h.dom.window as unknown as { openai: { toolResponseMetadata: { snapshot: { answer: { id: string; sections: Array<{ text: string }> }; layout: { lines: Array<{ text: string }> } } } } }).openai.toolResponseMetadata;
    const next = plain(metadata.snapshot);
    next.answer.id = "ans_fullB";
    next.answer.sections[0].text = "B 的完整論述。";
    next.layout.lines[1].text = "B 的完整論述。";
    h.dom.window.dispatchEvent(new h.dom.window.CustomEvent("openai:set_globals", { detail: { globals: { toolOutput: next, toolResponseMetadata: metadata } } }));
    await tick();
    assert.match(h.element("answer-id").textContent!, /ans_fullB/);
    assert.match(h.element("pages").textContent!, /B 的完整論述/);
    assert.doesNotMatch(h.element("pages").textContent!, /政府建置/);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.errors, []);
  } finally { h.dom.window.close(); }
});

for (const legacy of [false, true]) for (const readOnly of [false, true]) test(`exam status updates in ${legacy ? "OpenAI" : "MCP Apps"}, no call metadata, readOnly=${readOnly}`, async () => {
  const h = await host({ legacy, readOnly, examPlan: true, noCallMeta: true });
  try {
    const status = h.element("exam-progress");
    assert.equal(status.hidden, false); assert.equal(status.getAttribute("role"), "status"); assert.equal(status.getAttribute("aria-live"), "polite");
    assert.equal(h.dom.window.document.querySelectorAll("#exam-progress").length, 1);
    assert.match(status.textContent!, /第1題：已匯出.*第2題：未建立.*從第2題接續/);
    assert.match(h.element("exam-tabs").textContent!, /未建立/);
    assert.ok(h.calls.some(c => c.name === "get_exam_progress"));
    if (readOnly) {
      assert.equal(h.element<HTMLButtonElement>("preview-phrase").disabled, true);
      await h.click("apply-phrase"); assert.equal(h.calls.some(c => c.name === "edit_text"), false);
    } else {
      h.type("find", "建置"); h.type("replace", "導入"); await h.click("preview-phrase"); await h.click("apply-phrase");
      assert.equal(h.version, 2); assert.equal(h.element("exam-progress"), status);
      assert.match(status.textContent!, /第1題：版面通過.*從第2題接續/);
      assert.doesNotMatch(status.textContent!, /[%％]|答案已查證/);
    }
  } finally { h.dom.window.close(); }
});
for (const legacy of [false, true]) test(`all-missing exam overview via ${legacy ? "OpenAI" : "MCP Apps"} keeps progress and tabs`, async () => {
  const h = await host({ legacy, examPlan: true, emptyPlan: true, noCallMeta: true });
  try { assert.match(h.element("exam-progress").textContent!, /未建立/); assert.equal(h.element("exam-tabs").children.length, 2);
    assert.equal(h.element<HTMLButtonElement>("preview-phrase").disabled, true);
  } finally { h.dom.window.close(); }
});
