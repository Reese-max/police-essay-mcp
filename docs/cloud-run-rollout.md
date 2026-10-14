# Google Cloud Run 部署與 ChatGPT App 切換計畫（2026-10-14）

> 狀態：**規劃／隔離預備版**。目前尚無 Google Cloud 專案授權、Cloud Run 執行網址、遠端 OAuth 設定或生產持久化。此計畫及 Dockerfile **不代表已部署**。不得在未完成資料持久化與遠端驗證前把現有 ChatGPT App 切往此服務。

## 部署目的與不變條件

- 保留現有 Police Essay MCP 的 `/mcp`、`/health`、`/readyz`、原始工具名稱、MCP Apps UI、`ui://widget/police-essay-answer-sheet.html`、預覽與 expectedVersion 編輯語義。
- 保留正常申論紙與 `police_information_essay_166` 兩種流程；不得以相似字型替代 MOE 5.1 字型通過 166 紙驗收。
- **沿用既有 ChatGPT App**，但先建立獨立 staging。舊 MCP 保持上線；取得並驗證新服務網址、身份驗證及 166 正式輸出後才安排切換。
- 測試禁止讀取或遷移舊主機的私人答案、舊金鑰、cookie 或檔案；資料遷移另行備份與獲得使用者確認。
- 不在 repo、Docker image、CI 日誌或外掛封裝存放 token、私有答案或 MOE 字型。

## 目前架構與風險

- `src/index.ts` 原生支援 stateless MCP Streamable HTTP，預設 HOST=127.0.0.1、PORT=8787；Cloud Run 必須 `HOST=0.0.0.0` 並使用 `PORT`。
- `src/storage.ts` FileStore 將答案寫到 `data/answers/*.json`，把 DOCX/PDF/TXT 與 24 小時 artifact manifest 寫到 `exports/`、`exports/.artifacts/`，使用同程序 Map 鎖、`writeFile`、`rename`、`realpath` 和 `copyFile`。**Cloud Run 本地檔案是暫存**。
- 單純將此 FileStore 目錄掛到 Cloud Storage FUSE **不是正確持久化改造**：FUSE 不保證 POSIX rename 與多程序寫入鎖，併行寫入可能遺失資料。
- `ESSAY_MCP_PAPER_FONT` 指向 MOE 原版標準楷書 5.1；其 SHA-256 由 `src/original-paper.ts` 驗證；`assets/paper_166.asset.json` 和 `templates/` 必須包含在映像檔內。
- 現有 HTTP app 的 `MCP_AUTH_TOKEN` / `MCP_READ_TOKEN` 是**固定 Bearer token**，不是完整 OAuth 2.1 Authorization Server；不可把 Cloud Run 的 IAM ID token 當成此應用的 token，也不能因為沒有 OAuth 就改成無認證公開。
- 目前 ChatGPT App 是 App-backed；Plugin Creator 更新技能／說明文件不會重新設定現有 App 的 MCP URL。

## Round A 本機實作設定

- HTTP 的 `STORAGE_BACKEND=file|cloud` 預設為 `file`；stdio 一律使用 FileStore。cloud 缺設定立即拒絕啟動，不回退本地。
- cloud 必填：`GOOGLE_CLOUD_PROJECT`、`ESSAY_FIRESTORE_DATABASE`（例如 `(default)`）、`ESSAY_ENVIRONMENT`、`ESSAY_OWNER_KEY`（64 字元 SHA-256）與 `ESSAY_ARTIFACT_BUCKET`。ADC 由執行環境提供，程式不載入 SA key 檔。固定 Bearer 只允許 `staging` 的合成 owner；production 的 OAuth principal 驗證留待後續階段。
- 答案上限為正規化 JSON 的 700 KiB；artifact 上限為 16 MiB。答案及完整版本修改紀錄在同一 transaction 提交，歷史版本尚未設定自動刪除。
- 匯出使用獨立 `/tmp` 目錄；成功及失敗皆清理。輸出契約保留 `path`，它代表已清理的暫存位置；請以 `exportUri` 下載 artifact。24 小時邏輯到期立即拒讀，GCS lifecycle 實體刪除是非同步。
- 私有字型下載須同時設定 `PAPER_FONT_GCS_URI=gs://...`、`PAPER_FONT_GENERATION` 與 `PAPER_FONT_SHA256=e2b6b1bd1d6303672a68d5057a1f1e4b5361e3d8842373ff3bd1c71fb9ea9b98`。下載至 `/tmp/fonts`，驗證既有 MOE hash/family 後才監聽；也可直接設定既有 `ESSAY_MCP_PAPER_FONT`，啟動時驗證。
- `/readyz` 每次讀取兩模板及已設定的 166 字型；cloud 儲存檢查成功快取 5 秒，依賴檢查 3 秒逾時後回 503。空 artifact bucket 可驗證 list 權限，第一個 owner artifact 出現後也驗證 object get。
- Docker 兩階段共用 `NODE_IMAGE`。預設 Node 24 tag；取得建置收據後須以 `--build-arg NODE_IMAGE=node:24-...@sha256:...` 固定已驗證 digest。

