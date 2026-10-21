# 預算守衛（依實付金額自動停用）

當專案本月的**實付金額**（扣掉免費額度與抵免後）達到預算上限時，自動撤銷 `police-essay-mcp-staging` 的公開存取，讓公開網址回 403、不再產生用量。它只會撤銷，不會自己恢復。

Cloud Billing 原生的費用上限（spend cap）只能以扣抵免前的原價計算（官方規定 `creditTypesTreatment` 必須是 `EXCLUDE_ALL_CREDITS`），所以以實付金額為準的停用改由這裡做。原生的 `cloud-run-spend-cap`（原價 NT$140，只管 Cloud Run）照常保留，兩者互不衝突。

## 組成（project-2fa3f892-2016-4fe4-977，us-central1）

| 元件 | 名稱 | 說明 |
|---|---|---|
| 預算 | `police-essay-net-cap`（id `91bd5c85-63c8-4b65-b924-75619a60b740`） | 範圍：整個專案；`INCLUDE_ALL_CREDITS`（實付）；每月 NT$30；50%／100% 寄信給帳單管理員 |
| Pub/Sub 主題 | `pem-budget-net` | `billing-budget-alert@system.gserviceaccount.com` 有 publisher |
| 推送訂閱 | `pem-budget-guard-push` | OIDC 身分 `pem-budget-push@…`；不過期；重試 10 秒到 10 分鐘 |
| Cloud Run 服務 | `pem-budget-guard` | 不公開，只有 `pem-budget-push@…` 能呼叫；以 `pem-budget-guard@…` 執行；`TARGET_SERVICE`、`BUDGET_ID` 環境變數 |
| 自訂角色 | `projects/…/roles/pemBudgetGuard` | `run.services.get`、`getIamPolicy`、`setIamPolicy`；只綁在 `police-essay-mcp-staging` 這一個服務上 |

映像在 Artifact Registry `police-essay/budget-guard`；程式只有 `guard.mjs`，沒有相依套件。

## 判斷規則

- 只處理 `BUDGET_ID` 這個預算的通知；其他預算、讀不懂的內容一律忽略並確認收到。
- `costAmount ≥ budgetAmount` 才撤銷；金額必須是數字或數字字串。
- 通知所屬計費期（`costIntervalStart` 起一個月）已結束就忽略，避免上個月延遲送到的通知在你恢復後又撤銷一次。
- 撤銷 = 從 `roles/run.invoker` 移除 `allUsers`、`allAuthenticatedUsers`，其他綁定與條件原樣保留；以 policy etag 防止覆蓋同時進行的修改。
- 目標服務若關閉了 invoker IAM 檢查（`--no-invoker-iam-check`），移除 allUsers 無效，守衛會回 500 並記錄 ERROR，請不要對目標服務關閉該檢查。
- 撤銷失敗才回 500 讓 Pub/Sub 重試；其餘都回 204。

帳單資料本身有數小時到一天的延遲，所以這不是即時煞車。IAM 變更實測約 1～2 分鐘生效（71～101 秒）。

計費期從太平洋時間每月 1 日 0 時開始；判斷舊通知時多留 1 小時，涵蓋日光節約造成的時差。

限制：

- 預算範圍是整個專案，但守衛只撤銷 `police-essay-mcp-staging` 的公開存取。與流量無關的費用（例如 Artifact Registry 儲存、Cloud Build）不會因此停止。
- 管線本身若壞掉（例如服務帳號被刪、訂閱被刪）不會告警；請偶爾用下方指令查看守衛是否每天都有收到通知。
- 帳單帳戶下另有 `no-spend-guard`（整個帳單帳戶、實付 NT$1，只寄信）與 `cloud-run-spend-cap`（原價 NT$140，只管 Cloud Run 並由 Google 直接暫停），三者互不衝突。

## 被停用時：恢復公開存取

先決定本月是否要繼續服務：

1. **調高上限再恢復**（本月內還會有通知，不調高會再被撤銷）：
   ```
   # 以 Budget API 把 police-essay-net-cap 的 amount 調高，或在 Console「帳單 → 預算與快訊」修改
   gcloud run services add-iam-policy-binding police-essay-mcp-staging --project=project-2fa3f892-2016-4fe4-977 --region=us-central1 --member=allUsers --role=roles/run.invoker
   ```
2. **等下個月再恢復**：月初後執行上面的 `add-iam-policy-binding` 即可；上個月的舊通知會被忽略。

## 查看與測試

```
# 守衛收到的每則通知（INFO＝未達上限，WARNING＝已撤銷，ERROR＝撤銷失敗；name 為預算名稱，真實通知是 police-essay-net-cap）
gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="pem-budget-guard" AND jsonPayload.message:*' --project=project-2fa3f892-2016-4fe4-977 --freshness=2d --limit=20 --format="value(timestamp,severity,jsonPayload.message,jsonPayload.name,jsonPayload.cost,jsonPayload.budget)"
```

不要對正式預算 id 發送超過上限的測試訊息（會真的停用服務）。要測撤銷，先部署一個公開的拋棄式服務、把守衛綁上 `pemBudgetGuard` 並把 `TARGET_SERVICE`／`BUDGET_ID` 暫時指向它與測試 id，發送測試訊息後再改回來、刪除拋棄式服務。

單元測試：`node --import tsx --test tests/budget-guard.test.ts`（含在 `npm test`）。

## 費用

預算、Pub/Sub（每天數則訊息）、Cloud Run（每天數次、min-instances 0）都在免費額度內；映像與 police-essay-mcp 共用基底層。
