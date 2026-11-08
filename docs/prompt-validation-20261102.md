# MOE follow-up verification

The following later result supersedes the earlier 27-unexecuted snapshot. The exact existing font C:/Users/Administrator/work/private-fonts/edukai-5.1_20251208.ttf exists (15,820,064 bytes) and SHA256 equals e2b6b1bd1d6303672a68d5057a1f1e4b5361e3d8842373ff3bd1c71fb9ea9b98. No font copied, replaced, modified or distributed.

Full npm test rerun with this process-only ESSAY_MCP_PAPER_FONT, existing LibreOffice on PATH, and the same pinned baseline/codec checkouts: 360 tests, 353 pass, 0 fail, 7 skip, 0 cancelled. All 20 previously font-blocked tests and the Tab rendering test now executed successfully. Raw evidence: ../prompt-review-20261101/full-tests-moe-20261102.tap. No source/layout/schema/dependency change was needed.

Remaining: 6 Linux-specific Noto/render tests plus 1 real Firestore emulator test. Existing Firebase emulator caches and Cloud SDK platform directory had no Firestore emulator. Read-only docker image ls in the default execution context failed with permission denied connecting to npipe:////./pipe/dockerDesktopLinuxEngine; no image inventory obtained and no container created. Do not interpret this as proof that no images exist: the Docker packaging regression within the approved full-test context still passed. No retry, WSL fallback, security change, credential access or download was attempted.

Minimum next step: separately authorize only read-only Docker inventory in a permitted execution context, then determine whether an already-present Linux verification/emulator image can run the missing seven tests offline. If absent, obtain explicit approval for a bounded test-only Linux/emulator environment with the required Noto TTC fonts, Poppler, Python, LibreOffice, Node and emulator; no production credentials or data, and no unapproved image/package download. Current single offline-test approval is not treated as permission for installing new prerequisites.

Actual MCP draft common body was checked to match the captured real response suffix byte-for-byte; five-type guide was extracted from its structuredContent, not reconstructed. Readable export: ../prompt-review-20261101/readable-draft-and-guide-20261102.txt. No model execution or score claimed. Earlier execution history below retained.

---

# 提示詞本機完整驗證紀錄

基準為3d536c067a56bb6ab3ce8200d1bf2f9ff5b58253。本輪經使用者明確同意後，在原隔離工作區執行離線安裝與測試，沒有推送、合併或部署。Node 24.19.0、Python 3.12.14、Windows LibreOffice 26.8.0.3。lockfile SHA256為a5866c1be21538f593654e5da778cad37f7b3e1b8f191f821201dd9dfa32036f，未更動依賴或執行生命週期腳本。

## 執行結果

- `npm ci --offline --ignore-scripts --no-audit --no-fund --cache ../.npm-cache`：成功，295個套件；沒有轉為線上安裝。安裝顯示既有依賴deprecated警告，未在本輪擴大升級。
- `npm run check`、`npm run build`：修正後均exit 0。先前transpileModule未抓到的四個測試型別錯誤確實存在；以SDK的CallToolResultSchema解析真回應，未移除原本斷言。
- `npm test`：最後360項，332通過、0失敗、28略過、0取消；逐項清單在下節。另補跑Tab真渲染1項通過、0略過，故原360項仍有27項未執行，不能稱全部通過。
- 真SDK InMemory：initialize、prompts/get、resources/read、讀取工具與正負向指引測試通過；實際保存六組draft、compress、workflow與guide回應。guide版本essay-guide-20261102.4。
- 真HTTP loopback唯讀客戶端：列出12個讀取工具，可由load_exam_paper取得guide；saveAnswer設為寫入即失敗，測得0次答案寫入。這不是ChatGPT原生connector重載驗收。
- 基準18cb176的合約來源重建及a3792bb實際舊codec比較通過；使用本機既有Git物件，未下載或重寫正式答案。歷史checkout作為測試依賴保存於node_modules/.validation-contract-base與.validation-released-codec。
- Docker真build context的敏感fixture排除測試通過；不是僅靜態規則檢查。
- `npm run test:render`：一般模板PDF與DOCX各2頁，均真正render；使用現行官方render_docx.py與已安裝Windows LibreOffice，REQUIRE_DOCX_RENDER=true。逐頁開啟四張PNG檢查，文字可讀，未見缺字、重疊或裁切，第二頁空格線保留。兩種格式的字距分配不同，不宣稱像素相同，也不將此一般模板當165理想外觀。
- 補跑tests/pdf-tab-stops.test.ts：僅本次PATH加入既有LibreOffice後真實PDF/DOCX定位測試通過。沒有重試Word COM。

## 測出問題及修正

writing-guide.test.ts原本直接存取SDK聯集回應，完整tsc報四個錯誤；改用正式CallToolResultSchema解析，保留正負向內容驗證。

第一輪全套359項為328通過、1失敗、30略過：合約檢查器只允許基準輸出欄位，尚未聲明先前已加入的選填writingGuide。修正僅正規化load_exam_paper這個確定的選填、無約束輸出；新增必填、改型別、遺漏、其他工具及其他未知欄位的反向斷言，通用assertSchemaSubset保持嚴格。未改工具、輸入、正式輸出或儲存schema，未改固定baseline fixture。

第二輪360項為331通過、1失敗、28略過：本輪暫存的歷史checkout位於output，文件掃描器讀到歷史widget URI；移到既有排除的測試依賴區後重跑，沒有修改文件掃描斷言。最後全套零失敗。三輪原始log均保留，沒有以刪skip、改斷言或mock渲染來取得綠燈。

