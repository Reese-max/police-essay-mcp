# 國考申論答題紙 MCP — 需求規格 v1

## 1. 目標與範圍

本專案把「警察資訊三等申論答案」建模成可讀、可寫、可局部修改、可重新排版與可匯出的 MCP 文件，而不是一段游離文字。

v1 的預設模板為：

- 紙張：A4
- 頁數：2 頁
- 每頁：22 行
- 總容量：44 行
- 預設寬度：42 個顯示欄位；全形中文字占 2 欄，ASCII 字元占 1 欄
- 支援正式段落格式：首行／左右縮排、左／右／左右／分散對齊、段前／段後格線行距、Tab 定位、粗體與斜體
- 支援標題預設樣式：自動粗體與中文／阿拉伯數字編號
- 版面設定全部由 template JSON 提供，不寫死在排版器中

MCP 後端是唯一的行數真相來源。模型可以產生內容與提出修改，但不得自行估算「大約幾行」來取代後端計算。

## 2. 核心不變條件

1. 答案一定隸屬於一個模板與一組有順序的 sections。
2. 每個 section 都有穩定 `id`、文字、必要性、採點優先級與可壓縮程度。
3. 每次讀取、寫入或局部修改，都可以得到同一套 `LayoutReport`。
4. `totalLines` 由模板的 deterministic wrapping 計算；一般模板採顯示欄寬，166 原稿紙採字型實際寬度及 Word 間距預留；不得用 token 數或模型估計替代。
5. `fits=true` 才代表符合模板的頁數／行數限制。
6. 局部修改使用 `expectedVersion` 時，版本不一致必須拒絕，避免舊內容覆蓋新內容。
7. DOCX 與 PDF 預設拒絕輸出溢出版；一般模板可明確指定 `allowOverflow=true` 供除錯，166 原稿紙始終拒絕超頁與 override。

## 3. 模板資料結構

```json
{
  "id": "police_information_essay",
  "name": "警察資訊三等申論模式",
  "description": "A4、2頁、每頁22行的固定版面",
  "paperSize": "A4",
  "pages": 2,
  "linesPerPage": 22,
  "columns": 42,
  "overflowPolicy": "compress",
  "fontFamily": "Microsoft JhengHei",
  "fontSizePt": 14,
  "lineHeightPt": 28,
  "paragraphDefaults": {
    "firstLineIndent": 0,
    "leftIndent": 0,
    "rightIndent": 0,
    "alignment": "left",
    "spaceBeforeLines": 0,
    "spaceAfterLines": 0,
    "tabSize": 4,
    "bold": false,
    "italic": false
  },
  "headingDefaults": {
    "bold": true,
    "numbered": false,
    "numbering": "chinese",
    "separator": "、"
  },
  "marginsMm": { "top": 16, "right": 15, "bottom": 16, "left": 15 }
}
```

`columns` 是顯示欄位，不是 JavaScript 字元數。這使中文、英文、數字與標點在同一個計算模型中可重現；未來若試卷欄寬不同，只需新增模板。

格式欄位的縮排與 Tab 單位也是顯示欄位。`spaceBeforeLines` 與 `spaceAfterLines` 代表要保留的格線行數，因此會計入 `totalLines`；這能確保畫面上的正式段落間距不會讓答案在匯出時悄悄超頁。

`compress` 只代表超出時提供可壓縮區塊與預估節省方向；真正的語意濃縮由模型提出新文字，再透過修改 tool 寫回，後端不會靜默截斷答案。

## 4. 答案資料結構

```json
{
  "id": "ans_…",
  "templateId": "police_information_essay",
  "title": "SQL Injection 防制與偵查",
  "question": "…",
  "sections": [
    {
      "id": "intro",
      "heading": "壹、前言",
      "text": "…",
      "required": false,
      "priority": 2,
      "compressible": 5,
      "order": 0
    },
    {
      "id": "prevention",
      "heading": "參、防制措施",
      "text": "…",
      "headingStyle": { "numbered": true, "bold": true },
      "paragraphs": [
        {
          "text": "第一段內容…",
          "format": { "firstLineIndent": 2, "alignment": "justify" }
        },
        {
          "text": "第二段內容…",
          "format": { "leftIndent": 2, "spaceBeforeLines": 1 }
        }
      ],
      "required": true,
      "priority": 5,
      "compressible": 1,
      "order": 1
    }
  ],
  "version": 3,
  "createdAt": "2026-09-20T00:00:00.000Z",
  "updatedAt": "2026-09-20T00:01:00.000Z"
}
```

