// Bump the version whenever the widget's markup or the tools it calls change: hosts cache the template by URI.
export const ANSWER_SHEET_WIDGET_URI = "ui://widget/police-essay-answer-sheet-v11.html";

export const POLICE_ESSAY_WIDGET_HTML = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root {
      color-scheme: light;
      --canvas: #f4f6fa;
      --surface: #ffffff;
      --surface-sunk: #f7f9fc;
      --ink: #111a2e;
      --ink-2: #2f3b50;
      --muted: #4f5b6e;
      --faint: #626c7f;
      --line: #e1e6ee;
      --line-strong: #c7cfdb;
      --accent: #2557d6;
      --accent-ink: #1c45ad;
      --accent-soft: #ebf1fe;
      --ok: #157046;
      --ok-soft: #e9f7ef;
      --bad: #b42318;
      --bad-soft: #fdefed;
      --radius: 12px;
      --radius-sm: 8px;
      --shadow: 0 1px 2px rgba(17, 26, 46, .04), 0 10px 24px -14px rgba(17, 26, 46, .16);
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", sans-serif;
      font-size: 14px;
      line-height: 1.5;
      background: var(--canvas);
      color: var(--ink);
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--canvas); }
    ::selection { background: #cddbfb; color: var(--ink); }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button, input, textarea, select { font: inherit; }
    button { display: inline-flex; align-items: center; justify-content: center; min-height: 34px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink-2); font-size: 13px; font-weight: 500; line-height: 1.2; white-space: nowrap; cursor: pointer; transition: background-color .15s ease, border-color .15s ease, color .15s ease; }
    button:hover:not(:disabled) { border-color: #97a3b6; background: var(--surface-sunk); color: var(--ink); }
    button:active:not(:disabled) { background: #edf1f6; }
    button:disabled { cursor: not-allowed; border-color: var(--line); background: var(--surface-sunk); color: #9aa3b2; }
    button[aria-busy="true"] { cursor: wait; }
    .primary { border-color: var(--accent); background: var(--accent); color: #fff; }
    .primary:hover:not(:disabled) { border-color: var(--accent-ink); background: var(--accent-ink); color: #fff; }
    .primary:active:not(:disabled) { background: var(--accent-ink); }
    .primary:disabled { border-color: #dfe4ec; background: #e9edf3; color: #9aa3b2; }
    .app { max-width: 1120px; margin: 0 auto; padding: 20px 20px 24px; }
    .topbar { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: 12px 20px; margin-bottom: 12px; }
    .headline { flex: 1 1 260px; min-width: 0; }
    h1 { margin: 0; font-size: 20px; font-weight: 700; line-height: 1.3; letter-spacing: -.01em; }
    .subtitle { margin-top: 2px; color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; margin-bottom: 10px; color: var(--muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
    .status { display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; padding: 3px 10px 3px 9px; background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
    .status::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
    .status.ok { background: var(--ok-soft); color: var(--ok); }
    .status.overflow { background: var(--bad-soft); color: var(--bad); }
    .capacity { display: inline-flex; align-items: center; gap: 8px; }
    .meter { position: relative; width: 88px; height: 6px; overflow: hidden; border-radius: 999px; background: #e2e7ef; }
    .meter > span { position: absolute; inset: 0; background: var(--accent); transform: scaleX(0); transform-origin: left center; transition: transform .25s cubic-bezier(.2, .8, .2, 1); }
    .meter.full > span { background: var(--bad); }
    .chip { white-space: nowrap; }
    .chip.id { min-width: 0; max-width: 100%; white-space: normal; overflow-wrap: anywhere; color: var(--faint); font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
    .notice { min-height: 20px; margin: 0 0 12px; color: var(--muted); font-size: 13px; }
    .notice.error { padding: 9px 12px; border-radius: var(--radius-sm); background: var(--bad-soft); color: var(--bad); }
    .exam-tabs { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; margin-bottom: 12px; }
    .exam-tabs[hidden] { display: none; }
    .exam-tabs button { flex: 0 1 auto; max-width: 100%; padding: 7px 10px; white-space: normal; overflow-wrap: anywhere; gap: 6px; }
    .exam-tabs button[aria-selected="true"] { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-ink); }
    .exam-tabs .tab-status { color: var(--muted); font-size: 12px; }
    .exam-tabs .tab-status.warning { color: var(--bad); }
    .sheet-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 385px), 1fr)); gap: 16px; align-items: start; }
    .sheet-grid:has(.paper-body) { grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr)); }
    .paper { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
    .paper.overflow { border-color: #f1b8b1; }
    .paper-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 9px 14px; border-bottom: 1px solid var(--line); }
    .paper-title { font-size: 13px; font-weight: 600; }
    .paper-caption { color: var(--faint); font-size: 12px; font-variant-numeric: tabular-nums; }
    .original-paper { padding: 10px; }
    .original-paper svg { display: block; width: 100%; height: auto; }
    .original-paper g[data-section-id] { cursor: pointer; }
    .original-paper g[data-section-id] rect { transition: fill .15s ease; }
    .original-paper g[data-section-id]:hover rect { fill: rgba(37, 87, 214, .06); }
    .original-paper g.selected { fill: var(--accent-ink); }
    .original-paper g.selected rect { fill: rgba(37, 87, 214, .11); }
    .original-paper g:focus { outline: none; }
    .original-paper g:focus-visible rect { stroke: var(--accent); stroke-width: 1.2; }
    .paper-body { display: grid; justify-content: center; padding: 10px 12px 14px; }
    .answer-line { display: grid; grid-template-columns: 28px auto; border-radius: 4px; color: var(--ink-2); }
    .answer-line:not([data-section-id=""]) { cursor: pointer; }
    .answer-line:not([data-section-id=""]):hover, .answer-line.selected { background: var(--accent-soft); }
    .line-number { display: flex; align-items: center; justify-content: flex-end; padding-right: 7px; color: var(--faint); font-size: 10px; font-variant-numeric: tabular-nums; user-select: none; }
    /* One full-width character spans two layout columns, so each drawn cell holds one character. */
    .line-cells { --columns: 42; position: relative; width: calc(var(--columns) * .5em); border-bottom: 1px solid var(--line); background-image: repeating-linear-gradient(to right, transparent 0, transparent calc(200% / var(--columns) - 1px), rgba(148, 163, 184, .28) calc(200% / var(--columns) - 1px), rgba(148, 163, 184, .28) calc(200% / var(--columns))); font-size: 13px; }
    /* Half-width letters are not exactly half a character wide in every fallback font; fitGridLines condenses such a line to its cells. */
    .line-text { display: block; overflow: visible; min-height: 26px; padding: 0; white-space: pre; font-family: "Noto Sans Mono CJK TC", "Microsoft JhengHei", ui-monospace, monospace; line-height: 26px; transform-origin: left center; }
    .answer-line.heading .line-text { color: #172554; }
    .answer-line.bold .line-text { font-weight: 800; }
    .answer-line.italic .line-text { font-style: italic; }
    .answer-line.spacer .line-text { min-height: 26px; }
    .workbench { margin-top: 16px; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); box-shadow: var(--shadow); }
    .editor { padding: 16px 18px 18px; }
    .editor + .editor { border-top: 1px solid var(--line); }
    .editor-head { margin-bottom: 12px; }
    .editor-title { color: var(--ink); font-size: 14px; font-weight: 650; }
    .editor-help { margin-top: 2px; color: var(--muted); font-size: 12px; line-height: 1.55; }
    .editor-grid { display: grid; grid-template-columns: minmax(180px, .38fr) minmax(0, 1fr); gap: 12px 14px; }
    .field { display: flex; flex-direction: column; gap: 6px; }
    .field label { color: var(--ink-2); font-size: 12px; font-weight: 600; }
    .field label:not(:first-child) { margin-top: 6px; }
    select, input, textarea { width: 100%; min-height: 36px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); background: var(--surface); color: var(--ink); padding: 7px 10px; caret-color: var(--accent); transition: border-color .15s ease; }
    select:hover:not(:disabled), input:hover:not(:disabled), textarea:hover:not(:disabled) { border-color: #97a3b6; }
    select:focus-visible, input:focus-visible, textarea:focus-visible { border-color: var(--accent); outline-offset: 0; }
    select:disabled, input:disabled, textarea:disabled { border-color: #e2e8f0; background: #f1f5f9; color: #64748b; cursor: not-allowed; }
    textarea { min-height: 132px; resize: vertical; line-height: 1.65; }
    .preview { margin: 0; color: var(--muted); font-size: 12.5px; }
    .preview:not(:empty) { margin-top: 12px; padding: 8px 11px; border-radius: var(--radius-sm); background: var(--surface-sunk); }
    .preview.good:not(:empty) { background: var(--ok-soft); color: var(--ok); }
    .preview.bad:not(:empty) { background: var(--bad-soft); color: var(--bad); }
    .editor-actions { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 12px; margin-top: 12px; }
    .editor-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
    .editor-head + .preview:not(:empty) { margin: 0 0 12px; }
    .empty { grid-column: 1 / -1; border: 1px dashed var(--line-strong); border-radius: var(--radius); background: var(--surface); color: var(--muted); padding: 40px 20px; text-align: center; }
    .phrase-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 14px; }
    .phrase-options { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; color: var(--ink-2); font-size: 13px; }
    .phrase-options label { display: inline-flex; align-items: center; gap: 6px; }
    .phrase-options input[type="number"] { width: 4.5em; min-height: 32px; padding: 4px 6px; }
    .phrase-options input[type="checkbox"] { width: 16px; height: 16px; min-height: 0; margin: 0; accent-color: var(--accent); }
    .revisions { margin: 12px 0 0; padding: 0; list-style: none; }
    .revisions:empty { margin: 0; }
    .revisions li { padding: 10px 0; border-top: 1px solid var(--line); }
    .revisions li:last-child { padding-bottom: 0; }
    .revision-head { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 2px; }
    .revision-head .chip { padding: 1px 8px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-ink); font-size: 12px; font-weight: 600; }
    .revision-head button { min-height: 30px; margin-left: auto; padding: 0 10px; font-size: 12.5px; }
    @media (max-width: 360px) {
      .answer-line { grid-template-columns: 24px auto; }
      .line-cells { font-size: 11.5px; }
    }
    @media (max-width: 620px) {
      .app { padding: 14px 12px 20px; }
      h1 { font-size: 18px; }
      .actions { width: 100%; }
      .actions button { flex: 1 1 0; padding: 0 8px; }
      .editor { padding: 14px; }
      .editor-grid, .phrase-grid { grid-template-columns: 1fr; }
      .editor-actions { align-items: stretch; flex-direction: column; }
      .editor-actions .editor-buttons { justify-content: flex-end; }
    }
  </style>
</head>
<body>
  <main class="app" id="app">
    <header class="topbar">
      <div class="headline">
        <h1>警察資訊三等・申論答題紙</h1>
        <div class="subtitle" id="answer-title">等待答題紙資料…</div>
      </div>
      <div class="actions">
        <button id="refresh" type="button">重新顯示</button>
        <button id="check" type="button">重新檢查版面</button>
        <button id="fullscreen" type="button">放大畫板</button>
      </div>
    </header>
    <div class="meta">
      <span class="status" id="status">等待資料</span>
      <span class="capacity">
        <span class="meter" id="meter" aria-hidden="true"><span></span></span>
        <span class="chip" id="usage">用量：—</span>
        <span class="chip" id="remaining">剩餘：—</span>
      </span>
      <span class="chip" id="version">版本：—</span>
      <span class="chip id" id="answer-id">答案：—</span>
    </div>
    <p class="notice" id="notice" role="status"></p>
    <div class="exam-tabs" id="exam-tabs" role="tablist" aria-label="考試題目" hidden></div>
    <section class="sheet-grid" id="pages" aria-label="申論答題紙畫板">
      <div class="empty">請在對話中要求 Police Essay MCP 建立或載入答案，畫板會在這裡顯示。</div>
    </section>
    <div class="workbench">
      <section class="editor" aria-label="答題區塊編輯器">
        <div class="editor-head">
          <div class="editor-title">區塊快速編輯</div>
          <div class="editor-help">先預覽，再套用；套用時會以目前版本避免覆蓋新內容。</div>
        </div>
        <div class="editor-grid">
          <div class="field">
            <label for="section">選擇區塊</label>
            <select id="section" disabled><option>尚無可編輯區塊</option></select>
            <label for="heading">標題</label>
            <input id="heading" type="text" placeholder="可留白" disabled>
          </div>
          <div class="field">
            <label for="text">文字</label>
            <textarea id="text" placeholder="選擇區塊後編輯文字" disabled></textarea>
          </div>
        </div>
        <p class="preview" id="preview" aria-live="polite"></p>
        <div class="editor-actions">
          <span class="editor-help" id="count"></span>
          <div class="editor-buttons">
            <button id="preview-edit" type="button" disabled>預覽變更</button>
            <button class="primary" id="apply-edit" type="button" disabled>套用修改</button>
          </div>
        </div>
      </section>
      <section class="editor" aria-label="字句修改">
        <div class="editor-head">
          <div class="editor-title">字句修改</div>
          <div class="editor-help">只改指定的字句，其他內容不動；同一段字出現多次時，指定第幾處或全部取代。</div>
        </div>
        <div class="phrase-grid">
          <div class="field">
            <label for="find">找（原文，一字不差）</label>
            <input id="find" type="text" disabled>
          </div>
          <div class="field">
            <label for="replace">換成（留空＝刪除）</label>
            <input id="replace" type="text" disabled>
          </div>
        </div>
        <p class="preview" id="phrase-preview" aria-live="polite"></p>
        <div class="editor-actions">
          <div class="phrase-options">
            <label>只改第 <input id="occurrence" type="number" min="1" disabled> 處</label>
            <label><input id="replace-all" type="checkbox" disabled> 全部取代</label>
            <button id="use-selection" type="button" disabled>帶入上方選取的文字</button>
          </div>
          <div class="editor-buttons">
            <button id="preview-phrase" type="button" disabled>預覽</button>
            <button class="primary" id="apply-phrase" type="button" disabled>套用</button>
          </div>
        </div>
      </section>
      <section class="editor" aria-label="區塊順序、編號與版本">
        <div class="editor-head">
          <div class="editor-title">區塊順序、編號與版本</div>
          <div class="editor-help">搬移目前選取的區塊；重新編號先預覽，再按一次確認；每一版都可以還原，還原會另存新版本。</div>
        </div>
        <p class="preview" id="tools-preview" aria-live="polite"></p>
        <div class="editor-buttons wrap">
          <button id="move-up" type="button" disabled>上移區塊</button>
          <button id="move-down" type="button" disabled>下移區塊</button>
          <button id="renumber" type="button" disabled>重新編號</button>
          <button id="load-revisions" type="button" disabled>版本紀錄</button>
        </div>
        <ol class="revisions" id="revisions" aria-label="版本紀錄"></ol>
      </section>
    </div>
  </main>
  <script>
    (() => {
      const pending = new Map();
      let nextId = 1;
      let state = null;
      let selectedSectionId = "";
      let pendingEdit = null;
      let editEpoch = 0;
      let applying = false;
      let hostOrigin;

      const byId = (id) => document.getElementById(id);
      const pages = byId("pages");
      const title = byId("answer-title");
      const status = byId("status");
      const notice = byId("notice");
      const sectionSelect = byId("section");
      const headingInput = byId("heading");
      const textInput = byId("text");
      const previewText = byId("preview");
      const count = byId("count");
      const previewButton = byId("preview-edit");
      const applyButton = byId("apply-edit");
      const findInput = byId("find");
      const replaceInput = byId("replace");
      const occurrenceInput = byId("occurrence");
      const replaceAllInput = byId("replace-all");
      const useSelectionButton = byId("use-selection");
      const phrasePreviewButton = byId("preview-phrase");
      const phraseApplyButton = byId("apply-phrase");
      const phrasePreviewText = byId("phrase-preview");
      const toolsText = byId("tools-preview");
      const moveUpButton = byId("move-up");
      const moveDownButton = byId("move-down");
      const renumberButton = byId("renumber");
      const revisionsButton = byId("load-revisions");
      const revisionList = byId("revisions");
      let pendingPhrase = null;
      let phraseEpoch = 0;
      let renumberArmed = false;
      let renumberArgs = null;
      let snapshotEpoch = 0;
      let hostOutputEpoch = 0;
      let latestTabEpoch = 0;
      let examAnswers = [];
      const examTabs = byId("exam-tabs");

      function noticeFor(answerId, message, isError) {
        if (state?.answer.id === answerId) setNotice(message, isError);
      }

      function setNotice(message, isError) {
        notice.textContent = message || "";
        notice.className = isError ? "notice error" : "notice";
      }

      function setBusy(button, busy) {
        button.disabled = busy;
        if (busy) button.setAttribute("aria-busy", "true");
        else button.removeAttribute("aria-busy");
        if (busy) button.dataset.previousText = button.textContent || "";
        if (busy) button.textContent = "處理中…";
        else if (button.dataset.previousText) button.textContent = button.dataset.previousText;
      }

      function sameAnswer(left, right) {
        return Boolean(left?.answer?.id && right?.answer?.id) && left.answer.id === right.answer.id && left.answer.version === right.answer.version;
      }

      function extract(value, hostMeta, initialHost = false) {
        const candidate = value && (value.structuredContent || value.result?.structuredContent || value);
        const directMeta = value?._meta || value?.result?._meta || {};
        const full = snapshot => snapshot?.answer && Array.isArray(snapshot.layout?.lines);
        const matches = snapshot => full(snapshot) && sameAnswer(snapshot, candidate);
        const meta = sameAnswer(hostMeta?.snapshot, candidate) || (initialHost && hostMeta && !hostMeta.snapshot) ? hostMeta : {};
        const snapshot = matches(directMeta.snapshot) ? directMeta.snapshot : full(candidate) ? candidate : matches(meta.snapshot) ? meta.snapshot : null;
        if (!snapshot) return null;
        return { ...candidate, ...snapshot,
          readOnly: directMeta.readOnly ?? candidate.readOnly ?? (initialHost ? meta.readOnly : undefined)
            ?? (state?.answer.id === snapshot.answer.id ? state.readOnly : undefined) ?? true,
          paperSvgPages: directMeta.paperSvgPages ?? candidate.paperSvgPages ?? meta.paperSvgPages };
      }

      async function showHostOutput(value, fromTab = false, hostMeta, initialHost = false) {
        const candidate = value && (value.structuredContent || value.result?.structuredContent || value);
        if (!candidate?.answer?.id) return;
        const epoch = ++hostOutputEpoch;
        if (fromTab) latestTabEpoch = epoch;
        const snapshot = extract(value, hostMeta, initialHost);
        if (snapshot) { renderSnapshot(snapshot); return; }
        const shownEpoch = snapshotEpoch;
        try {
          const rendered = extract(await callTool("render_answer_sheet", { answerId: candidate.answer.id, responseDetail: "full" }));
          if (epoch !== hostOutputEpoch || shownEpoch !== snapshotEpoch) {
            if (fromTab && epoch === latestTabEpoch && shownEpoch !== snapshotEpoch && state?.answer.id !== candidate.answer.id)
              setNotice("畫板已更新，請再按一次題目分頁。", false);
            return;
          }
          if (!rendered) throw new Error("工具沒有回傳可顯示的答題紙資料。");
          renderSnapshot(rendered);
        } catch (error) {
          if (epoch === hostOutputEpoch && shownEpoch === snapshotEpoch) setNotice(error instanceof Error ? error.message : "重新顯示失敗。", true);
        }
      }

      function request(method, params) {
        return new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("宿主未回應。請重新顯示答案確認狀態，再繼續操作。"));
          }, 30000);
          pending.set(id, { resolve, reject, timer });
          try {
            window.parent.postMessage({ jsonrpc: "2.0", id, method, params }, hostOrigin || "*");
          } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
          }
        });
      }

      async function callTool(name, argumentsValue) {
        let result;
        if (window.openai?.callTool) {
          let timer;
          try { result = await Promise.race([window.openai.callTool(name, argumentsValue), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("宿主未回應。請重新顯示答案確認狀態，再繼續操作。")), 30000); })]); }
          finally { clearTimeout(timer); }
        } else result = await request("tools/call", { name, arguments: argumentsValue });
        if (result?.isError) throw new Error(result.content?.[0]?.text || "工具呼叫失敗");
        return result;
      }

      function makeElement(tag, className, textValue) {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (textValue !== undefined) element.textContent = textValue;
        return element;
      }

      function selectSection(sectionId) {
        if (!state) return;
        editEpoch += 1;
        const section = state.answer.sections.find((item) => item.id === sectionId) || state.answer.sections[0];
        selectedSectionId = section?.id || "";
        sectionSelect.value = selectedSectionId;
        headingInput.value = section?.heading || "";
        textInput.value = section?.text || "";
        pendingEdit = null;
        previewText.textContent = "";
        previewText.className = "preview";
        previewButton.disabled = !section || state.readOnly || applying;
        applyButton.disabled = true;
        count.textContent = section ? "此區塊會依答題紙欄寬重新計算行數。" : "";
        document.querySelectorAll(".answer-line.selected, .original-paper g.selected").forEach((row) => row.classList.remove("selected"));
        document.querySelectorAll(".answer-line, .original-paper g[data-section-id]").forEach((row) => {
          if (row.dataset.sectionId === selectedSectionId) row.classList.add("selected");
        });
        updateTools();
      }

      function renderEditor() {
        sectionSelect.replaceChildren();
        for (const section of state?.answer.sections || []) {
          const option = makeElement("option", "", section.heading ? section.heading + " · " + section.id : section.id);
          option.value = section.id;
          sectionSelect.append(option);
        }
        const hasSections = (state?.answer.sections.length || 0) > 0;
        sectionSelect.disabled = !hasSections || applying;
        headingInput.disabled = !hasSections || state.readOnly || applying;
        textInput.disabled = !hasSections || state.readOnly || applying;
        if (hasSections) selectSection(selectedSectionId || state.answer.sections[0].id);
        else {
          // No section of this answer can still be selected.
          selectedSectionId = "";
          pendingEdit = null;
          previewText.textContent = "";
          previewText.className = "preview";
          headingInput.value = "";
          textInput.value = "";
          previewButton.disabled = true;
          applyButton.disabled = true;
          count.textContent = "尚無可編輯區塊。";
        }
        updateTools();
      }

      function orderedSections() {
        return [...(state?.answer.sections || [])].sort((a, b) => a.order - b.order);
      }

      // Enables the phrase, order, numbering and history controls for the current state and selection.
      function updateTools() {
        const editable = Boolean(state) && !state.readOnly && !applying;
        for (const input of [findInput, replaceInput, occurrenceInput, replaceAllInput]) input.disabled = !editable;
        useSelectionButton.disabled = !editable;
        phrasePreviewButton.disabled = !editable || !findInput.value;
        if (!pendingPhrase || !editable) phraseApplyButton.disabled = true;
        const sections = orderedSections();
        const index = sections.findIndex((section) => section.id === selectedSectionId);
        moveUpButton.disabled = !editable || index <= 0;
        moveDownButton.disabled = !editable || index < 0 || index >= sections.length - 1;
        renumberButton.disabled = !editable;
        revisionsButton.disabled = !state || applying;
      }

      // After any write, both the section editor and the tool panels reflect the current state again.
      function restoreControls() {
        const hasSelection = Boolean(state?.answer.sections.some((section) => section.id === selectedSectionId));
        sectionSelect.disabled = !state?.answer.sections.length;
        headingInput.disabled = state?.readOnly || !hasSelection;
        textInput.disabled = state?.readOnly || !hasSelection;
        previewButton.disabled = state?.readOnly || !hasSelection;
        updateTools();
      }

      // A new snapshot makes pending previews, the armed renumbering and the listed history stale;
      // anything still in flight from before compares its epoch and is dropped.
      function invalidateTools() {
        snapshotEpoch += 1;
        renumberArgs = null;
        phraseEpoch += 1;
        pendingPhrase = null;
        phrasePreviewText.textContent = "";
        phrasePreviewText.className = "preview";
        renumberArmed = false;
        renumberButton.textContent = "重新編號";
        toolsText.textContent = "";
        toolsText.className = "preview";
        revisionList.replaceChildren();
      }

      function resetPhrase() {
        phraseEpoch += 1;
        pendingPhrase = null;
        phrasePreviewText.textContent = "";
        phrasePreviewText.className = "preview";
        updateTools();
      }

      function summaryOf(result) {
        return (result?.content?.[0]?.text || "已完成。").split("\n").map((line) => line.replace(/^・/, "")).join("；");
      }

      // Shows the answer a write saved. When the host cannot render it, the write's own snapshot goes
      // on the grid instead, so the view never stays on the version the write replaced.
      // Returns why the render failed, or "" when it did not.
      async function showSaved(answerId, saved) {
        updateExamAnswer(saved);
        if (state?.answer.id !== answerId) renderTabs();
        let rendered = null, reason = "";
        try {
          rendered = extract(await callTool("render_answer_sheet", { answerId, responseDetail: "full" }));
          if (!rendered) reason = "工具沒有回傳可顯示的答題紙資料";
        } catch (error) {
          reason = error instanceof Error ? error.message : "重新顯示失敗";
        }
        // The host may have shown another answer meanwhile; never switch the view back to this one.
        if (state?.answer.id !== answerId) {
          if (rendered) updateExamAnswer(rendered);
          renderTabs();
          return reason;
        }
        const fallback = saved?.answer && saved?.layout ? { ...saved, readOnly: state.readOnly } : null;
        if (rendered || fallback) renderSnapshot(rendered || fallback);
        return reason;
      }

      function savedNotice(answerId, summary, reason) {
        if (!reason) noticeFor(answerId, summary, false);
        else noticeFor(answerId, summary + "；但畫板沒能更新（" + reason + "），請按「重新顯示」取回最新答題紙。", true);
      }

      /** Runs a write tool, then shows the authoritative snapshot again. */
      async function runWrite(button, name, args) {
        if (!state || state.readOnly || applying) return null;
        applying = true;
        setBusy(button, true);
        updateTools();
        try {
          const answerId = args.answerId;
          const result = await callTool(name, { ...args, responseDetail: "full" });
          const reason = await showSaved(answerId, result?.structuredContent || result?.result?.structuredContent);
          savedNotice(answerId, summaryOf(result), reason);
          return result;
        } catch (error) {
          noticeFor(args.answerId, error instanceof Error ? error.message : "操作失敗，可能需要重新載入最新版本。", true);
          return null;
        } finally {
          applying = false;
          setBusy(button, false);
          restoreControls();
        }
      }

      function phraseArgs() {
        const edit = { find: findInput.value, replace: replaceInput.value };
        const occurrence = occurrenceInput.value.trim();
        if (replaceAllInput.checked) edit.replaceAll = true;
        else if (occurrence) {
          if (!/^[1-9][0-9]*$/.test(occurrence)) throw new Error("「只改第幾處」要填正整數，或留空。");
          edit.occurrence = Number(occurrence);
        }
        return { answerId: state.answer.id, expectedVersion: state.answer.version, edits: [edit] };
      }

      async function previewPhrase() {
        if (!state || state.readOnly || applying || !findInput.value) return;
        const epoch = phraseEpoch;
        setBusy(phrasePreviewButton, true);
        try {
          const args = phraseArgs();
          const result = await callTool("preview_change", { operation: "edit_text", ...args });
          const preview = result?.structuredContent || result?.result?.structuredContent;
          if (epoch !== phraseEpoch) return;
          if (!preview) throw new Error("工具沒有回傳預覽資料。");
          pendingPhrase = { args, epoch };
          phrasePreviewText.textContent = preview.summary?.join("；") || "預覽完成，可套用。";
          phrasePreviewText.className = preview.after?.layout?.fits ? "preview good" : "preview bad";
          phraseApplyButton.disabled = false;
        } catch (error) {
          if (epoch !== phraseEpoch) return;
          pendingPhrase = null;
          phrasePreviewText.textContent = error instanceof Error ? error.message : "預覽失敗。";
          phrasePreviewText.className = "preview bad";
        } finally {
          setBusy(phrasePreviewButton, false);
          updateTools();
        }
      }

      async function applyPhrase() {
        if (!pendingPhrase || pendingPhrase.epoch !== phraseEpoch) return;
        const result = await runWrite(phraseApplyButton, "edit_text", pendingPhrase.args);
        if (!result) return;
        findInput.value = "";
        replaceInput.value = "";
        occurrenceInput.value = "";
        replaceAllInput.checked = false;
        resetPhrase();
      }

      function useSelection() {
        // The find text must exist in the saved answer, so an unsaved draft cannot be the source.
        const section = state?.answer.sections.find((item) => item.id === selectedSectionId);
        if (!section || textInput.value !== section.text || (headingInput.value || "") !== (section.heading || "")) {
          setNotice("上方區塊有尚未套用的修改；請先套用或重新選取區塊，再帶入選取文字。", true);
          return;
        }
        const selected = textInput.value.slice(textInput.selectionStart, textInput.selectionEnd);
        if (!selected || selected.includes("\n")) {
          setNotice("請先在上方文字框選取同一段內的一段字。", true);
          return;
        }
        findInput.value = selected;
        replaceInput.value = selected;
        resetPhrase();
        replaceInput.focus();
      }

      function moveSelected(direction) {
        const sections = orderedSections();
        const index = sections.findIndex((section) => section.id === selectedSectionId);
        const neighbour = sections[index + direction];
        if (index < 0 || !neighbour) return;
        const args = { answerId: state.answer.id, sectionId: selectedSectionId, expectedVersion: state.answer.version };
        if (direction < 0) args.beforeSectionId = neighbour.id;
        else args.afterSectionId = neighbour.id;
        return runWrite(direction < 0 ? moveUpButton : moveDownButton, "move_section", args);
      }

      // First click previews the renumbering; a second click while armed applies it.
      async function renumber() {
        if (!state || state.readOnly || applying) return;
        if (renumberArmed && renumberArgs) {
          // Apply exactly the version that was previewed; a newer answer makes the server refuse it.
          const args = renumberArgs;
          renumberArmed = false;
          renumberArgs = null;
          renumberButton.textContent = "重新編號";
          toolsText.textContent = "";
          await runWrite(renumberButton, "renumber_items", args);
          return;
        }
        const epoch = snapshotEpoch;
        const args = { answerId: state.answer.id, expectedVersion: state.answer.version };
        setBusy(renumberButton, true);
        try {
          const result = await callTool("preview_change", { operation: "renumber_items", ...args });
          if (epoch !== snapshotEpoch) return;
          const preview = result?.structuredContent || result?.result?.structuredContent;
          toolsText.textContent = (preview?.summary || []).slice(3).join("；") || "預覽完成。";
          toolsText.className = "preview";
          renumberArgs = args;
          renumberArmed = true;
        } catch (error) {
          if (epoch !== snapshotEpoch) return;
          toolsText.textContent = error instanceof Error ? error.message : "預覽失敗。";
          toolsText.className = "preview bad";
        } finally {
          setBusy(renumberButton, false);
          if (renumberArmed) renumberButton.textContent = "確認重新編號";
          updateTools();
        }
      }

      async function loadRevisions() {
        if (!state) return;
        const epoch = snapshotEpoch;
        const answerId = state.answer.id;
        setBusy(revisionsButton, true);
        try {
          const result = await callTool("list_revisions", { answerId, limit: 10 });
          // A list for an answer or version no longer shown is dropped rather than offering wrong restores.
          if (epoch !== snapshotEpoch) return;
          const list = result?.structuredContent || result?.result?.structuredContent;
          if (!list) throw new Error("工具沒有回傳版本紀錄。");
          revisionList.replaceChildren();
          for (const revision of list.revisions || []) {
            const item = makeElement("li", "");
            const head = makeElement("div", "revision-head");
            head.append(makeElement("strong", "", "第 " + revision.version + " 版"));
            head.append(makeElement("span", "editor-help", (revision.totalLines ?? "?") + " 行" + (revision.fits === false ? "，超出" : "")));
            if (revision.version === list.currentVersion) head.append(makeElement("span", "chip", "目前"));
            else if (!state.readOnly) {
              const restore = makeElement("button", "", "還原成這一版");
              restore.type = "button";
              // Bound to the listed answer and version: if either changed, the server refuses the restore.
              restore.addEventListener("click", () => runWrite(restore, "restore_revision",
                { answerId, version: revision.version, expectedVersion: list.currentVersion }));
              head.append(restore);
            }
            item.append(head);
            item.append(makeElement("div", "editor-help", (revision.changes || []).join("；")));
            revisionList.append(item);
          }
          if (list.olderVersions) revisionList.append(makeElement("li", "editor-help", "另有 " + list.olderVersions + " 個更早的版本未列出。"));
        } catch (error) {
          if (epoch !== snapshotEpoch) return;
          setNotice(error instanceof Error ? error.message : "讀取版本紀錄失敗。", true);
        } finally {
          setBusy(revisionsButton, false);
          updateTools();
        }
      }

      function updateExamAnswer(snapshot) {
        if (!snapshot?.answer || !Array.isArray(snapshot.layout?.lines)) return;
        examAnswers = examAnswers.map(answer => answer.answerId === snapshot.answer.id && snapshot.answer.version >= answer.version
          ? { ...answer, title: snapshot.answer.title, version: snapshot.answer.version,
              totalLines: snapshot.layout.totalLines, capacity: snapshot.layout.capacity, fits: snapshot.layout.fits,
              warnings: snapshot.warningCount } : answer);
      }

      function renderTabs() {
        const focusedTabId = examTabs.contains(document.activeElement) ? document.activeElement.dataset.answerId : null;
        const focusedId = examAnswers.some(answer => answer.answerId === focusedTabId) ? focusedTabId : null;
        examTabs.replaceChildren();
        examTabs.hidden = !examAnswers.length;
        pages.removeAttribute("role");
        pages.removeAttribute("aria-labelledby");
        updateExamAnswer(state);
        examAnswers.forEach((answer, index) => {
          const active = answer.answerId === state.answer.id;
          const label = "第" + (answer.questionNo ?? index + 1) + "題 " + answer.title;
          const tab = makeElement("button", "", label + " ");
          tab.type = "button";
          tab.id = "exam-tab-" + index;
          tab.dataset.answerId = answer.answerId;
          tab.dataset.version = String(answer.version);
          tab.setAttribute("role", "tab");
          tab.setAttribute("aria-controls", "pages");
          tab.setAttribute("aria-selected", String(active));
          tab.tabIndex = (focusedId ? focusedId === answer.answerId : active) ? 0 : -1;
          const warning = !answer.fits || answer.warnings > 0;
          const stats = [answer.totalLines + "/" + answer.capacity + " 行"];
          if (!answer.fits) stats.push("超出 " + Math.max(0, answer.totalLines - answer.capacity) + " 行");
          if (answer.warnings > 0) stats.push("警告 " + answer.warnings);
          tab.append(makeElement("span", "tab-status" + (warning ? " warning" : ""), stats.join("・")));
          tab.setAttribute("aria-label", label + "，" + stats.join("，"));
          tab.addEventListener("click", () => {
            if (state.answer.id !== answer.answerId) showHostOutput({ answer: { id: answer.answerId } }, true);
          });
          tab.addEventListener("keydown", event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const tabs = [...examTabs.children];
            const next = tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
            tabs.forEach(item => { item.tabIndex = item === next ? 0 : -1; });
            next.focus();
          });
          examTabs.append(tab);
          if (active) { pages.setAttribute("role", "tabpanel"); pages.setAttribute("aria-labelledby", tab.id); }
        });
        if (focusedId) [...examTabs.children].find(tab => tab.dataset.answerId === focusedId)?.focus();
      }

      function renderSnapshot(snapshot) {
        if (state?.answer.id === snapshot.answer.id && snapshot.answer.version < state.answer.version) return;
        editEpoch += 1;
        snapshot = { ...snapshot, paperSvgPages: snapshot.paperSvgPages ?? (sameAnswer(state, snapshot) ? state.paperSvgPages : undefined) };
        state = snapshot;
        if (Array.isArray(snapshot.examAnswers)) examAnswers = snapshot.examAnswers;
        if (!examAnswers.some(answer => answer.answerId === snapshot.answer.id)) examAnswers = [];
        renderTabs();
        invalidateTools();
        byId("refresh").disabled = false;
        byId("check").disabled = false;
        const layout = snapshot.layout;
        const configuredPages = layout.pagesConfigured;
        title.textContent = snapshot.answer.title;
        status.textContent = layout.fits ? "版面符合" : "超出版面容量 " + layout.overflowLines + " 行";
        status.className = layout.fits ? "status ok" : "status overflow";
        byId("answer-id").textContent = "答案：" + snapshot.answer.id;
        byId("answer-id").title = snapshot.answer.id;
        byId("version").textContent = "版本：" + snapshot.answer.version;
        byId("usage").textContent = "用量：" + layout.totalLines + " / " + layout.capacity + " 行";
        byId("remaining").textContent = "剩餘：" + layout.remainingLines + " 行";
        const meter = byId("meter");
        meter.firstElementChild.style.transform = "scaleX(" + (layout.capacity ? Math.min(1, layout.totalLines / layout.capacity) : 0) + ")";
        meter.classList.toggle("full", !layout.fits);
        pages.replaceChildren();
        pages.style.setProperty("--columns", String(layout.columns));
        const linesByPage = new Map();
        for (const line of layout.lines) {
          if (!linesByPage.has(line.page)) linesByPage.set(line.page, new Map());
          linesByPage.get(line.page).set(line.lineOnPage, line);
        }
        for (let pageNumber = 1; pageNumber <= configuredPages; pageNumber += 1) {
          const paper = makeElement("article", pageNumber > layout.pagesConfigured ? "paper overflow" : "paper");
          const head = makeElement("div", "paper-head");
          head.append(makeElement("div", "paper-title", "第 " + pageNumber + " 頁"));
          head.append(makeElement("div", "paper-caption", pageNumber > layout.pagesConfigured ? "超出設定頁數" : layout.linesPerPage + " 行 × " + layout.columns + " 格"));
          paper.append(head);
          if (snapshot.paperSvgPages?.[pageNumber-1]) {
            const body = makeElement("div", "original-paper");
            const svg = new DOMParser().parseFromString(snapshot.paperSvgPages[pageNumber-1], "image/svg+xml").documentElement;
            // On screen show the printed paper, not the blank A4 margin around it; exports keep the whole page.
            const image = svg.querySelector("image");
            const box = ["x", "y", "width", "height"].map((name) => Number(image?.getAttribute(name)));
            if (box.every(Number.isFinite) && box[2] > 0 && box[3] > 0) svg.setAttribute("viewBox", [box[0] - 8, box[1] - 8, box[2] + 16, box[3] + 16].join(" "));
            body.append(document.importNode(svg, true));
            body.querySelectorAll("g[data-section-id]").forEach(row => {
              row.addEventListener("click", () => selectSection(row.dataset.sectionId));
              row.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectSection(row.dataset.sectionId); } });
            });
            paper.append(body); pages.append(paper); continue;
          }
          const body = makeElement("div", "paper-body");
          const pageLines = linesByPage.get(pageNumber) || new Map();
          for (let lineNumber = 1; lineNumber <= layout.linesPerPage; lineNumber += 1) {
            const line = pageLines.get(lineNumber);
            // Emphasis follows the line's own format so the grid matches the exported file.
            const row = makeElement("div", "answer-line" + (line?.isHeading ? " heading" : "") + (line?.format?.bold ? " bold" : "") + (line?.format?.italic ? " italic" : "") + (line?.isSpacer ? " spacer" : ""));
            row.dataset.sectionId = line?.sectionId || "";
            row.append(makeElement("span", "line-number", String(lineNumber).padStart(2, "0")));
            const cells = makeElement("div", "line-cells");
            cells.style.setProperty("--columns", String(layout.columns));
            cells.append(makeElement("span", "line-text", line?.text || ""));
            row.append(cells);
            if (line?.sectionId) row.addEventListener("click", () => selectSection(line.sectionId));
            body.append(row);
          }
          paper.append(body);
          pages.append(paper);
        }
        fitGridLines();
        renderEditor();
        setNotice("已載入畫板；點選任一行可定位到對應區塊。", false);
      }

      // A line whose letters draw wider than their cells is condensed to fit, so no character is cut off at the paper edge.
      function fitGridLines() {
        for (const text of pages.querySelectorAll(".line-text")) {
          text.style.transform = "";
          const room = text.clientWidth;
          if (room > 0 && text.scrollWidth > room + 0.5) text.style.transform = "scaleX(" + (room / text.scrollWidth) + ")";
        }
      }

      async function refresh() {
        if (!state) return;
        const button = byId("refresh");
        const answerId = state.answer.id;
        setBusy(button, true);
        try {
          const result = await callTool("render_answer_sheet", { answerId, responseDetail: "full" });
          if (state?.answer.id !== answerId) return;
          const snapshot = extract(result);
          if (!snapshot) throw new Error("工具沒有回傳可顯示的答題紙資料。");
          renderSnapshot(snapshot);
        } catch (error) {
          noticeFor(answerId, error instanceof Error ? error.message : "重新顯示失敗。", true);
        } finally {
          setBusy(button, false);
        }
      }

      async function checkLayout() {
        if (!state) return;
        const button = byId("check");
        const answerId = state.answer.id;
        setBusy(button, true);
        try {
          await callTool("check_layout", { answerId });
          const result = await callTool("render_answer_sheet", { answerId, responseDetail: "full" });
          if (state?.answer.id !== answerId) return;
          const snapshot = extract(result);
          if (!snapshot) throw new Error("工具沒有回傳最新答案與版面資料。");
          renderSnapshot(snapshot);
        } catch (error) {
          noticeFor(answerId, error instanceof Error ? error.message : "版面檢查失敗。", true);
        } finally {
          setBusy(button, false);
        }
      }

      // Unchanged paragraphs keep their format; a rewritten one keeps the format of the paragraph it
      // replaces and an added one takes its neighbour's, so adding or removing lines loses no formatting.
      function carryFormats(paragraphs, texts) {
        const rows = paragraphs.length, columns = texts.length;
        // Very long sections are matched by position, keeping the alignment table small.
        if (rows * columns > 250000) return texts.map((text, i) => {
          const source = paragraphs[Math.min(i, rows - 1)];
          return {text, ...(source.format ? {format: source.format} : {})};
        });
        const table = Array.from({length: rows + 1}, () => new Array(columns + 1).fill(0));
        for (let i = rows - 1; i >= 0; i--) for (let j = columns - 1; j >= 0; j--) {
          table[i][j] = paragraphs[i].text === texts[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
        const result = [];
        let i = 0, previous = null, replaced = [];
        for (let j = 0; j < columns;) {
          if (i < rows && paragraphs[i].text === texts[j]) { previous = paragraphs[i]; replaced = []; i++; }
          else if (i < rows && table[i + 1][j] >= table[i][j + 1]) { replaced.push(paragraphs[i]); i++; continue; }
          else previous = replaced.length ? replaced.shift() : previous ?? paragraphs[Math.min(i, rows - 1)];
          result.push({text: texts[j], ...(previous.format ? {format: previous.format} : {})});
          j++;
        }
        return result;
      }

      async function previewEdit() {
        if (!state || !selectedSectionId || state.readOnly || applying) return;
        const epoch = editEpoch;
        setBusy(previewButton, true);
        try {
          const section = state.answer.sections.find(s => s.id === selectedSectionId);
          const args = { answerId: state.answer.id, sectionId: selectedSectionId, expectedVersion: state.answer.version, newText: textInput.value, heading: headingInput.value || null };
          if (section?.paragraphs?.length) {
            args.paragraphs = carryFormats(section.paragraphs, textInput.value.split("\n"));
            delete args.newText;
          }
          const result = await callTool("preview_change", { operation: "replace_text", ...args });
          const preview = result?.structuredContent || result?.result?.structuredContent;
          if (epoch !== editEpoch) return;
          if (!preview) throw new Error("工具沒有回傳預覽資料。");
          pendingEdit = { args, epoch };
          previewText.textContent = preview.summary?.join("；") || "預覽完成，可套用。";
          previewText.className = preview.after?.layout?.fits ? "preview good" : "preview bad";
          applyButton.disabled = false;
        } catch (error) {
          if (epoch !== editEpoch) return;
          pendingEdit = null;
          applyButton.disabled = true;
          previewText.textContent = error instanceof Error ? error.message : "預覽失敗。";
          previewText.className = "preview bad";
        } finally {
          setBusy(previewButton, false);
          previewButton.disabled = state?.readOnly || applying || !selectedSectionId;
        }
      }

      async function applyEdit() {
        if (!pendingEdit || pendingEdit.epoch !== editEpoch || state?.readOnly || applying) return;
        const edit = pendingEdit;
        applying = true;
        headingInput.disabled = true; textInput.disabled = true; sectionSelect.disabled = true; previewButton.disabled = true;
        setBusy(applyButton, true);
        try {
          const result = await callTool("replace_text", { ...edit.args, responseDetail: "full" });
          const snapshot = result?.structuredContent || result?.result?.structuredContent;
          if (!snapshot?.answer || !snapshot?.layout) throw new Error("工具沒有回傳更新後的答題紙資料。");
          pendingEdit = null;
          // Fetch the current snapshot and regenerated SVG after a committed edit.
          const reason = await showSaved(snapshot.answer.id, snapshot);
          savedNotice(edit.args.answerId, reason ? "修改已套用" : "修改已套用並重新計算版面。", reason);
        } catch (error) {
          noticeFor(edit.args.answerId, error instanceof Error ? error.message : "套用修改失敗，可能需要重新載入最新版本。", true);
        } finally {
          applying = false;
          setBusy(applyButton, false);
          restoreControls();
          applyButton.disabled = true;
        }
      }

      async function fullscreen() {
        try {
          if (window.openai?.requestDisplayMode) await window.openai.requestDisplayMode({ mode: "fullscreen" });
          else if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
          else setNotice("目前宿主不提供放大畫板模式。", false);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "無法放大畫板。", true);
        }
      }

      window.addEventListener("message", (event) => {
        if (event.source !== window.parent) return;
        const message = event.data || {};
        if (message.jsonrpc !== "2.0") return;
        if (hostOrigin && event.origin !== hostOrigin) return;
        if (message.id !== undefined && pending.has(message.id)) {
          if (!hostOrigin && event.origin !== "null") hostOrigin = event.origin;
          const requestState = pending.get(message.id);
          pending.delete(message.id);
          clearTimeout(requestState.timer);
          if (message.error) requestState.reject(new Error(message.error.message || "宿主呼叫失敗"));
          else requestState.resolve(message.result);
          return;
        }
        if (message.method === "ui/resource-teardown" && message.id !== undefined) {
          for (const requestState of pending.values()) { clearTimeout(requestState.timer); requestState.reject(new Error("畫板已關閉")); }
          pending.clear();
          window.parent.postMessage({jsonrpc:"2.0",id:message.id,result:{}}, hostOrigin || "*");
          return;
        }
        if (message.method === "ui/notifications/tool-result") {
          showHostOutput(message.params);
        }
      });

      sectionSelect.addEventListener("change", () => selectSection(sectionSelect.value));
      headingInput.addEventListener("input", () => { editEpoch += 1; pendingEdit = null; applyButton.disabled = true; previewText.textContent = ""; });
      textInput.addEventListener("input", () => { editEpoch += 1; pendingEdit = null; applyButton.disabled = true; previewText.textContent = ""; });
      byId("refresh").addEventListener("click", refresh);
      byId("check").addEventListener("click", checkLayout);
      byId("fullscreen").addEventListener("click", fullscreen);
      previewButton.addEventListener("click", previewEdit);
      applyButton.addEventListener("click", applyEdit);
      for (const input of [findInput, replaceInput]) input.addEventListener("input", resetPhrase);
      occurrenceInput.addEventListener("input", () => { if (occurrenceInput.value) replaceAllInput.checked = false; resetPhrase(); });
      replaceAllInput.addEventListener("change", () => { if (replaceAllInput.checked) occurrenceInput.value = ""; resetPhrase(); });
      useSelectionButton.addEventListener("click", useSelection);
      phrasePreviewButton.addEventListener("click", previewPhrase);
      phraseApplyButton.addEventListener("click", applyPhrase);
      moveUpButton.addEventListener("click", () => moveSelected(-1));
      moveDownButton.addEventListener("click", () => moveSelected(1));
      renumberButton.addEventListener("click", renumber);
      revisionsButton.addEventListener("click", loadRevisions);

      byId("refresh").disabled = true; byId("check").disabled = true;
      // A canvas rendered while hidden has nothing to measure; fit the grid lines again once it gets its size or changes width.
      if (typeof ResizeObserver === "function") new ResizeObserver(() => fitGridLines()).observe(pages);
      updateTools();
      window.addEventListener("openai:set_globals", event => {
        showHostOutput({ structuredContent: event.detail?.globals?.toolOutput }, false, event.detail?.globals?.toolResponseMetadata);
      });
      if (!window.openai?.callTool && window.parent !== window) {
        request("ui/initialize", { appInfo: { name: "police-essay-answer-sheet", version: "0.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
          .then(() => window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, hostOrigin || "*"))
          .catch(error => setNotice(error.message, true));
      }
      showHostOutput(window.openai?.toolOutput, false, window.openai?.toolResponseMetadata, true);
    })();
  </script>
</body>
</html>`;

