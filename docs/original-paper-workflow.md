# 166 原稿紙工作流

## 設定與部署

1. 安裝現有 Node 依賴，執行 `npm ci`。
2. 由教育部下載「教育部標準楷書」5.1：https://language.moe.gov.tw/material/info?m=9fe3fe82-8bbf-44c0-961d-873ea079e284 。使用完整未修改的 `edukai-5.1_20251208.ttf`，遵守官方授權；字型作者為中華民國教育部。本專案未重製或修改字型。
3. 設定 `ESSAY_MCP_PAPER_FONT` 絕對路徑。SHA-256 應為 `e2b6b1bd1d6303672a68d5057a1f1e4b5361e3d8842373ff3bd1c71fb9ea9b98`。字型缺失、版本不符或缺字時停止新模式排版。DOCX 會內嵌答案用字的子集，Word 閱讀端不必安裝此字型；LibreOffice 也使用內嵌字型，但會在中英文交界多留約 0.2 字寬（仍在換行預留範圍內）。
4. 部署時須包含 `templates/` 與 `assets/`，不要只複製 `dist/`。執行 `npm run check`、`npm test`、`npm run build` 後，依原有方式重啟服務；保留原本驗證、存放目錄與 MCP 連線設定。
5. 在實際 MCP 客戶端呼叫 `list_templates`，確認新模板存在，再完成以下流程。

## 題目到交付

1. 模型讀題，列出各小題配分、應答元素及要求數量。研究與來源查核由模型及檢索工具負責，MCP 不自行生成事實或評定正確性。
2. 依配分寫擬答，分成穩定 ID 的 sections；三小題可用 `part_1`、`part_2`、`part_3`。正文與題目另存。
3. 呼叫 `create_answer`，明確指定 `templateId: "police_information_essay_166"`；接著 `write_answer` 寫入 sections。讀取工具當前 schema，使用 `expectedVersion` 避免覆蓋較新的修改。
4. 呼叫 `read_answer`、`check_layout`。系統只換行，不濃縮；若超過 44 行，依壓縮建議提出文字修訂，先用 `preview_change`（`operation: "replace_text"`）預覽，再以 `replace_text` 修改指定 ID，重新檢查。不得為了兩頁悄悄省略採點或縮小字型。
5. 依題目查核概念、三種技術、兩個案例及至少三項措施是否足夠；人工核對證據來源、法律限制及 AI 幻覺風險。這是內容審查，與版面檢查分開。
6. 用同一版答案呼叫 `export_docx`、`export_pdf`。稿紙保留原底圖；沒有額外可見姓名、題名、頁碼及字型說明。
7. Word 須經 LibreOffice 或 Word 實際轉 PDF，再逐頁檢查：兩頁、各 22 行、文字完整、沒有截字、底圖位置不漂移。PDF 輸出也須核對文字及位置。不得只用 DOCX XML 文字或 `layout.fits` 判定通過。Word/LibreOffice 版本差異仍需要實際渲染驗收。

## 相容範圍

新模式目前限定靠左、不使用粗斜體、不使用 tab；縮排與段落空行仍會計入行數。既有一般稿紙模式保留原本格式功能。背景是 166 空白稿紙資產，沒有同學答案正文；以 SHA-256 確認資產完整性。

## 可重現的輸出驗收

`node --import tsx scripts/paper166-smoke.ts blocks.json` 會產生同版的 `layout.json`、`answer.docx` 及 `answer.pdf`。以 Word 或 LibreOffice 將 `answer.docx` 轉出 PDF 後，安裝 PyMuPDF，再分別執行：

```sh
python scripts/verify-paper166.py exports/paper166-qa/layout.json exports/paper166-qa/answer.pdf
python scripts/verify-paper166.py exports/paper166-qa/layout.json /path/to/word-rendered-answer.pdf
```

驗收腳本比對每一行文字、頁數及文字邊界，能抓到只讀 DOCX XML 抓不到的截字與頁面位移。最後仍須開啟兩頁影像目視檢查稿紙與文字。此腳本是部署與交付驗收工具，尚未在每次 MCP export 中自動執行。