`required`、`priority`、`compressible` 不會自動刪除或改寫答案；它們會在超出時形成 `compressionHints`，讓模型知道先處理哪一段以及哪些區塊應保留核心採點。

`paragraphs` 可讓同一個 section 內的每個段落使用不同格式。若未提供 `paragraphs`，後端會把 `text` 的換行拆成段落並套用 `paragraphFormat` 或模板的 `paragraphDefaults`。`headingStyle.numbered=true` 時，標題會依有標題的 section 順序自動產生編號；若原標題已有 `壹、`、`1、` 等前綴，後端會先移除再重新編號，避免重複。

在寫入輸入中，`text` 與 `paragraphs` 可擇一提供；只提供 `paragraphs` 時，後端會產生 canonical `text` 供儲存與相容性使用。既有文字的格式修改使用 `format_section`，不必重新傳送文字。

段落格式欄位：

| 欄位 | 作用 |
| --- | --- |
| `firstLineIndent` | 首行縮排欄數 |
| `leftIndent` / `rightIndent` | 每行左右縮排欄數 |
| `alignment` | `left`、`right`、`justify` 或 `distributed` |
| `spaceBeforeLines` / `spaceAfterLines` | 段前／段後保留的格線行數 |
| `tabSize` | Tab 的欄位寬度，並同步輸出到 Word Tab stop |
| `bold` / `italic` | 段落文字樣式 |

標題樣式另支援 `numbered`、`numbering`（`chinese` 或 `arabic`）、`separator`、縮排、對齊、間距與粗斜體。

## 5. Tools 契約

| Tool | 作用 | 是否改變狀態 |
| --- | --- | --- |
| `list_templates` | 列出可用模板 | 否 |
| `load_exam_paper` | 讀模板，或依 `answerId` 載入答案與版面 | 否 |
| `list_answers` | 列出已儲存答案 | 否 |
| `create_answer` | 建立答案文件，可附 sections、exam、questionNo、lineTargets（版本 1） | 是 |
| `create_answers` | 1–10 題共用建立流程，全數驗證後依序儲存，逐題摘要；essay.write | 是 |
| `read_answer` | 讀完整 sections、版本、逐行結果與版面報告，不掛載畫板 | 否 |
| `preview_change` | 預覽任一修改工具（`operation` 填工具名稱，其餘參數與該工具相同）的差異與版面結果，不寫入 | 否 |
| `write_answer` | 以完整 sections 覆寫答案後重新計算 | 是 |
| `replace_text` | 替換指定 `sectionId`，保留其他段落 | 是 |
| `format_section` | 不改文字，只更新 section 或指定 paragraphs 的格式 | 是 |
| `insert_text` | 在指定段落後插入新 section | 是 |
| `delete_text` | 刪除指定 section | 是，具破壞性標記 |
| `move_section` | 把指定 section 移到另一個 section 之前或之後 | 是 |
| `renumber_items` | 依層級重新編號標題與段首的手寫編號 | 是 |
| `set_line_targets` | 設定各節目標行數，供 `check_layout` 回報差距 | 是 |
| `update_answer_info` | 修改標題、題目、考試名稱與題號 | 是 |
| `duplicate_answer` | 複製答案為新的一份（版本與紀錄重新開始） | 是 |
| `export_answer` | 以 expectedVersion 釘選版本，一次輸出多種格式，檔名用考試、題號與標題 | 是，建立檔案 |
| `reflow_answer` | 重新計算固定欄寬、分頁與行數 | 否 |
| `export_exam_bundle` | 逐題必要 expectedVersion，先驗證全部，再依順序合成 PDF 與 Word（DOCX）；PDF 含書籤，回傳頁碼範圍 | 是，建立檔案 |
| `check_layout` | 回傳每頁使用量、剩餘量、溢出量、濃縮提示與品質警告 | 否 |
| `render_answer_sheet` | 回傳 authoritative snapshot 並掛載 ChatGPT Apps SDK 互動畫板 | 否 |
| `start_exam` | 建立 1–20 題考試計畫，支援 idempotencyKey，essay.write | 是 |
| `get_exam_progress` | 讀取逐題真實進度、合輯版本與續寫 nextStep，essay.read | 否 |
| `render_exam_overview` | examId 或 1–20 個不重複 answerIds 共用一個題目分頁畫板；缺題保留未建立，essay.read | 否 |
| `export_docx` | 產生 A4 固定格線 Word；可選 expectedVersion | 是，建立檔案 |
| `export_pdf` | 產生 A4 固定格線 PDF；可選 expectedVersion | 是，建立檔案 |
| `export_text` | 產生依實際換行與分頁的純文字；可選 expectedVersion | 是，建立檔案 |

