# police-essay-mcp

「國考申論答題紙排版與 AI 編修引擎」的第一版 MCP server。

它把答案保存成有順序的 sections 與可獨立格式化的 paragraphs，透過固定模板計算中英文字寬與實際行數，再提供縮排、對齊、段落間距、Tab、標題粗體／編號、局部修改、溢出檢查與 DOCX/PDF 固定格線輸出。預設模板是 A4、2 頁、每頁 22 行。

## 執行

```powershell
npm install
npm run build
npm start
```

預設 MCP endpoint：`http://127.0.0.1:8787/mcp`。

健康檢查：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/health
```

本機 stdio 模式：

```powershell
$env:MCP_TRANSPORT = "stdio"
npm start
```

可用環境變數：

- `PORT`：HTTP port，預設 `8787`
- `HOST`：綁定位址，預設 `127.0.0.1`
- `ESSAY_MCP_TEMPLATE_DIR`：模板目錄
- `ESSAY_MCP_ANSWER_DIR`：答案 JSON 目錄
- `ESSAY_MCP_EXPORT_DIR`：DOCX/PDF 輸出目錄
- `ESSAY_MCP_PDF_FONT`：PDF 使用的中文字型檔路徑
- `ESSAY_MCP_PDF_BOLD_FONT`：PDF 粗體段落使用的中文字型檔路徑

## 驗證

```powershell
npm run check
npm test
```

若要接 ChatGPT Developer Mode，將本機 `/mcp` 透過 HTTPS tunnel 暴露後，使用 tunnel URL 加上 `/mcp` 建立 app；工具描述或 resource URI 更新後，需在 ChatGPT 中重新整理 app。

## 工具工作流

1. `load_exam_paper` 讀取模板。
2. `create_answer` 建立文件，或 `write_answer` 寫入 sections。
3. `read_answer` / `check_layout` 讀取真實行數。
4. 超出時依 `compressionHints` 使用 `replace_text` 濃縮指定區塊。
5. `fits=true` 後呼叫 `export_docx`、`export_pdf` 或 `export_text`。

## 正式格式

`sections[].paragraphs[]` 可讓每個段落使用獨立格式；格式欄位的縮排與 Tab 單位都是顯示欄位：

```json
{
  "id": "body",
  "heading": "防制措施",
  "headingStyle": { "numbered": true, "bold": true },
  "text": "第一段\n第二段",
  "paragraphs": [
    {
      "text": "第一段",
      "format": { "firstLineIndent": 2, "alignment": "justify", "spaceAfterLines": 1 }
    },
    {
      "text": "第二段\t補充說明",
      "format": { "leftIndent": 2, "tabSize": 4, "alignment": "distributed" }
    }
  ]
}
```

可用對齊值為 `left`、`right`、`justify`、`distributed`。`spaceBeforeLines` 與 `spaceAfterLines` 會實際佔用答題格紙行數；Word 會輸出正式段落屬性，PDF 與 TXT 會依相同欄位模型定位文字。

完整 v1 契約與排版規則請看 [SPECIFICATION.md](SPECIFICATION.md)。