## 未執行條件與界線

20項165/166測試缺SHA相符的MOE標準楷書5.1。已查現有工作區、Documents、Downloads及已知字型位置，未找到正式字型；Windows的TW-Kai-98_1.ttf SHA為bcb24f8c063ae137a980192a9e504976e55a02644881322c969546512e28de55，與要求不符，沒有替換或放寬校驗。最小解鎖方式為提供既有合法字型的可讀路徑，設定本次ESSAY_MCP_PAPER_FONT後重跑這20項；目前不宣稱44/45行、165/166實際幾何或專用成品通過。

1項Firestore emulator測試缺FIRESTORE_EMULATOR_HOST且未發現既有本機emulator；沒有連真雲端代替。最小條件是本機可用的Firestore emulator及loopback地址。

6項Linux環境測試尚未跑：3項Noto TTC face測試硬編碼/usr/share/fonts/opentype/noto；issue-sweep的#30/#32/#34也以該Noto字型及Linux命令判斷前置條件。最小條件是已有相同鎖定依賴與指定Noto字型、pdftotext、Python、LibreOffice的Linux驗證環境。沒有改路徑、刪skip或用一般render冒充這些斷言。

掃描Temp尋找舊字型時部分無關目錄回報AccessDenied，已停止該掃描，未升權重讀那些目錄。這不是測試或安裝待批准；本輪安裝與已執行測試的批准都已完成。

本輪沒有模型呼叫或評分。實際MCP輸出artifact可供獨立內容盲評；既有首輪負向與第二輪有限改善紀錄仍保留。未部署，因此目前線上與原生connector仍不能算本版驗收。

## 原始證據

本機證據目錄為同層工作區的prompt-review-20261101：typecheck-final-20261102.log、build-final-20261102.log、full-tests-clean-20261102.tap、tab-render-20261102.tap、render-20261102.log、actual-mcp-guidance-20261102.json、http-guidance-20261102.json；render-20261102內含兩種格式及四張實際頁面PNG。沒有把log與私人字型提交進Git。

最後全套略過ID如下；ID只對應上述最後TAP。255已另行補跑通過，其餘未跑。

```text
ok 43 - single, batch and exam omitted templates use 165; explicit overrides and existing answers survive # SKIP
ok 72 - prompt changes retain actual 165/166 geometry and 44/45-line overflow behavior # SKIP
ok 111 - 166 bundle shares its single PDF font and two-page policy # SKIP ESSAY_MCP_PAPER_FONT not set
ok 128 - 166 overview carries exactly the active answer's paper preview metadata # SKIP ESSAY_MCP_PAPER_FONT not set
ok 142 - render tools opt into full structured snapshots (166 SVG) while defaults stay compact # SKIP ESSAY_MCP_PAPER_FONT not set
ok 147 - 166 bundle DOCX shares embedded font, paper background and exact page counts with PDF # SKIP ESSAY_MCP_PAPER_FONT not set
ok 151 - real Firestore emulator: create, CAS, independent locks, revisions, ordering and 1 MiB limit # SKIP Firestore emulator ?芷?霅??芾身摰?FIRESTORE_EMULATOR_HOST嚗???蝡胯?  ---
ok 155 - the 166 paper accepts numbered headings without asking to turn off bold # SKIP ESSAY_MCP_PAPER_FONT not set
ok 182 - \#30 Unicode separators survive actual PDF and DOCX rendering # SKIP
ok 184 - \#32 PDF keeps every character on a full-width ASCII line # SKIP
ok 186 - \#34 distributed final lines span the PDF grid and match the DOCX positions # SKIP
ok 196 - split warnings reach check, bundle and overview with the 166 template # SKIP
ok 237 - 166 measured wrapping preserves mixed text, punctuation and all characters # SKIP
ok 238 - 166 whole Latin words use measured next-line width and preserve punctuation carry # SKIP
ok 239 - 166 exports reject 45 lines even when an overflow override is requested # SKIP
ok 240 - 166 full-run lookahead avoids oversized and whitespace-only moves, including punctuation carry # SKIP
ok 241 - 166 split warnings use full-run font widths and non-first-line available width # SKIP
ok 242 - 166 asset does not appear as a template and invalid formatting does not persist # SKIP
ok 243 - 166 canvas preview keeps two original pages even when content overflows # SKIP
ok 244 - 166 canvas preview defines each glyph outline once per page and places every glyph # SKIP
ok 246 - 166 Word export embeds the used paper glyphs so Word renders without the installed font # SKIP
ok 249 - 166 real PDF and SVG share all 22 baselines and preserve mixed-script spaces # SKIP
ok 250 - 165 and legacy 166 preserve identical wrapping, SVG, DOCX geometry and PDF drawing coordinates # SKIP approved MOE font unavailable; actual paper rendering remains unverified
ok 251 - 166 PDF and SVG preserve mixed-script text at all 44 calibrated baselines # SKIP
ok 252 - exported PDF embeds the Traditional Chinese (CJKtc) face, not the Japanese face # SKIP
ok 253 - exported PDF embeds the bold Traditional Chinese face when bold lines are present # SKIP
ok 254 - a renamed Noto collection still selects its Traditional Chinese face by metadata # SKIP
ok 255 - PDF Tab 撠?蝑??潭?雿???DOCX 摰?暺撌桀???2pt # SKIP
```
