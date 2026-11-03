# 165/166 新稿的緊湊段落

新稿的短標題可與首句同段，例如：

```json
{"id":"intro","text":"壹、前言：依職務需求配置權限，並保留複核程序。"}
```

不要同時另設 `heading`，因為它依既有契約獨占一行。正文以單一換行分段，不放首尾空行或空白段；不需段距就不要指定 `spaceBeforeLines`／`spaceAfterLines`。不同小問仍各有可辨識編號與穩定 section id，不為省行刪除必要論證。

`read_answer`／`render_answer_sheet` 有逐行資料；配合 `check_layout` 的總行數核對。空文字段、顯式段距和 `keepHeadingWithNext` 跨頁補位是不同來源；短尾行不是空行。模板預設段前、段後都是零，本輪未發現引擎自行在一般段落間多插一空行的證據。

這是呼叫者指引，沒有新增自動轉換或模型。`draft_answer`、`compress_answer` 的實際 `prompts/get`、共用複查指令，以及原生客戶端可讀的 `load_exam_paper.writingGuide.paperLayout` 都能取得規則與同列範例。指引版本 `essay-guide-20261103.1`。生成者仍須採用規則、寫入後核算，不能把提示詞修改等同每次模型都會遵守。

沒有改模板、字型、格線、版面引擎、儲存 schema、既有 API 或舊答案。使用者明確要求的獨立標題／留白及其他模板保持原樣；不為省一行全域自動合併段落。

## 重複驗證

設定既有合格教育部楷書的 `ESSAY_MCP_PAPER_FONT` 後執行：

```sh
node --import tsx --test tests/compact-paper.test.ts tests/writing-guide.test.ts
node --import tsx scripts/compact-paper-regression.ts
```

後者透過真正 MCP in-memory transport 和隔離 FileStore，使用自製教學文字而非正式答案。五題型各比較首尾空段＋獨立 heading 與同列輸入，再匯出合輯的 PDF／DOCX。產物在 `output/pdf/compact-paper/`；該目錄不應提交或當成手機可下載連結。

本次三段短文的機械重現為 12→3 行；五題型分別為 7→4、8→5、8→5、8→5、8→6 行。合輯使用另一組「只在段尾留一空段」的前態，34→26 行，兩者都保留兩頁；DOCX 都有 44 列。這些是同一正文的輸入表示比較，沒有刪論證或縮小字級，也不是 LLM A/B、原分享檔的重現或高分證據。

原分享實檔不在手邊，不能據此斷言當次空行必由哪個欄位造成。若要改那份既有答案，須先取得其實際內容／逐行布局，定位是空段、段距、獨立標題還是跨頁補位，再依修改授權處理，不能自動批次遷移。