## 分階段

### Phase A — 本地與私人 Cloud Run staging（僅使用合成測試答案）

1. 在獨立分支確認 `npm ci && npm run check && npm test && npm run build` 通過；以 `docker build -t police-essay-mcp:staging .` 驗證映像檔。
2. 此分支提供的 Dockerfile 使用 Node 24、非 root 執行、含 `assets/`、`templates/`、預設 `HOST=0.0.0.0`、`PORT=8080`，提供**僅供 smoke test** 的容器本地答案目錄。沒有持久化之前不接入正式資料。
3. 在授權的 Google Cloud 專案建立專用 Service Account，僅開必要 API 與權限；Secret Manager 保存 `MCP_AUTH_TOKEN`，絕不提交金鑰。
4. 發布 `police-essay-mcp-staging`，區域 `us-central1`、request-based billing、min instances=0、max instances=1、concurrency=1、CPU=1、memory=512Mi、暫定 timeout=60s，**保留 Cloud Run Invoker IAM 驗證，禁止公開**。
5. 以 `gcloud run services proxy` 或同時提供 `X-Serverless-Authorization` (Google ID token) 與 `Authorization` (MCP owner token) 測試，確認 `/health`、`/readyz`、`/mcp` 無 token 401、有效 token 可 initialize / tools/list / list_templates。
6. 不要因為 200 health 就認定驗收成功：仍需實際 `create_answer`、`check_layout`、`render_answer_sheet`、`export_docx`、`export_pdf` 與 resource bytes。

#### 授權後使用的 staging 指令模板

```sh
# 手動在已授權的 Cloud SDK 環境執行；需先建立 Google Cloud project、
# 帳單、專用 service account、Secret Manager secret 與必要 IAM。
gcloud run deploy police-essay-mcp-staging \
  --source . \
  --region us-central1 \
  --platform managed \
  --no-allow-unauthenticated \
  --service-account "police-essay-run@${PROJECT_ID}.iam.gserviceaccount.com" \
  --set-secrets "MCP_AUTH_TOKEN=police-essay-owner-token:latest" \
  --port 8080 \
  --set-env-vars "HOST=0.0.0.0" \
  --cpu 1 --memory 512Mi \
  --concurrency 1 --min-instances 0 --max-instances 1 \
  --timeout 60
```

此指令是**staging scaffold**，有本地暫存資料遺失風險；不得直接作為正式上線指令。需先檢查 Google Cloud 帳單與配額；即使 Cloud Run 用量在免費額度內，Build、Registry、Secret Manager、Firestore、Storage、網路等也可能計費。預算通知**不是硬性斷電開關**。

### Phase B — 生產持久化與身份驗證（必須完成）

