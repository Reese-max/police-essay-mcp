# Figma 樣板

這份文件記錄 `police-essay-mcp` 的 Figma 操作樣板，作為視覺規格、產品展示與後續 UI 實作的共同入口。

- Figma 檔案：[Police Essay MCP｜申論答題紙樣板](https://www.figma.com/design/SBAKYNQQh3Mzv8MFKFwIrX)
- 檔案版型：Desktop 1440 × 1024
- 答題紙示意：A4 固定格線；工具層遵循 A4、2 頁、每頁 22 行的模板契約
- 目前檔案狀態：已建立可編輯的元件、變數與文字樣式

> Figma 檔案是視覺規格與操作入口；實際資料驗證、行數計算與輸出仍以 MCP 工具及模板契約為準。

## 畫面結構

- Header：產品名稱、申論類型、MCP 連線狀態與匯出入口。
- Toolbar：答案麵包屑、編輯／版面檢查／匯出設定分頁，以及目前容量 `42 / 44 行`。
- Paper preview：A4 答題格紙預覽，使用可重複的 `Essay Grid Row` 元件呈現行格與範例內容。
- Formatting inspector：對齊、首行縮排、左／右縮排、段前／段後行數、Tab 寬度與標題樣式。
- Layout status：以 `check_layout` 對應的狀態卡呈現已用行數、剩餘行數與可匯出狀態。

## Figma 節點對照

| 用途 | 節點 |
| --- | --- |
| Desktop 樣板外框 | `2:19` — `Police Essay MCP / Desktop Template` |
| A4 答題紙預覽 | `4:159` |
| 答題格行元件 | `4:160` — `Component / Essay Grid Row` |
| 格式化檢查器 | `4:155` |
| 色彩變數集合 | `Police Essay / Color` |
| 文字樣式 | `Police Essay / Display`、`Heading`、`Body`、`Caption` |

## 與 MCP 工具的對應

| Figma 操作區 | MCP 契約／工具 |
| --- | --- |
| 答題內容與區段 | `create_answer`、`write_answer` |
| 段落格式化 | `format_section`；支援 `firstLineIndent`、`leftIndent`、`rightIndent`、`alignment`、`spaceBeforeLines`、`spaceAfterLines`、`tabSize` |
| 版面檢查 | `check_layout`；以實際模板行數作為判定來源 |
| 匯出 | `export_docx`、`export_pdf`、`export_text` |
| 內容濃縮 | `replace_text`；依 `compressionHints` 修正指定區塊 |

## 字型與實作界線

來源模板要求 Microsoft JhengHei；目前 Figma 連線環境沒有該字型，因此樣板使用可用且接近的 Noto Sans TC（Regular、Medium、Bold）。這不會改動專案中的來源模板或輸出字型設定。

Figma 內的文字、容量數字與連線狀態是展示用內容，不是 MCP 的即時資料。若要做前端實作，應以 MCP 回傳的答案資料、格式欄位與 `check_layout` 結果驅動畫面。

## 使用方式

1. 先在 Figma 開啟樣板，複製或延伸 Desktop 樣板外框。
2. 以 `Essay Grid Row` 元件維持答題格紙的固定行高與一致間距。
3. 將格式化檢查器欄位映射到 `format_section` 的 `paragraphFormats`。
4. 將版面狀態映射到 `check_layout`；只有在 `fits=true` 時才進入 DOCX、PDF 或文字匯出流程。

## 迭代後的安全編修流程

修改內容或格式前，先使用 `preview_change`（`operation` 填要預覽的修改工具，其餘參數與該工具相同）取得 before/after snapshot、行數差異與 `fits` 結果；確認後再以相同的 `expectedVersion` 套用正式修改。Figma 畫面中的容量狀態應以 MCP 回傳的 `check_layout` 為準。
