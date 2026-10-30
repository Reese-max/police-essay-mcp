# 小問與驗收清單實測紀錄（2026-10-30）

> 歷史驗證紀錄：下文的 166 為當時的模板代碼或產物名稱，保留以供追溯。現行顯示名稱為 165，舊代碼僅供相容；目前狀態見 [第二輪名稱核對](template-name-165-audit-20261030.md)。

基於 main `a3792bb1a5f82562d0bd803ba221c6147777e7a4`，於隔離工作目錄實作。未使用私人附件或學號，沒有修改正式答案、雲端資源、IAM、憑證或部署設定，沒有推送／合併／部署。

## 實測結果

| 檢查 | 結果 |
| --- | --- |
| `npm run check` | 成功 |
| `npm run build` | 成功 |
| `BUILDX_CONFIG=/tmp/police-review-buildx npm test` | 346 tests：327 pass、0 fail、19 skip |
| `tests/review.test.ts` | 新增 17 tests，全部通過 |
| MCP 基準合約 | owner 34、reader 12，tools/list 79,015 bytes，低於 80,000 上限；既有輸入合約與 scope 保留 |
| 實際基準來源重現 | 使用未修改的 `18cb1760160d2849039277c13546f168a0956329` checkout 通過；來源雜湊改以 Git committed blob 計算，修正既有 CRLF／LF 差異，不改基準 API 合約 |
| 舊 codec | 實際 a3792bb codec 可讀新答案並於舊 writer 修改後保留 opaque review；新 reader 將其標為 stale；既有一般模板／文字保留 |
| Docker context 套件檢查 | 實際 scratch build 通過，排除合成敏感檔案；Buildx 寫入隔離目錄，未改 Docker registry 憑證 |
| 真實 HTTP MCP | `node --import tsx scripts/review-smoke.ts <isolated-output>`：匿名 loopback、4 題 11 小問，create_answers → 保存清單 → replace_text → review → render → PDF/DOCX export 成功 |
| PDF | 一般模板合成文件 8 頁，全部 raster 頁已檢視；最終輸出 raster 與已檢視圖片逐頁完全一致，未見截字／超框。2、4、6、8 頁為模板設定的空白稿紙頁 |
| DOCX | 實際檔案 XML、修訂文字、4 個 A4 直式 section 已核對；未做 Word／LibreOffice 渲染 |

正負案例涵蓋：必要小問未映射、參照段落消失、僅有標題／空白正文、舊檔 text 與實際渲染 paragraphs 不同、共用段落重複計數提示、關鍵字與無關文字不算語義通過、來源定位無核對證據、補充來源支撐必要小問、來源被否決、配分合計衝突、缺子分、包含關係不明、小數配分、掃描 blank／unreadable／missing／未列頁、未規劃及偏離目標行數、修改後 stale、身分／模板變更、還原與複製、版本衝突、同時寫入 CAS、700 KiB 上限、schema 拒絕、唯讀與獨立 OAuth scope、CloudStore owner 隔離（fake clients）。

HTTP 實測中的正常段落映射仍回傳 pending、semantic/sourceVerification=not_checked；沒有為未實際核對的來源或視覺填入 checked。配分 2+3+2 與總分 5 的矛盾、漏答及缺頁都會出現在 issues。匯出後保留 `nextStep.action=done` 與 `delivery.status=awaiting_review`，內容／來源／視覺的軟體驗證狀態維持 not_checked，不宣稱成品已驗收。

## 未完成的驗證與限制

- 18 項 166 原稿紙字型相關測試：環境未配置通過 SHA 校驗的教育部標準楷書，故略過，未執行這些渲染案例。本次未修改原稿紙、PDF／SVG 基線、Word 幾何或預設模板。
- 1 項真實 Firestore emulator 測試：未設定 `FIRESTORE_EMULATOR_HOST`，故略過；CloudStore adapter 僅以既有 fake clients 測試，沒有寫入真實雲端。
- 真實 ChatGPT 宿主 UI、Word／LibreOffice 渲染未執行；本輪沒有該宿主或渲染器。
- 本 MCP 不會自行讀原題、做 OCR、擷取來源或驗證語義。清單完整性與核對紀錄依呼叫者提供，`review_recorded` 不是軟體證明；不能保證得分或法律全正確。

以上均是能力／環境限制，沒有操作被拒絕或不確定的雲端寫入。新增功能的實作、可執行測試與本機合成輸出均已完成；上線不在本輪範圍。
