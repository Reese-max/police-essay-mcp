# 國考申論答題紙 MCP — 需求規格 v1

## 1. 目標與範圍

本專案把「警察資訊三等申論答案」建模成可讀、可寫、可局部修改、可重新排版與可匯出的 MCP 文件，而不是一段游離文字。

v1 的預設模板為：

- 紙張：A4
- 頁數：2 頁
- 每頁：22 行
- 總容量：44 行
- 預設寬度：42 個顯示欄位；全形中文字占 2 欄，ASCII 字元占 1 欄
- 版面設定全部由 template JSON 提供，不寫死在排版器中

MCP 後端是唯一的行數真相來源。模型可以產生內容與提出修改，但不得自行估算「大約幾行」來取代後端計算。

## 2. 核心不變條件

1. 答案一定隸屬於一個模板與一組有順序的 sections。
2. 每個 section 都有穩定 `id`、文字、必要性、採點優先級與可壓縮程度。
3. 每次讀取、寫入或局部修改，都可以得到同一套 `LayoutReport`。
4. `totalLines` 由固定欄寬的 deterministic wrapping 計算；不得用 token 數或模型估計替代。
5. `fits=true` 才代表符合模板的頁數／行數限制。
6. 局部修改使用 `expectedVersion` 時，版本不一致必須拒絕，避免舊內容覆蓋新內容。
7. DOCX 與 PDF 預設拒絕輸出溢出版；只有明確指定 `allowOverflow=true` 才能輸出供除錯使用的溢出版。

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
  "marginsMm": { "top": 16, "right": 15, "bottom": 16, "left": 15 }
}
```

`columns` 是顯示欄位，不是 JavaScript 字元數。這使中文、英文、數字與標點在同一個計算模型中可重現；未來若試卷欄寬不同，只需新增模板。

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

## 5. Tools 契約

| Tool | 作用 | 是否改變狀態 |
| --- | --- | --- |
| `list_templates` | 列出可用模板 | 否 |
| `load_exam_paper` | 讀模板，或依 `answerId` 載入答案與版面 | 否 |
| `list_answers` | 列出已儲存答案 | 否 |
| `create_answer` | 建立答案文件，可附初始 sections | 是 |
| `read_answer` | 讀完整 sections、版本、逐行結果與版面報告 | 否 |
| `write_answer` | 以完整 sections 覆寫答案後重新計算 | 是 |
| `replace_text` | 替換指定 `sectionId`，保留其他段落 | 是 |
| `insert_text` | 在指定段落後插入新 section | 是 |
| `delete_text` | 刪除指定 section | 是，具破壞性標記 |
| `reflow_answer` | 重新計算固定欄寬、分頁與行數 | 否 |
| `check_layout` | 回傳每頁使用量、剩餘量、溢出量與濃縮提示 | 否 |
| `export_docx` | 產生 A4 固定格線 Word | 是，建立檔案 |
| `export_pdf` | 產生 A4 固定格線 PDF | 是，建立檔案 |
| `export_text` | 產生依實際換行與分頁的純文字 | 是，建立檔案 |

所有修改工具接受可選 `expectedVersion`。寫入成功後 `version + 1`，並回傳更新後的 authoritative snapshot。

## 6. Resources 與 Prompts

Resources：

- `essay://templates/police_information_essay`：模板 JSON。
- `essay://instructions/workflow`：讀取、修改、檢查與匯出的工作流程。

Prompts：

- `draft_answer`：提示模型先分段，再呼叫 `create_answer` / `write_answer`，最後驗證 `fits`。
- `compress_answer`：提示模型依 `compressionHints` 濃縮非核心內容，反覆檢查到符合容量。

## 7. 排版演算法

1. 依 `order` 排序 sections。
2. 每個 section 先組合 `heading + "\\n" + text`；保留顯式換行。
3. 每個段落逐 code point 累加顯示欄位：
   - CJK、全形標點、emoji 等寬字元：2
   - ASCII、半形標點與一般字元：1
   - combining mark：0
   - tab：4
4. 下一個字元會超過 `columns` 時，結束目前行並開始下一行。
5. 將全域行號映射到：
   - `page = ceil(globalLine / linesPerPage)`
   - `lineOnPage = ((globalLine - 1) mod linesPerPage) + 1`
6. `capacity = pages * linesPerPage`。
7. `overflowLines = max(0, totalLines - capacity)`；`remainingLines = max(0, capacity - totalLines)`。
8. 對超出版按 `compressible` 降冪、`priority` 升冪、目前行數降冪排序，形成提示；後端不自行重寫語意。

這個演算法只負責「真實占幾行」。語意濃縮仍由模型提出新文字，再透過 `replace_text` 寫回並重新驗證。

## 8. 匯出流程

```text
read answer
  → layoutSections(template, sections)
  → fits == true ?
      → DOCX: 每頁一個 22-row table，固定列高與框線
      → PDF: A4 page，繪製 22 條橫線與左右邊界，再寫入文字
  → fits == false：拒絕輸出，除非 allowOverflow=true
```

DOCX 會保留兩頁空白格線，即使答案未填滿；PDF 會嘗試尋找 Windows 的 Microsoft JhengHei 或系統 Noto CJK 字型。若找不到中文字型，工具回傳 `fontWarning`，避免使用者誤以為字型嵌入已完成。

## 9. v1 驗收條件

- 能建立、讀取、完整寫入與局部修改答案。
- 44 行剛好填滿時回傳 `fits=true`、兩頁各 `22/22`。
- 第 45 行起回傳 `overflowLines`，並提供濃縮順序。
- 中英混排、明確換行與空白行可重現計算。
- 版本衝突會被拒絕，不會靜默覆蓋。
- `export_docx`、`export_pdf`、`export_text` 能產生檔案；溢出時預設拒絕。
- 可透過 `MCP_TRANSPORT=stdio` 接本機 MCP client，也可透過 `http://localhost:8787/mcp` 使用 Streamable HTTP。
- Server 提供 tools、resources、prompts，且工具 schema 與安全標記明確。

## 10. 明確不納入 v1

- 照片／掃描／手寫 OCR。
- 自動判斷考場實際格紙的拍攝透視與字跡大小。
- 模型本身的語意評分或採點正確性保證。
- 多使用者帳號、身份驗證、雲端同步。
- 互動式 iframe 格紙 UI；目前保留 resources 與 structuredContent，後續可依 MCP Apps 加入。