修改時以 `expectedVersion` 防止覆蓋新版本（`restore_revision`、`delete_answer` 必填）。內容修改成功後 `version + 1`；建立或複製為版本 1。寫入預設回傳摘要，指定 `responseDetail: "full"` 才回傳完整 authoritative snapshot。

`preview_change` 回傳 `changeId`、`baseVersion`、修改前後 snapshot、行數差異與 `fits` 結果，但不會寫入檔案；確認後必須以相同的 `expectedVersion` 呼叫正式修改工具。若期間答案已被其他修改更新，版本檢查會拒絕套用。

## 6. Resources 與 Prompts

Resources：

- `essay://templates/police_information_essay`：模板 JSON。
- `essay://instructions/workflow`：讀取、修改、檢查與匯出的工作流程。
- `ui://widget/police-essay-answer-sheet-v12.html`：ChatGPT Apps SDK 的互動答題紙畫板資源（URI 帶版本，畫板或其呼叫的工具改變時遞增，讓宿主不沿用快取的舊畫板）。

Prompts：

- `draft_answer`：提示模型先分段，再呼叫 `create_answer` / `write_answer`，最後驗證 `fits`。
- `compress_answer`：提示模型依 `compressionHints` 濃縮非核心內容，反覆檢查到符合容量。

## 7. 排版演算法

答案可儲存 strict `layoutOptions: { wholeLatinWords?: boolean, keepHeadingWithNext?: boolean }`；缺少欄位視為 false，`layoutSections(template, sections, options?)` 的雙參數行為不變。建立工具共用路徑才將新答案的兩個選項預設為 true（部分輸入的省略鍵也為 true）；`createAnswerDocument` 不套用新預設。`update_answer_info` 局部更新選項並另存版本；`duplicate_answer` 原樣複製，`restore_revision` 保留目前答案選項。

一般與 166 換行器在 ASCII 英數字元間斷行時，先向後讀到完整字詞結尾；只有完整字詞能容納於下一行可用寬度，且目前行仍留下至少一個非空白字元時，才將行末英數字移至下一行，否則沿用原斷行。空白不移除或重排，超長字詞仍可斷行；166 共用字型量測並計入緊接字詞的標點攜帶寬度。

`SPLIT_LATIN_WORD` 以跨越斷點的完整 ASCII 英數字詞（可延續多行）判斷原因：一般模板比較顯示寬度與扣除左右縮排的欄寬，166 比較共用字型量測與非首行可用寬度。能容納一行者建議以 `update_answer_info` 設定 `layoutOptions.wholeLatinWords=true` 或改寫，超長者建議縮短字詞或調整縮排；兩者均不阻擋匯出。

編頁前若標題末行與同節首個非 spacer 內文行分頁，且標題未在頁首、標題到首行內文可容納一頁，於標題前補空白到下一頁。這些行有 `isSpacer: true, isPadding: true`，歸屬同節，計入總行數、各節行數與溢出；匯出與畫板視為普通空白行，段落 TXT 捨棄 spacer。沒有內文行或標題區塊過長時不補行。