1. 分離 FileStore 為可測試的 `EssayStore` 介面與本機實作，不改 MCP 工具外部 schema。
2. 答案改為 Firestore 原子事務或等價 CAS 儲存。建立不可覆寫，修改必須在同個 transaction 比對 `expectedVersion`、原子遞增版本及 `updatedAt`；讀取、list、重啟、不同 instance 可一致工作。
3. 匯出先產生臨時檔案，再以私有 GCS Object 存放 bytes、metadata、`expiresAt`、隨機 export handle；`resources/read` 經 owner 授權讀取，保留 24 小時過期檢查，實際 Storage lifecycle 清除過期 artifact。不得讓未授權使用者藉猜 URI 下載。
4. 處理答題紀錄主體與 artifact 之間的失敗、重試、重複提交；新增針對跨 instance 競態、縮減到零後重啟、讀取／修改／匯出的一致性測試。
5. 字型由合法取得的 MOE 標準楷書 5.1 管理於私有儲存，**不提交 Git、不公開字型 URL、不散布字型檔**。部署時在唯讀路徑提供，設定 `ESSAY_MCP_PAPER_FONT`，保留既有 SHA-256／family 校驗，完成 Word、PDF 的實際渲染與影像檢查。
6. 對 ChatGPT / 外掛的遠端存取建立標準 OAuth 2.1（PKCE、正確 scopes、metadata 與 token 驗證）或通過官方支援的既有安全 OAuth gateway。現有固定 Bearer 不等同可供 ChatGPT 外掛發佈流程使用的 OAuth；外掛入口不得無認證公開。
7. 以服務帳號最小權限、secret rotation、速率限制、審計記錄與不記錄答案正文為準；不得將 single owner token 共享給不受信任的多使用者。

### Phase C — ChatGPT App 切換與完整回退

1. 確認 staging 與正式 Cloud Run HTTPS endpoint、OAuth 認證、完整工具 schema 與舊版本相比無破壞性變更。
2. 用獨立測試 App/連線測試 MCP initialize、工具 discovery、MCP Apps UI、create/read/preview/write/check/export、artifact bytes、166 雙頁 PDF/DOCX、無 token 拒絕。
3. 驗收後，依 ChatGPT 的 App 編輯權限更新**現有 App** 連線網址，刷新工具；若現有 App 綁定無法直接編輯，須由 App 管理界面重新連接／建立替代 App，不能透過 Plugin Creator 更改 App binding 來假裝完成。
4. 原 App 的工具名稱、schema、資源 URI、編輯／唯讀權限分別對照；保留舊服務至少完成一次回歸驗收後再決定下線。
5. 遇到版面失真、模型工具誤差、登入失敗、儲存版本衝突或 artifact 不可讀，立即停止切換並恢復原連線；不得把新系統產生的答案丟失。

## 驗收矩陣（逐項有真實 runtime 收據）

| 檢查 | 完成標準 |
| --- | --- |
| 私人 Cloud Run 啟動 | /health 200，/readyz 200，log 不含 token |
| MCP auth | 無 token / 錯 token 401；有效 owner / read token 權限分離 |
| 契約 | initialize、tools/list、resources/list、UI metadata 與舊版相容 |
| 答案 | 建立、讀取、版本衝突、預覽不寫入、修改及縮減到零後恢復 |
| 排版 | 2 頁 22 行，每頁實際行位置與溢出拒絕 |
| 166 | MOE 字型 SHA-256、原稿紙底圖、Word 轉 PDF 後雙頁檢視通過 |
| 下載 | owner 可用 resource_link 讀到真實 DOCX/PDF bytes；唯讀不能讀 owner artifact |
| 成本 | 使用量、日誌、Build/Registry、DB/Storage/Secrets 帳單觀測與警示 |
| 外掛 | 在 ChatGPT 實際點選工具、畫板可互動、工具重新整理無遺失 |
| 回退 | 明確還原舊 URL 和版本，不需刪除答案 |

## 明確阻塞條件

- [ ] 使用者授權的 GCP project ID、已啟用 Billing、所需 IAM。
- [ ] Cloud Run staging 服務 URL 與真實 runtime 測試。
- [ ] Firestore/GCS adapter 與跨實例資料完整性測試。
- [ ] 按授權取得並安全安置 MOE Std Kai 5.1。
- [ ] 遠端 OAuth / ChatGPT App 綁定權限和實際更新。
- [ ] 經人工確認費用與資料存放地區／保留政策。

## 相關文件

- https://docs.cloud.google.com/run/docs/quickstarts/build-and-deploy/deploy-nodejs-service
- https://docs.cloud.google.com/run/docs/configuring/services/cloud-storage-volume-mounts
- https://docs.cloud.google.com/run/docs/authenticating/overview
- https://docs.cloud.google.com/run/docs/authenticating/service-to-service
- https://cloud.google.com/run/pricing
- https://developers.openai.com/plugins/deploy/submission
- https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt
