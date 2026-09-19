# police-essay-mcp

「國考申論答題紙排版與 AI 編修引擎」的第一版 MCP server。

它把答案保存成有順序的 sections，透過固定模板計算中英文字寬與實際行數，再提供局部修改、溢出檢查、DOCX/PDF 固定格線輸出。預設模板是 A4、2 頁、每頁 22 行。

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

完整 v1 契約與排版規則請看 [SPECIFICATION.md](SPECIFICATION.md)。