1. 依 `order` 排序 sections。
2. 每個有標題的 section 先套用 `headingStyle`，必要時產生自動編號，再把標題視為獨立段落。
3. 依 `paragraphs`（或由 `text` 換行產生的段落）合併模板、section 與 paragraph 格式。
4. 每個段落先加入 `spaceBeforeLines`，再依首行／左右縮排計算可用欄寬。
5. 每個段落逐 code point 累加顯示欄位：
   - CJK、全形標點、emoji 等寬字元：2
   - ASCII、半形標點與一般字元：1
   - combining mark：0
   - tab：4
6. 下一個字元會超過可用欄寬時，結束目前行並開始下一行；Tab 依段落的 `tabSize` 對齊到下一個定位點。
7. 段落結束後加入 `spaceAfterLines`，再將全域行號映射到：
   - `page = ceil(globalLine / linesPerPage)`
   - `lineOnPage = ((globalLine - 1) mod linesPerPage) + 1`
8. `capacity = pages * linesPerPage`。
9. `overflowLines = max(0, totalLines - capacity)`；`remainingLines = max(0, capacity - totalLines)`。
10. 對超出版按 `compressible` 降冪、`priority` 升冪、目前行數降冪排序，形成提示；後端不自行重寫語意。

這個演算法只負責「真實占幾行」。語意濃縮仍由模型提出新文字，再透過 `replace_text` 寫回並重新驗證。

## 8. 匯出流程

```text
read answer
  → layoutSections(template, sections)
  → fits == true ?
      → DOCX: 每頁一個 22-row table，固定列高與框線，並套用段落縮排、對齊、Tab stop、粗體與斜體
      → PDF: A4 page，繪製 22 條橫線與左右邊界，再依相同欄位模型定位文字與粗體字型
  → fits == false：拒絕輸出，除非 allowOverflow=true
```

DOCX 會保留兩頁空白格線，即使答案未填滿；DOCX 與 PDF 共用模板的 `lineHeightPt` 與欄寬度計算。PDF 會嘗試尋找 Windows 的 Microsoft JhengHei／粗體字型或系統 Noto CJK 字型；斜體字型可透過 `ESSAY_MCP_PDF_ITALIC_FONT` 設定。若找不到所需字型，工具回傳 `fontWarning`。

## 9. v1 驗收條件

- 能建立、讀取、完整寫入與局部修改答案。
- 44 行剛好填滿時回傳 `fits=true`、兩頁各 `22/22`。
- 第 45 行起回傳 `overflowLines`，並提供濃縮順序。
- 中英混排、明確換行與空白行可重現計算。
- 段落格式可分別套用首行／左右縮排、四種對齊、格線行距、Tab、粗斜體。
- `format_section` 可在不重送文字的情況下更新整個 section 或指定段落的格式。
- 建立與插入輸入可只提供 `paragraphs`，不必複製一份相同的 `text`。
- 標題可依模板或 section 設定自動粗體與中文／阿拉伯數字編號。
- 版本衝突會被拒絕，不會靜默覆蓋。
- `export_docx`、`export_pdf`、`export_text` 能產生檔案；溢出時預設拒絕。
- 可透過 `MCP_TRANSPORT=stdio` 接本機 MCP client，也可透過 `http://localhost:8787/mcp` 使用 Streamable HTTP。
- Server 提供 tools、resources、prompts，且工具 schema 與安全標記明確。
- `render_answer_sheet` 透過 `_meta.ui.resourceUri` 掛載畫板；畫板優先使用元件專用 `_meta.snapshot` 顯示逐行版面，其次使用 full `structuredContent`，並透過 MCP bridge 呼叫版面檢查與預覽／套用修改。

## 10. 明確不納入 v1

- 照片／掃描／手寫 OCR。
- 自動判斷考場實際格紙的拍攝透視與字跡大小。
- 模型本身的語意評分或採點正確性保證。
- 多使用者帳號、身份驗證、雲端同步。
- 獨立於 ChatGPT 之外的瀏覽器側欄或桌面視窗；目前由 ChatGPT 宿主顯示內嵌 App iframe，並提供宿主支援的放大模式。



