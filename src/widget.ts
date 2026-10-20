// Bump the version whenever the widget's markup or the tools it calls change: hosts cache the template by URI.
export const ANSWER_SHEET_WIDGET_URI = "ui://widget/police-essay-answer-sheet-v3.html";

export const POLICE_ESSAY_WIDGET_HTML = String.raw`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #f5f7fb; color: #162033; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f5f7fb; }
    button, input, textarea, select { font: inherit; }
    button { cursor: pointer; border: 1px solid #cbd5e1; border-radius: 9px; background: #fff; color: #1f2937; padding: 7px 11px; }
    button:hover { border-color: #64748b; background: #f8fafc; }
    button:disabled { cursor: wait; opacity: .55; }
    .app { --accent: #2563eb; max-width: 1120px; margin: 0 auto; padding: 18px; }
    .topbar { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 13px; }
    .eyebrow { color: #64748b; font-size: 11px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 3px 0 4px; font-size: clamp(20px, 3vw, 28px); line-height: 1.15; letter-spacing: -.025em; }
    .subtitle { color: #526174; font-size: 13px; }
    .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 7px; }
    .primary { border-color: #1d4ed8; background: #2563eb; color: #fff; }
    .primary:hover { border-color: #1e40af; background: #1d4ed8; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin-bottom: 15px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; border: 1px solid #dbe3ef; border-radius: 999px; background: #fff; color: #526174; padding: 5px 9px; font-size: 12px; }
    .status { border: 1px solid #bfdbfe; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-size: 12px; font-weight: 700; padding: 5px 10px; }
    .status.ok { border-color: #bbf7d0; background: #f0fdf4; color: #15803d; }
    .status.overflow { border-color: #fecaca; background: #fef2f2; color: #b91c1c; }
    .notice { min-height: 18px; margin: 0 0 12px; color: #526174; font-size: 12px; }
    .notice.error { color: #b91c1c; }
    .sheet-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 385px), 1fr)); gap: 16px; align-items: start; }
    .paper { overflow: hidden; border: 1px solid #d7dee9; border-radius: 14px; background: #fff; box-shadow: 0 10px 30px rgba(15, 23, 42, .07); }
    .original-paper svg { display: block; width: 100%; height: auto; }
    .original-paper g[data-section-id]:hover, .original-paper g.selected { cursor: pointer; fill: #1d4ed8; }
    .original-paper g:focus { outline: 1px solid #2563eb; }
    .paper.overflow { border-color: #fca5a5; }
    .paper-head { display: flex; justify-content: space-between; border-bottom: 1px solid #e5eaf1; padding: 12px 14px 10px; }
    .paper-title { font-size: 13px; font-weight: 800; }
    .paper-caption { color: #7a8799; font-size: 11px; }
    .paper-body { padding: 9px 11px 12px; }
    .answer-line { display: grid; grid-template-columns: 2.2rem minmax(0, 1fr); min-height: 1.65rem; border-radius: 5px; color: #334155; }
    .answer-line:hover, .answer-line.selected { background: #eff6ff; }
    .line-number { display: flex; align-items: center; justify-content: flex-end; padding-right: 6px; color: #94a3b8; font-size: 10px; font-variant-numeric: tabular-nums; user-select: none; }
    .line-cells { --columns: 42; position: relative; min-width: 0; border-bottom: 1px solid #dbe3ef; background-image: repeating-linear-gradient(to right, transparent 0, transparent calc(100% / var(--columns) - 1px), rgba(148, 163, 184, .25) calc(100% / var(--columns) - 1px), rgba(148, 163, 184, .25) calc(100% / var(--columns))); background-size: 100% 100%; }
    .line-text { display: block; overflow: hidden; min-height: 1.65rem; padding: 3px 5px; white-space: pre; font-family: "Noto Sans Mono CJK TC", "Microsoft JhengHei", ui-monospace, monospace; font-size: 12px; line-height: 1.35; text-overflow: clip; }
    .answer-line.heading .line-text { color: #172554; }
    .answer-line.bold .line-text { font-weight: 800; }
    .answer-line.italic .line-text { font-style: italic; }
    .answer-line.spacer .line-text { min-height: 1.65rem; }
    .editor { margin-top: 16px; border: 1px solid #d7dee9; border-radius: 14px; background: #fff; padding: 14px; }
    .editor-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
    .editor-title { font-size: 14px; font-weight: 800; }
    .editor-help { color: #64748b; font-size: 11px; }
    .editor-grid { display: grid; grid-template-columns: minmax(170px, .4fr) minmax(0, 1fr); gap: 10px; }
    .field { display: flex; flex-direction: column; gap: 5px; }
    .field label { color: #526174; font-size: 11px; font-weight: 700; }
    select, input, textarea { width: 100%; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #172033; padding: 8px 9px; }
    textarea { min-height: 120px; resize: vertical; line-height: 1.55; }
    .editor-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 9px; }
    .editor-buttons { display: flex; gap: 7px; }
    .preview { color: #526174; font-size: 11px; }
    .preview.good { color: #15803d; }
    .preview.bad { color: #b91c1c; }
    .empty { border: 1px dashed #cbd5e1; border-radius: 14px; background: #fff; color: #64748b; padding: 34px 20px; text-align: center; }
    .phrase-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .phrase-options { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; color: #526174; font-size: 12px; }
    .phrase-options input[type="number"] { width: 4.5em; padding: 5px 6px; }
    .phrase-options input[type="checkbox"] { width: auto; }
    .editor-buttons.wrap { flex-wrap: wrap; }
    .revisions { display: grid; gap: 8px; margin: 10px 0 0; padding: 0; list-style: none; }
    .revisions li { border-top: 1px solid #e5eaf1; padding-top: 8px; }
    .revision-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 3px; }
    @media (max-width: 620px) {
      .app { padding: 12px; }
      .topbar { flex-direction: column; }
      .actions { justify-content: flex-start; }
      .editor-grid { grid-template-columns: 1fr; }
      .editor-actions { align-items: flex-start; flex-direction: column; }
      .phrase-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main class="app" id="app">
    <header class="topbar">
      <div>
        <div class="eyebrow">Police Essay MCP · Visual Answer Sheet</div>
        <h1>警察資訊三等・申論答題紙</h1>
        <div class="subtitle" id="answer-title">等待答題紙資料…</div>
      </div>
      <div class="actions">
        <button id="refresh" type="button">重新顯示</button>
        <button id="check" type="button">重新檢查版面</button>
        <button class="primary" id="fullscreen" type="button">放大畫板</button>
      </div>
    </header>
    <div class="meta">
      <span class="status" id="status">等待資料</span>
      <span class="chip" id="answer-id">答案：—</span>
      <span class="chip" id="version">版本：—</span>
      <span class="chip" id="usage">用量：—</span>
      <span class="chip" id="remaining">剩餘：—</span>
    </div>
    <p class="notice" id="notice" role="status"></p>
    <section class="sheet-grid" id="pages" aria-label="申論答題紙畫板">
      <div class="empty">請在對話中要求 Police Essay MCP 建立或載入答案，畫板會在這裡顯示。</div>
    </section>
    <section class="editor" aria-label="答題區塊編輯器">
      <div class="editor-head">
        <div>
          <div class="editor-title">區塊快速編輯</div>
          <div class="editor-help">先預覽，再套用；套用時會以目前版本避免覆蓋新內容。</div>
        </div>
        <span class="preview" id="preview" aria-live="polite"></span>
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
        <div>
          <div class="editor-title">字句修改</div>
          <div class="editor-help">只改指定的字句，其他內容不動；同一段字出現多次時，指定第幾處或全部取代。</div>
        </div>
        <span class="preview" id="phrase-preview" aria-live="polite"></span>
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
        <div>
          <div class="editor-title">區塊順序、編號與版本</div>
          <div class="editor-help">搬移目前選取的區塊；重新編號先預覽，再按一次確認；每一版都可以還原，還原會另存新版本。</div>
        </div>
        <span class="preview" id="tools-preview" aria-live="polite"></span>
      </div>
      <div class="editor-buttons wrap">
        <button id="move-up" type="button" disabled>上移區塊</button>
        <button id="move-down" type="button" disabled>下移區塊</button>
        <button id="renumber" type="button" disabled>重新編號</button>
        <button id="load-revisions" type="button" disabled>版本紀錄</button>
      </div>
      <ol class="revisions" id="revisions" aria-label="版本紀錄"></ol>
    </section>
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

      function noticeFor(answerId, message, isError) {
        if (state?.answer.id === answerId) setNotice(message, isError);
      }

      function setNotice(message, isError) {
        notice.textContent = message || "";
        notice.className = isError ? "notice error" : "notice";
      }

      function setBusy(button, busy) {
        button.disabled = busy;
        if (busy) button.dataset.previousText = button.textContent || "";
        if (busy) button.textContent = "處理中…";
        else if (button.dataset.previousText) button.textContent = button.dataset.previousText;
      }

      function extract(value) {
        const candidate = value && (value.structuredContent || value.result?.structuredContent || value);
        return candidate && candidate.answer && candidate.layout ? { ...candidate, readOnly: value?._meta?.readOnly ?? window.openai?.toolResponseMetadata?.readOnly ?? true, paperSvgPages: value?._meta?.paperSvgPages ?? window.openai?.toolResponseMetadata?.paperSvgPages } : null;
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

      /** Runs a write tool, then shows the authoritative snapshot again. */
      async function runWrite(button, name, args) {
        if (!state || state.readOnly || applying) return null;
        applying = true;
        setBusy(button, true);
        updateTools();
        try {
          const answerId = args.answerId;
          const result = await callTool(name, args);
          const rendered = extract(await callTool("render_answer_sheet", { answerId }));
          // The host may have shown another answer meanwhile; never switch the view back to this one.
          if (rendered && state?.answer.id === answerId) renderSnapshot(rendered);
          noticeFor(answerId, summaryOf(result), false);
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

      function renderSnapshot(snapshot) {
        if (state?.answer.id === snapshot.answer.id && snapshot.answer.version < state.answer.version) return;
        editEpoch += 1;
        state = snapshot;
        invalidateTools();
        byId("refresh").disabled = false;
        byId("check").disabled = false;
        const layout = snapshot.layout;
        const configuredPages = layout.pagesConfigured;
        title.textContent = snapshot.answer.title + " · " + snapshot.answer.id;
        status.textContent = layout.fits ? "版面符合" : "超出版面容量 " + layout.overflowLines + " 行";
        status.className = layout.fits ? "status ok" : "status overflow";
        byId("answer-id").textContent = "答案：" + snapshot.answer.id;
        byId("version").textContent = "版本：" + snapshot.answer.version;
        byId("usage").textContent = "用量：" + layout.totalLines + " / " + layout.capacity + " 行";
        byId("remaining").textContent = "剩餘：" + layout.remainingLines + " 行";
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
        renderEditor();
        setNotice("已載入畫板；點選任一行可定位到對應區塊。", false);
      }

      async function refresh() {
        if (!state) return;
        const button = byId("refresh");
        const answerId = state.answer.id;
        setBusy(button, true);
        try {
          const result = await callTool("render_answer_sheet", { answerId });
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
          const result = await callTool("render_answer_sheet", { answerId });
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
          const result = await callTool("replace_text", edit.args);
          const snapshot = result?.structuredContent || result?.result?.structuredContent;
          if (!snapshot?.answer || !snapshot?.layout) throw new Error("工具沒有回傳更新後的答題紙資料。");
          pendingEdit = null;
          // Fetch the current snapshot and regenerated SVG after a committed edit.
          const rendered = extract(await callTool("render_answer_sheet", { answerId: snapshot.answer.id }));
          // The host may have shown another answer meanwhile; never switch the view back to this one.
          if (state?.answer.id === snapshot.answer.id) renderSnapshot(rendered || { ...snapshot, readOnly: state.readOnly });
          noticeFor(edit.args.answerId, "修改已套用並重新計算版面。", false);
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
          const snapshot = extract(message.params);
          if (snapshot) renderSnapshot(snapshot);
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
      updateTools();
      window.addEventListener("openai:set_globals", event => {
        const snapshot = extract(event.detail?.globals?.toolOutput);
        if (snapshot) renderSnapshot(snapshot);
      });
      if (!window.openai?.callTool && window.parent !== window) {
        request("ui/initialize", { appInfo: { name: "police-essay-answer-sheet", version: "0.1.0" }, appCapabilities: {}, protocolVersion: "2026-01-26" })
          .then(() => window.parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, hostOrigin || "*"))
          .catch(error => setNotice(error.message, true));
      }
      const initial = extract(window.openai?.toolOutput);
      if (initial) renderSnapshot(initial);
    })();
  </script>
</body>
</html>`;

