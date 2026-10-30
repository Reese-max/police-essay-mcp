# 小問覆蓋與驗收紀錄

此 MCP 沒有 LLM，也不會抓取來源、OCR 或判定法律／概念正確。新增功能檢查明確提供的清單與目前答案，不從關鍵字推定答對，不保證得分。

## 工具

- `review_answer({ answerId, expectedVersion? })`：唯讀、`essay.read`。回傳小問對應、正文是否空白、實際行數、配分、來源／掃描／驗收狀態及待處理清單。
- `set_answer_review({ answerId, expectedVersion, plan })`：`essay.write`。完整替換清單，`plan: null` 清除；必要版本檢查與既有 CAS／歷史紀錄共用。成功新增一個答案版本，會使先前匯出版本過期；不改文字、格式或模板。read-only 及只有 export scope 的連線無此工具。
- `essay://schemas/review-plan`：可由 MCP `resources/read` 取得完整 strict JSON Schema。避免在每次 `tools/list` 重複傳送；工具仍在伺服器端以完整 schema 驗證，不接受未知欄位。

`examples/review-plan.json` 是未核對的匿名合成示例。先建立含 `definition`、`comparison` section id 的答案，再以其實際版本保存此清單。此例刻意不提供核對證據，預期結果為 `pending`。

## 生成與回修順序

1. 對照原題列出全部必要小問；每個小問保留穩定 id、完整要求與 `sectionIds`。正文須給具體證據及用途；定義與不同分類軸應分別核對。工具無法自行判定原題是否還有漏列的小問，`scopeReview` 用來記錄這項對照。
2. 依配分或重要性用既有 `lineTargets` 分配各節容量。先補齊必要小問，再濃縮補充。`review_answer.allocation` 使用實際版面行數比較目標；不以字數／關鍵字推算內容品質。小問共用段落會提示共享映射，不能重複加總行數。
3. 以 `sourceIds` 連結來源；來源分 `required` 與 `supplemental`。`locator` 可為網址、文件與頁碼、檔案定位字串，僅有定位不算核對。需要的來源沒核、或補充來源支撐必要小問卻沒核，均會提示。
4. 明確可相加的配分才設 `scoring.mode: additive`。全部小問 points 已提供才比較合計；小數允許 1e-6 誤差。`overlapping`／`unknown`、缺總分或缺子分一律保留 `pending`／`not_checked`，不自行加分、改分或解釋包含關係。
5. 掃描題本以 `scan.expectedPages` 及 `pages: [{ page, status }]` 記錄。沒有列出的頁自動列為 missing；blank、unreadable、missing 均待核。頁碼重複或超出預期範圍拒絕。沒有掃描資料維持 `not_checked`；`content` 是呼叫者紀錄，工具不檢視圖像。
6. 完成實際對照後才填入小問 `review`、來源 `review`、`scopeReview`、`visualReview`。每筆包含 `{ status: "checked" | "rejected", method: "human" | "model", reviewer, note, checkedAt }`。`note` 說明核對位置、具體結論與未能確認處；`checkedAt` 是 ISO datetime。沒有證據就省略，不填自動通過。視覺紀錄應列出實際檢視的預覽／檔案及所有頁；只匯出成功不能填 checked。
7. 保存清單後呼叫 `review_answer`，處理或揭露 pending。任何後續答案版本、題目、文字、格式、模板幾何或身分變動都讓舊紀錄 `stale`；重新對照後才能重新保存。清單內容仍保留供續作，不能複製舊核對結論冒充新檢查。
8. 依既有 `check_layout` → render → export 流程交付；本次不更動匯出阻擋規則、預設 166、Word 幾何或 `nextStep.action: done`。這是輔助核對，不是強制禁止匯出。

## 如何解讀結果

| 欄位 | 意義 |
| --- | --- |
| `freshness` | `not_checked` 無清單；`current` 與當前版本及指紋一致；`stale` 須重核 |
| `requirements[].coverage` | `missing` 無對應或參照段落消失；`empty` 有標題但正文空白；`mapped` 有正文對應，未判定是否答到題意 |
| `structuralStatus` | `issues_found` 有必要小問缺段落、配分衝突或容量超出；`no_structural_issues` 僅表示這些機械檢查沒有發現問題 |
| `reportedReview` | `recorded` 呼叫者留下 checked 紀錄；`rejected` 呼叫者指出問題；`stale` 舊紀錄；`not_checked` 無紀錄 |
| `semantic`、`sourceVerification` | 固定 `not_checked`；此伺服器沒有自動證明內容或來源正確 |
| `status` | `not_checked` 無清單；`pending` 尚有問題或待核；`review_recorded` 已提供項目所需紀錄齊全，不等於伺服器批准 |

完整證據可由 `read_answer.answer.review` 讀取。即使紀錄齊全，未知的掃描情形及未列入清單的小問也不能視為通過。`get_exam_progress.questions[].review` 另附目前紀錄狀態、freshness 和待處理數；`delivery.checks.content/source/visual` 仍保持 `not_checked`，匯出終點仍為 `done`。

## 儲存與相容性

答案新增 optional 頂層 `review: { plan, reviewedVersion, fingerprint }`，無此欄位的舊答案不遷移。指紋包含答案 id、內容、格式、模板與行數目標等，不含版本／時間／review；另外必須版本一致，防止改後還原誤用舊驗收。沿用既有 700 KiB 答案上限、owner 隔離及 revision 機制，沒有新增網路請求、API 金鑰或依賴。

a3792bb 舊 codec 可讀新 envelope，寫回時透過既有 opaque 頂層保留機制保留 review；新版本重讀後因版本不符將其標為 stale。更早且沒有 opaque 保留能力的 writer 仍可能刪除新欄位；結果會回到 `not_checked`，不得當作已驗收。複製答案不複製驗收身分；還原版本不恢復 current 驗收狀態。