## 原稿紙畫板整合

`render_answer_sheet` 回傳最新答案、版本、LayoutReport 及 warningCount（該版面的品質警告數）。UI 中繼資料提供唯讀狀態；166 模式另提供兩頁原稿紙 SVG，採原始底圖與字型輪廓，無需在 iframe 載入外部字型。畫板只顯示設定頁數，溢出行數由狀態列提示，避免建立無限頁面。

多題只呼叫一次 `render_exam_overview`：預設 responseDetail=summary，模型端 structuredContent 只回傳目前題目的答案 id／版本及版面統計（totalLines、capacity、fits、overflowLines）、activeAnswerId 與依輸入順序排列的 examAnswers（題號、版本、行數、容量、fits、警告數）。同時回傳目前題目的 warningCount；兩種 render 工具的完整 snapshot（包含 layout.lines 與編輯用 sections）始終放在元件專用 `_meta.snapshot`；重用 responseDetail schema，full 模式也在 structuredContent 回傳完整 snapshot、readOnly（與 _meta.readOnly 相同）及適用的 paperSvgPages。v12 畫板所有自行 render 呼叫均帶 responseDetail=full；讀取順序為結果 _meta.snapshot、full structuredContent、宿主初始輸出的 OpenAI toolResponseMetadata。唯讀狀態依序取結果 _meta.readOnly、structuredContent.readOnly、僅宿主初始輸出的 toolResponseMetadata.readOnly、同答案既有狀態；皆未知時停用編輯。openai:set_globals 只接受同次事件提供且 answerId/version 與 toolOutput 相符的 metadata，不使用殘留全域 metadata；資料不足時只呼叫一次 full render。paperSvgPages 依序取結果 _meta、structuredContent，兩者皆無時僅保留同 answerId/version 已顯示的 SVG，絕不沿用其他答案或版本。逐題驗證並彙整 ANSWER_NOT_FOUND 與 LAYOUT_INVALID <id>：原因（套用與匯出錯誤相同的路徑與堆疊遮蔽），任一失敗皆不顯示部分結果。畫板以分頁切換，左右鍵移動焦點；焦點題目移除時以選取題目作為 Tab 入口。分頁有獨立的無障礙名稱；按下其他分頁透過 render_answer_sheet 載入，重按目前分頁保留草稿。載入若被並行的畫板刷新取代，顯示通知供使用者再次點選，不自動重試；寫入後更新對應分頁統計（包含已切換離開的題目），目前題目只顯示最新已知警告數，顯示清單外答案時隱藏分頁。

畫板遵循 MCP Apps 初始化程序；宿主若提供 `window.openai.callTool` 則使用該 API。預覽後修改草稿會使預覽失效；套用時仍須帶版本。保留原有段落格式；段落數改變時，未改動的段落保留格式，改寫的段落沿用被取代那段的格式。字句修改走 `preview_change`（`edit_text`）再 `edit_text`；上移／下移呼叫 `move_section`；重新編號先以 `preview_change`（`renumber_items`）預覽，第二次點擊才呼叫 `renumber_items`；版本紀錄讀 `list_revisions`，還原呼叫 `restore_revision`。這些工具都宣告 `_meta.ui.visibility` 含 `app`。唯讀連線停用修改；逾時不自動重送。DOM/橋接測試與真實 ChatGPT 宿主驗收分開記錄。

寫入工具預設 `responseDetail: "summary"`，回傳答案識別資訊、版面統計及各節行數；`"full"` 保留完整快照。明確讀取／排版工具仍回傳完整資料。畫板的初始 toolOutput、openai:set_globals 與 ui/notifications/tool-result 收到摘要時，會以 render_answer_sheet 取得完整快照；失敗顯示通知，過期載入不覆蓋較新的畫面。create_answer.lineTargets.sectionId 必須等於 sections 明確提供的 id。`check_layout.warnings` 與合輯逐題 warnings 偵測 `ORPHAN_HEADING`、`SPLIT_LATIN_WORD`，不修改換行或文字，也不阻擋匯出。

