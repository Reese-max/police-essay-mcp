# 165/166 新稿的緊湊段落

結構化版新增 `layoutOptions.compactPaper`：MCP 新建165/166預設true。無特殊格式時，短heading與首段合併渲染，移除空文字段；長標題保留自然獨立折行，空正文不隱藏。原始heading/text/paragraphs仍保存，不做資料清洗；`compactPaper:false`可保留獨立標題及空段。歷史答案沒有此旗標時維持原樣，general即使帶true也不套用。顯式非預設段距、縮排、強調或heading格式優先，整節保持原格式；明設0／left等預設值不會誤認為特殊意圖。

此版與下述原先「只改指引」的驗證不同，必須另跑 `scripts/structured-paper-regression.ts`，其before/after傳入完全相同的heading＋text，只有緊湊旗標不同。儲存透過既有layoutExtensions封裝保留舊strict-reader可讀性；舊版忽略新選項的版面效果，不能宣稱回退版本仍有相同排版。

完整空section修正：compactPaper=true時，完全空白且無特殊格式的section保留來源但佔0行，不只依isSpacer判斷。非空標題而正文缺漏仍保留供複查；明確非預設格式、false opt-out及未啟用旗標的歷史答案保持原樣。已有compactPaper=true的記錄會採修正後渲染；既有不可變匯出檔不改寫，若需新呈現必須重新匯出。此規則不代表空答案已完成或語義通過。

短標題先以顯示寬度 `columns-2` 篩選，再以正式字型與相同Word預留寬度確認「標題＋冒號＋第一個正文grapheme」放得下；沒有位置就保留獨立標題，實際文字仍自然折行。緊湊是可逆的渲染選項，不會從儲存原文刪字。編輯時從read_answer取得原始heading／text，分別修改；不要把合併後的整行當作原始text或跨欄位find。舊答案只有在明確以update_answer_info帶expectedVersion開啟compactPaper後才改變呈現。原模板不支援的格式仍按原規則拒絕，不因緊湊而偷偷換字型或取消格式。

新稿的短標題可與首句同段，例如：

```json
{"id":"intro","text":"壹、前言：依職務需求配置權限，並保留複核程序。"}
```

此手動同列範例的text已含標題，不要再重複指定heading。結構化新稿可改傳獨立heading與不含標題的text，由compactPaper渲染同列；需要獨立標題則明設false。正文以單一換行分段，不放首尾空行或空白段；不需段距就不要指定 `spaceBeforeLines`／`spaceAfterLines`。不同小問仍各有可辨識編號與穩定 section id，不為省行刪除必要論證。

`read_answer`／`render_answer_sheet` 有逐行資料；配合 `check_layout` 的總行數核對。空文字段、顯式段距和 `keepHeadingWithNext` 跨頁補位是不同來源；短尾行不是空行。模板預設段前、段後都是零，本輪未發現引擎自行在一般段落間多插一空行的證據。

指引本身不呼叫模型；結構化緊湊由共用版面引擎執行。`draft_answer`、`compress_answer` 的實際 `prompts/get`、共用複查指令，以及原生客戶端可讀的 `load_exam_paper.writingGuide.paperLayout` 都能取得規則與同列範例。指引版本 `essay-guide-20261103.2`。生成者仍須採用規則、寫入後核算，不能把提示詞修改等同每次模型都會遵守。

沒有改模板、字型、格線或舊答案。結構化版本增加可選版面旗標及渲染分支；原先指引版沒有引擎改動。新建預設以外不全域自動合併段落。

## 重複驗證

設定既有合格教育部楷書的 `ESSAY_MCP_PAPER_FONT` 後執行：

```sh
node --import tsx --test tests/compact-paper.test.ts tests/writing-guide.test.ts
node --import tsx scripts/compact-paper-regression.ts
```

後者透過真正 MCP in-memory transport 和隔離 FileStore，使用自製教學文字而非正式答案。五題型各比較首尾空段＋獨立 heading 與同列輸入，再匯出合輯的 PDF／DOCX。產物在 `output/pdf/compact-paper/`；該目錄不應提交或當成手機可下載連結。

本次三段短文的機械重現為 12→3 行；五題型分別為 7→4、8→5、8→5、8→5、8→6 行。合輯使用另一組「只在段尾留一空段」的前態，34→26 行，兩者都保留兩頁；DOCX 都有 44 列。這些是同一正文的輸入表示比較，沒有刪論證或縮小字級，也不是 LLM A/B、原分享檔的重現或高分證據。

原分享實檔不在手邊，不能據此斷言當次空行必由哪個欄位造成。若要改那份既有答案，須先取得其實際內容／逐行布局，定位是空段、段距、獨立標題還是跨頁補位，再依修改授權處理，不能自動批次遷移。
