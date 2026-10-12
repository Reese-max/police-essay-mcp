export const ANSWER_SHEET_WIDGET_URI = "ui://widget/police-essay-answer-sheet.html";

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
    .answer-line.heading .line-text { color: #172554; font-weight: 800; }
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
    @media (max-width: 620px) {
      .app { padding: 12px; }
      .topbar { flex-direction: column; }
      .actions { justify-content: flex-start; }
      .editor-grid { grid-template-columns: 1fr; }
      .editor-actions { align-items: flex-start; flex-direction: column; }
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
          headingInput.value = "";
          textInput.value = "";
          previewButton.disabled = true;
          applyButton.disabled = true;
          count.textContent = "尚無可編輯區塊。";
        }
      }

      function renderSnapshot(snapshot) {
        if (state?.answer.id === snapshot.answer.id && snapshot.answer.version < state.answer.version) return;
        editEpoch += 1;
        state = snapshot;
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
            const row = makeElement("div", "answer-line" + (line?.isHeading ? " heading" : "") + (line?.isSpacer ? " spacer" : ""));
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
        setBusy(button, true);
        try {
          const answerId = state.answer.id;
          const result = await callTool("render_answer_sheet", { answerId });
          if (state?.answer.id !== answerId) return;
          const snapshot = extract(result);
          if (!snapshot) throw new Error("工具沒有回傳可顯示的答題紙資料。");
          renderSnapshot(snapshot);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "重新顯示失敗。", true);
        } finally {
          setBusy(button, false);
        }
      }

      async function checkLayout() {
        if (!state) return;
        const button = byId("check");
        setBusy(button, true);
        try {
          const answerId = state.answer.id;
          await callTool("check_layout", { answerId });
          const result = await callTool("render_answer_sheet", { answerId });
          if (state?.answer.id !== answerId) return;
          const snapshot = extract(result);
          if (!snapshot) throw new Error("工具沒有回傳最新答案與版面資料。");
          renderSnapshot(snapshot);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "版面檢查失敗。", true);
        } finally {
          setBusy(button, false);
        }
      }

      async function previewEdit() {
        if (!state || !selectedSectionId || state.readOnly || applying) return;
        const epoch = editEpoch;
        setBusy(previewButton, true);
        try {
          const section = state.answer.sections.find(s => s.id === selectedSectionId);
          const args = { answerId: state.answer.id, sectionId: selectedSectionId, expectedVersion: state.answer.version, newText: textInput.value, heading: headingInput.value || null };
          if (section?.paragraphs?.length) {
            const texts = textInput.value.split("\n");
            if (texts.length !== section.paragraphs.length) throw new Error("段落數已改變，請在對話中修改以保留各段格式。");
            args.paragraphs = texts.map((text, i) => ({text, ...(section.paragraphs[i].format ? {format: section.paragraphs[i].format} : {})}));
            delete args.newText;
          }
          const result = await callTool("preview_replace_text", args);
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
          renderSnapshot(rendered || { ...snapshot, readOnly: state.readOnly });
          setNotice("修改已套用並重新計算版面。", false);
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "套用修改失敗，可能需要重新載入最新版本。", true);
        } finally {
          applying = false;
          sectionSelect.disabled = !state?.answer.sections.length;
          headingInput.disabled = state?.readOnly || !selectedSectionId;
          textInput.disabled = state?.readOnly || !selectedSectionId;
          previewButton.disabled = state?.readOnly || !selectedSectionId;
          setBusy(applyButton, false);
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

      byId("refresh").disabled = true; byId("check").disabled = true;
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