`export_exam_bundle.answers` 接受 1–20 個不重複 answerId，重複時逐個在結構化錯誤 answerId 與訊息列出重複 id，逐項指定 expectedVersion。驗證失敗彙整 `ANSWER_NOT_FOUND`、`VERSION_CONFLICT`、`LAYOUT_OVERFLOW`、`LAYOUT_INVALID`，不建立匯出；版本衝突的答案不再檢查版面；所有格式完成繪製後才建立 handle。成功回傳 files、answers 頁碼範圍與 totalPages；PDF 字型警告保留於 files[].fontWarning 與文字結果，逐題品質警告也列於文字結果（含頁／行）。合輯 PDF/DOCX 沿用單題紙張、固定格線、字型與每頁行數規則，每題從新頁開始；DOCX 以 nextPage section 分隔成員，以段落 pageBreakBefore 分隔成員內頁面，第一格含對應題號與標題的書籤，166 同樣嵌入原稿紙與楷書字型。兩種格式頁數相同，無封面或額外空頁；儲存 manifest 新增 optional relatedAnswerIds（最多 20 個 answerId），關聯全部成員；刪除任一成員會回收合輯並計入 deletedExports，舊 manifest 仍有效。後續 createExportHandle 失敗時，以 deleteExport 盡力回收所有先前 handle；錯誤列出失敗格式及回收失敗的遺留 handle。deleteExport 移除 manifest 與 bytes，已不存在時成功，雲端維持 owner／objectName／generation 檢查。

`create_answer.idempotencyKey` 符合 `^[A-Za-z0-9_-]{8,128}$`。id 為 `ans_idem-` 加 SHA-256(key) 前 40 hex；owner 隔離不變。createRequestHash 為 templateId（套用預設）、title、question、exam、questionNo、lineTargets、sections 輸入原貌的排序鍵 JSON SHA-256（只有請求提供 layoutOptions 時才納入該欄位，省略時舊雜湊不變）（optional、64 位小寫 hex；duplicate_answer 不複製）。相同 key／雜湊回傳答案目前版本、replayed=true，不寫入；不同或缺少雜湊回報 IDEMPOTENCY_KEY_REUSED。重送的 TEMPLATE_NOT_FOUND 與 LAYOUT_INVALID 訊息會標明此 key 的既有答案 id；暫時性模板儲存錯誤原樣傳回。create-only 寫入競態後重讀並套用同一規則。無 key 維持原行為。

`create_answers.answers` 為 1–10 個 strict 建立物件（欄位同 create_answer，無 responseDetail）；sections 的公開 schema 保持寬鬆，伺服器共用真實 answerSectionInputSchema 驗證。先檢查全部輸入、模板、唯一 section id／明確 lineTargets id、可計算版面與 key 重用；批次內 key 不可重複。錯誤逐項為「第 N 項 INVALID_INPUT／TEMPLATE_NOT_FOUND／LAYOUT_INVALID／IDEMPOTENCY_KEY_REUSED：原因」，不儲存任何答案。通過後逐項儲存，重送項目不寫入；中途儲存失敗停止並列出已完成 index／id 與失敗項次。相同批次使用原 keys 可安全重試，未給 key 的已建立項目不可直接重送。輸出 answers 含 index（1 起算）、answerId、title、exam?、questionNo?、version、fits、totalLines、capacity、overflowLines、replayed?，不掛載畫板。

單題 `export_answer.textMode` 預設 paper，僅影響 TXT；paragraphs 從 LayoutLine.text 重建顯示標題與各段（去除視覺換行，保留版面編號，不使用填充／對齊空白，捨棄 spacer），每段一行、節間空行。檔名為 *_段落.txt；pages 仍是內容的稿紙頁數，fits／allowOverflow／166 驗證與 paper 相同。read_answer 不宣告 ui.resourceUri 或 openai/outputTemplate；render_answer_sheet／load_exam_paper／create_answer 保留畫板。


### 匯出錯誤與內部欄位

