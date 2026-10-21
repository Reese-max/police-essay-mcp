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
| `create_answer` | 建立答案文件，可附初始 sections | 是 |
| `read_answer` | 讀完整 sections、版本、逐行結果與版面報告 | 否 |
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
| `export_answer` | 一次輸出多種格式，檔名用考試、題號與標題 | 是，建立檔案 |
| `reflow_answer` | 重新計算固定欄寬、分頁與行數 | 否 |
| `check_layout` | 回傳每頁使用量、剩餘量、溢出量與濃縮提示 | 否 |
| `render_answer_sheet` | 回傳 authoritative snapshot 並掛載 ChatGPT Apps SDK 互動畫板 | 否 |
| `export_docx` | 產生 A4 固定格線 Word | 是，建立檔案 |
| `export_pdf` | 產生 A4 固定格線 PDF | 是，建立檔案 |
| `export_text` | 產生依實際換行與分頁的純文字 | 是，建立檔案 |

所有修改工具接受可選 `expectedVersion`。寫入成功後 `version + 1`，並回傳更新後的 authoritative snapshot。

`preview_change` 回傳 `changeId`、`baseVersion`、修改前後 snapshot、行數差異與 `fits` 結果，但不會寫入檔案；確認後必須以相同的 `expectedVersion` 呼叫正式修改工具。若期間答案已被其他修改更新，版本檢查會拒絕套用。

## 6. Resources 與 Prompts

Resources：

- `essay://templates/police_information_essay`：模板 JSON。
- `essay://instructions/workflow`：讀取、修改、檢查與匯出的工作流程。
- `ui://widget/police-essay-answer-sheet-v5.html`：ChatGPT Apps SDK 的互動答題紙畫板資源（URI 帶版本，畫板或其呼叫的工具改變時遞增，讓宿主不沿用快取的舊畫板）。

Prompts：

- `draft_answer`：提示模型先分段，再呼叫 `create_answer` / `write_answer`，最後驗證 `fits`。
- `compress_answer`：提示模型依 `compressionHints` 濃縮非核心內容，反覆檢查到符合容量。

## 7. 排版演算法

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
- `render_answer_sheet` 透過 `_meta.ui.resourceUri` 掛載畫板；畫板使用 `structuredContent` 顯示真實行數，並透過 MCP bridge 呼叫版面檢查與預覽／套用修改。

## 10. 明確不納入 v1

- 照片／掃描／手寫 OCR。
- 自動判斷考場實際格紙的拍攝透視與字跡大小。
- 模型本身的語意評分或採點正確性保證。
- 多使用者帳號、身份驗證、雲端同步。
- 獨立於 ChatGPT 之外的瀏覽器側欄或桌面視窗；目前由 ChatGPT 宿主顯示內嵌 App iframe，並提供宿主支援的放大模式。



## 原稿紙畫板整合

`render_answer_sheet` 回傳最新答案、版本及 LayoutReport。UI 中繼資料提供唯讀狀態；166 模式另提供兩頁原稿紙 SVG，採原始底圖與字型輪廓，無需在 iframe 載入外部字型。畫板只顯示設定頁數，溢出行數由狀態列提示，避免建立無限頁面。

畫板遵循 MCP Apps 初始化程序；宿主若提供 `window.openai.callTool` 則使用該 API。預覽後修改草稿會使預覽失效；套用時仍須帶版本。保留原有段落格式；段落數改變時，未改動的段落保留格式，改寫的段落沿用被取代那段的格式。字句修改走 `preview_change`（`edit_text`）再 `edit_text`；上移／下移呼叫 `move_section`；重新編號先以 `preview_change`（`renumber_items`）預覽，第二次點擊才呼叫 `renumber_items`；版本紀錄讀 `list_revisions`，還原呼叫 `restore_revision`。這些工具都宣告 `_meta.ui.visibility` 含 `app`。唯讀連線停用修改；逾時不自動重送。DOM/橋接測試與真實 ChatGPT 宿主驗收分開記錄。
