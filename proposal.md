# 申論交付品質改善提案

日期：2026-10-29。調查與修正基準：`349bdfad902f4fa517d91f8816a31dca1b750003`。
本機獨立分支：`fix/export-awaiting-review`。此提案及修正尚未推送、開 PR、合併或部署。

## 要解決的問題

使用者要求「核對架構，不能不一樣」，並追問第四題原講義頁碼。因此交付應能說明答案如何對應題目與來源，並區分容量符合、檔案產出及實際驗收。

本輪先修正可從程式與測試確認的完成狀態誤導。這項修正不會驗證四題答案是否忠於講義，也不會把條目數、字數或頁數當作內容正確的證據。

## 已核實的現況

1. [PR 51](https://github.com/Reese-max/police-essay-mcp/pull/51) 與 [PR 50](https://github.com/Reese-max/police-essay-mcp/pull/50) 均已合併，獨立 clone 的 main 正是上述基準 SHA。GitHub 開放 PR 清單為 [46](https://github.com/Reese-max/police-essay-mcp/pull/46)、[47](https://github.com/Reese-max/police-essay-mcp/pull/47)、[48](https://github.com/Reese-max/police-essay-mcp/pull/48)，分別涉及刪節後行數目標、還原行數目標、PDF 行末寬 ASCII 字元。沒有搜尋到新的替代 PR；這是查詢當時的快照。
2. 儲存庫內沒有 `AGENTS.md` 或 `.agents/skills`。已讀適用的本機上層指引、相關原始碼、README 與既有測試。既有工作目錄不可讀，未改動它們，改在本次授權工作區建立獨立 clone。
3. `src/exam-progress.ts` 將目前答案版本已收入合輯且格式齊全視為 `current`，隨即回傳 `nextStep.action=done` 與「成品已完成」。附註雖寫內容未查證，主狀態仍直接宣告完成；舊測試也要求這段文字。
4. `check_layout`、`layoutWarnings` 已具備容量與 `ORPHAN_HEADING`／`SPLIT_LATIN_WORD` 警告；`keepHeadingWithNext` 已存在。警告不阻擋匯出，容量通過也不保證無孤立標題。
5. 明確指定不存在的模板會回 `TEMPLATE_NOT_FOUND`；省略模板才使用預設 general。沒有證據支持「明確指定 166 失敗後默默改 general」這個缺陷說法。166 已有字型雜湊校驗及缺字拒絕機制。

## 本輪已修改

修改 `src/exam-progress.ts`，保留原本逐題階段與合輯新舊判斷，另增加 `delivery`：

| 欄位 | 回傳值與界線 |
| --- | --- |
| `status` | 尚未匯出、過期或缺少計畫要求格式：`not_ready`；合輯目前有效：`awaiting_review`。 |
| `checks.layoutCapacity` | 目前各題容量均符合才回 `passed`，否則 `pending`；不代表警告已清除。 |
| `checks.content` | `not_checked`；系統沒有保存題意與論述核對證據。 |
| `checks.source` | `not_checked`；系統沒有保存來源頁碼核對證據。 |
| `checks.visual` | `not_checked`；系統沒有保存匯出檔逐頁驗收證據。 |

目前有效合輯的下一步改為 `review_delivery`，文字改為「合輯已匯出」，不再宣告成品完成。此工作階段由人工／助理核對，不是新 MCP 工具，也不觸發重新匯出。

`get_exam_progress` 與 `render_exam_overview` 共用相同進度資料，因此現有畫板進度文字也會顯示待驗收狀態。`src/server.ts` 的工作流指引同步說明 `review_delivery` 的意義；README 記錄回傳欄位與相容性變更。沒有新增可任意勾選「已驗收」的入口。

### 本輪驗收條件

- 初始、缺題、容量溢出或模板無效時，交付不能標為已完成。
- 容量符合但未匯出時，仍須匯出；不能直接進入已驗收狀態。
- PDF／Word 產出後，只表示檔案可供審閱；三項未驗收檢查維持 `not_checked`。
- 含孤立標題警告的答案可以維持既有可匯出行為，但容量通過不能洗成視覺驗收通過。
- 答案修改或計畫增列尚未匯出的格式後，交付狀態退回 `not_ready`，要求更新合輯。
- 讀取進度與畫板不能偷偷寫入驗收記錄。FileStore 與 CloudStore（記憶體 fake）均測試。

## 仍未核驗的線索

本輪沒有原講義、認可的舊 PDF 與被批評的四題 PDF，不能確定漏項、第四題來源頁碼、字型替換或實際孤立標題。分享 ID 與同名對話的對應也未獨立確認。166 模板的存在及其參數不能證明它就是使用者當次指定的基準；不硬設 166、19pt 或其他行數為全域預設。

## 後續優先順序與驗收標準

| 優先 | 提案 | 可驗收標準 |
| --- | --- | --- |
| P1 | 取得原講義、舊樣本與本次四題檔案，建立逐題差異表。 | 每項差異附題號、檔案版本、實際頁碼及可檢查的例子；缺檔處標未核驗。 |
| P1 | 記錄「小題要求 → 來源頁碼 → 答案 section ID」對照。來源以檔案識別、版本或雜湊及頁碼範圍標示，區分 PDF 頁序與印刷頁碼。 | 能找出引用不存在的 section、缺少來源的要求及修訂後失效的連結；對照齊全只能稱機械完整，不可稱語意正確。原文順序與層級要求另需人工核對。 |
| P1 | 記錄驗收證據並綁定答案版本與實際匯出檔案。 | 內容、來源、視覺分開記錄核對者、時間、對象與結果；任一答案或輸出改變，相關通過狀態失效。不能只有一個無證據的「完成」布林值。 |
| P2 | 增加模板來源及期望規格比對。 | 回傳實際 template ID、模板版本或雜湊及解析後的關鍵參數；只在使用者已指定期望時比較並明確報差異，不擅改省略模板的既有行為。 |
| P2 | 以實際 PDF／Word 產出頁面逐頁預覽，連結既有品質警告。 | 報告能定位到題號、頁、行、section；孤立標題、斷字、缺字等分別給證據；視覺檢查不能由 `fits=true` 或匯出 exit 0 代替。 |
| P3 | 在明確界線內增加結構規則。 | 只有存在已指定的題目結構或來源大綱時，檢查標題次序、重複 ID、編號跳號等；合理略號或不同題型可辨識／人工覆核。不用填滿頁數、平均段長或固定前言本文結論當成通過條件。 |

## 相容性與範圍

`nextStep.action` 從 `done` 改為 `review_delivery` 是有意義的輸出行為變更；自製客戶端若對 action 寫死列舉，需同步更新。現有 widget 只顯示 message，不按 `done` 分支執行。逐題 `exported` 與合輯 `current` 仍保留，意義只是版本與匯出狀態。

這輪沒有提供驗收通過的儲存工具，所以即使外部已人工核對，進度 API 仍不會自行宣布通過；後續須以上述版本綁定的證據設計補足。單題及直接 `export_exam_bundle` 的原始下載回應尚未新增 `delivery` 欄位；本次狀態保護作用於試卷進度及總覽。也未修改正式資料、答案內容、模板、全域字型、部署或依賴鎖定版本。

## 驗證紀錄

- `npm run check`：exit 0。
- `npm run build`：exit 0。
- 進度檔測試：26／26 通過，含兩種儲存介面的新增孤立標題案例；其後補充的格式缺漏及無效模板斷言也在下列完整測試中通過。
- Node `v24.19.0` 完整測試：313 項，288 通過、0 失敗、25 跳過，exit 0；約 52 秒。使用與 `scripts/run-tests.js` 相同的全部 `tests/**/*.test.ts` 檔案，另選 TAP reporter 留存結果。完整紀錄在工作目錄上層 `quality-tests-node24.tap`。
- 25 項跳過涉及 166 專用字型、Noto CJK／實際轉檔等前置環境、Firestore emulator、contract provenance 的舊版 checkout，以及實際 Docker build context；各項原始跳過原因在 TAP 中。既有 MCP contract 檢查通過，但重新產生舊版 provenance 的測試未執行。CloudStore 測試使用 fake，不代表正式 Firestore／GCS 已驗收。
- `git diff --check`：exit 0。

環境處理：第一次沙箱測試的預設暫存目錄發生原子 rename 的 `EPERM`，將測試暫存資料明確放入本次授權工作區後，FileStore 測試通過。沙箱內完整測試又遇 HTTP 子程序連線逾時，因此停止該次測試，改用獲准的本機 Node 24 完整執行並取得上述 exit 0。沒有為配合環境而削弱測試或修改產品儲存／HTTP 邏輯。依賴以 `npm ci --ignore-scripts` 安裝，沒有變更 lockfile。

本輪未執行真實 ChatGPT 宿主驗收、正式雲端測試、新舊 PDF 逐頁比對或四題內容查證。程式修正與提案可本機審閱，後續發布仍須另外進行。