`export_answer`、`export_exam_bundle` 執行失敗回傳 `isError: true`，`structuredContent.errors` 為 `{ code, answerId?, questionNo?, format?, retryable, message }[]`；題號取自已知儲存答案。代碼為 ANSWER_NOT_FOUND、VERSION_CONFLICT、LAYOUT_OVERFLOW、LAYOUT_INVALID、EXPORT_FAILED。驗證失敗 retryable=false；匯出／儲存失敗用 EXPORT_FAILED，僅 Node ETIMEDOUT、ECONNRESET、ECONNREFUSED、EAI_AGAIN、EBUSY、EMFILE、ENFILE、EPIPE 或儲存／HTTP 狀態 408、429、500、502、503、504 為 retryable=true；雲端保留內部 cause，Firestore gRPC 4/8/13/14 對應 408/429/500/503。未知、字型、內容、確定性 renderer 錯誤均不可重試。structuredContent.errors[].message 與文字結果的 Windows/POSIX/file:// 絕對路徑遮蔽為 <path>，移除內部堆疊；部分成功的 failed[].error 同樣處理。單題部分格式成功仍回傳成功 files 與原有 failed，另附失敗格式的 errors，不設 isError；合輯維持全有或全無。SDK client 也會驗證錯誤 structuredContent，因此 outputSchema 以 anyOf 接受原有成功必填欄位或 errors。

舊 export_docx／export_pdf／export_text 可選填 expectedVersion，透過相同 assertExportVersion 在排版或匯出前拒絕過期版本，沿用 VERSION_CONFLICT 文字。PDF 合輯在同一 document 內依字型路徑與 face 共用已註冊字型，不逐題重複開啟及內嵌。createRequestHash 僅保留於儲存，所有工具輸出（完整回應、預覽與元件 metadata 也包括在內）均移除。


## 考試計畫、進度與斷點續寫

- `start_exam`（essay.write）接受 `{ title, questions: [{ questionNo, question?, targetPages? }], formats?, idempotencyKey? }`。題數 1–20、題號 1–20 且唯一，title 最長 100、question 最長 10,000 字元、targetPages 為 1–20；合輯格式僅 pdf／docx，預設 ["pdf", "docx"]。回傳 `examId`、`summary` 與 replayed。key 沿用 8–128 字元的英數、底線與連字號規則；同 key 不同請求回報 IDEMPOTENCY_KEY_REUSED。
- 計畫 `{ id, title, questions: [{ questionNo, question?, targetPages?, answerId? }], formats?, createdAt, updatedAt, version, lastBundle? }` 在 FileStore 的 answers 同層 `answers-exams` 目錄原子替換，CloudStore 在同 principal 路徑的 exams collection 以 Firestore transaction 寫入；examCreateKeys 以 key 雜湊作文件 ID，在同一 transaction 防止跨計畫併發重用 key，刪除計畫時解除預留。FileStore 沿用程序內寫入鎖，計畫寫入序列化並檢查同資料目錄的 key 唯一性。計畫 JSON 上限 256 KiB；所有更新／刪除使用 expectedVersion CAS，更新版本遞增，保留 createdAt。FileStore 與本機答案共用同樣存取邊界；CloudStore 沿用答案的 ownerKey 隔離與唯讀拒寫。
- `create_answer` 與 `create_answers`（最外層及 answers[]）增加可選 examId，最外層與逐題值須一致；exam、questionNo、question 省略時由計畫補入。已連結且仍存在的答案直接回傳既有內容與 replayed=true，不建立新版本；未建立的題目使用依計畫／題號決定的 answerId，併發重送也不重複。key 在 commit 階段以 CAS 預留（批次預驗證不寫入）；儲存失敗時保留同 key 的原請求供重試。內部儲存的 key 請求雜湊只供重送驗證，不輸出給模型或畫板。批次先驗證全部輸入，再逐題儲存；部分 I/O 失敗仍回報已完成項目供續寫。delete_answer 解除所有計畫中的連結並清除已被刪除的 lastBundle，避免重建同 id／版本 1 時誤判已匯出；CloudStore 與答案刪除在同一 transaction 內完成。
- `get_exam_progress`（essay.read，readOnlyHint=true）接受 `{ examId }`。每次由真實答案、當前版面及 lastBundle 釘選版本推導，不保存可過期的 stage 旗標。輸出 `{ examId, title, questions: [{ questionNo, stage, answerId?, version?, totalLines?, capacity?, overflowLines?, warningCount? }], bundle: { status, exportedAt? }, nextStep: { action, questionNo?, message }, summary }`，text content 同樣為 summary，不輸出百分比。
- stage：沒有有效答案為 not_started；不符合容量為 drafted；當前版面通過為 layout_ok；當前版本且版面通過、已收入 lastBundle 為 exported。bundle 為 none／current／outdated；任一成員修改、缺失、計畫格式未涵蓋或成員集合不同即 outdated。nextStep 優先建立最前面的缺題，其次修正最前面的版面，再匯出合輯，最後 done。fits 與 layout_ok 不代表內容查證。
- 另回傳 `delivery: { status, checks: { layoutCapacity, content, source, visual } }`。status 為 not_ready／awaiting_review；只有目前版本與要求格式皆已匯出才是 awaiting_review。layoutCapacity 為 pending／passed，只檢查容量；content、source、visual 固定為 not_checked，因為尚無驗收證據儲存介面。保留既有 nextStep.action 的 done 作為匯出流程終點，摘要改為「合輯已匯出」並明示尚待驗收，不能視為成品品質通過；不因此重複匯出。
- `render_exam_overview` 接受 examId 或 answerIds（二擇一），計畫依題號排序，缺題保留「未建立」分頁，全部缺題也可顯示進度。回傳 progress 與 examAnswers；頂端單一 polite status 區域原地更新，不建立第二個畫板。分頁載入或寫入完成後呼叫 get_exam_progress；保留 OpenAI 與 MCP Apps 的 metadata → full structuredContent → 初始 host metadata 回退，以及未知 readOnly 時停用寫入的規則。
- `export_exam_bundle` 增加 examId；未提供 answers 時由計畫按題號讀取並釘選目前版本，缺題以 ANSWER_NOT_FOUND 與 questionNo 回報。明確提供 answers 時須與計畫成員及順序一致。成功後 CAS 保存 lastBundle `{ formats, pages: { pdf?, docx? }, members: [{ answerId, version }], exportedAt }`；保存失敗同樣回收 handle，保持全有或全無。formats 未提供時依計畫 formats，沒有計畫則預設 ["pdf", "docx"]。合輯不接受 txt 或 textMode；單題 TXT 相容介面保留。計畫在匯出期間改動時重新讀取並最多嘗試三次 CAS，成員順序及釘選版本須仍一致，否則回收 handle。
- 合輯帶 request `_meta.progressToken` 才發送 notifications/progress：驗證成功一次、每格式每題實際完成繪製、每格式合併完成、全部格式與計畫紀錄保存完成。progress 為已完成階段數，total 為 `1 + 題數 × 格式數 + 格式數 + 1`；成功最後一筆等於 total，失敗不宣稱完成。
- 指示詞最短流程為 start_exam → create_answers(examId) → 修正版面 → render_exam_overview(examId) → export_exam_bundle(examId)。全部題目版面通過後自動匯出一次，同一則訊息直接交付 PDF 與 Word 兩個連結，不詢問是否匯出。中斷或「繼續」先 get_exam_progress，將 summary 告知一次，從 nextStep 接續。tools/list 預算維持 80,000 bytes；重複的工作流說明移入 server instructions，既有輸入契約保持不變，僅增加已宣告的可選欄位。

版面無效的舊答案逐題回傳 drafted 與遮蔽路徑的 error，不阻斷 get_exam_progress／render_exam_overview(examId)；修正動作為 fix_layout。完成摘要使用 lastBundle.pages 的實際匯出頁數（舊資料缺少頁數時不猜測）。建立答案後連結 CAS 重試耗盡時，回傳已保存答案及 linkPending/message，提示 get_exam_progress 或相同請求重試；版本衝突以 store error type/code 判斷，重試含退避。FileStore 先重試解除計畫連結，再刪除匯出／版本／答案；兩種 store 均跳過並記錄不可讀計畫。
