# 以 WorkOS AuthKit 為 ChatGPT 加上登入（OAuth）部署手冊

狀態：程式與測試已備妥，**尚未部署、尚未註冊 WorkOS**。本手冊每一步都需擁有者確認後才執行。

## 為什麼選 WorkOS AuthKit

查證日期 2026-11-20（官方頁面）：

- 價格：AuthKit 每月 100 萬活躍使用者內免費（https://workos.com/pricing）。
- ChatGPT 要求（https://developers.openai.com/plugins/build/auth）：授權伺服器要公開 OAuth metadata、支援 PKCE `S256`、沿用 `resource` 參數，並支援 CIMD、DCR 或預先註冊的 client。AuthKit 都有：`code_challenge_methods_supported: ["S256"]`、`authorization_response_iss_parameter_supported: true`、`registration_endpoint`（DCR），CIMD 可在後台開啟；設定 Resource Indicator 後，access token 的 `aud` 等於請求的 `resource`（https://workos.com/docs/authkit/mcp）。
- 限制：AuthKit 只發 `openid`、`profile`、`email`、`offline_access`，**沒有自訂 scope**。因此本服務新增 `OAUTH_GRANTED_SCOPES`：通過驗證的使用者直接取得列出的 `essay.*` 權限，且不再對外公告 `essay.*`（protected resource metadata、401 challenge、工具 `securitySchemes` 都不帶）。每位使用者的資料依 `SHA-256([issuer, sub])` 分開存放，所以這樣授權不會讓使用者碰到別人的資料。

## 程式變更（本分支）

- `OAUTH_GRANTED_SCOPES`：設定後，有效 token 一律取得列出的 scope（必須含 `essay.read`，只能列 `essay.read`、`essay.write`、`essay.export`）。
- OAuth 使用者的匯出下載連結：`/u/<ownerKey>/downloads/<handle>/<檔名>`，下載時只查該使用者的資料；隨機 handle 仍是唯一憑證，24 小時到期。純 OAuth 模式下，不帶 owner 的舊式連結仍關閉。
- `scripts/migrate-owner.ts`：把舊的固定 owner（`ESSAY_OWNER_KEY`）下的答案、修訂紀錄、考試複製到登入後的 owner。預設只試算；`--apply` 才寫入；不改、不刪來源；目的地已有答案就拒絕；匯出檔不搬（可重新匯出）。

## 部署步驟（待確認後執行）

1. **建立 WorkOS 帳號與環境**（擁有者自行註冊，密碼與驗證碼不經他人）。
   - Connect → Configuration：開啟 Client ID Metadata Document，並開啟 Dynamic Client Registration 作為備援。
   - Resource Indicators：加入 `https://police-essay-mcp-staging-898105187503.us-central1.run.app/mcp`，設為 default；驗收用的 tag 網址（例如 `https://oauthqa---police-essay-mcp-staging-898105187503.us-central1.run.app/mcp`）也加入。
   - 註冊方式：關閉公開註冊，或只允許指定 email，避免任何人都能登入並產生 Cloud Run 用量。
   - 記下 AuthKit 網域；`issuer` 與 `jwks_uri` 以 `https://<authkit 網域>/.well-known/oauth-authorization-server` 的實際回應為準。
2. **確認 discovery**：上述 metadata 要有 `S256`、`registration_endpoint`，以及開啟後的 `client_id_metadata_document_supported: true`。
3. **部署不接流量的驗收版本**（不影響現行線上）：
   ```bash
   gcloud run deploy police-essay-mcp-staging --region us-central1 --source . --no-traffic \
     --tag oauthqa --revision-suffix oauthqa-<sha> \
     --update-env-vars AUTH_MODE=oauth,OAUTH_RESOURCE_URL=https://oauthqa---police-essay-mcp-staging-898105187503.us-central1.run.app/mcp,OAUTH_ISSUERS=<issuer>,OAUTH_JWKS_URI=<jwks_uri>,OAUTH_GRANTED_SCOPES="essay.read essay.write essay.export",ESSAY_PUBLIC_BASE_URL=https://oauthqa---police-essay-mcp-staging-898105187503.us-central1.run.app \
     --remove-env-vars MCP_ALLOW_ANONYMOUS_REMOTE
   ```
   - 驗證：`/.well-known/oauth-protected-resource` 回 `resource` 與 `authorization_servers`；未帶 token 的 `/mcp` 回 401，並帶 `resource_metadata`。
   - 現有的 `rules_check.mjs`、`wsl_e2e*.sh` 是匿名連線，在 OAuth 版本會被 401 擋下；驗收要改用登入後的 token，或在 ChatGPT 裡實測。
4. **在 ChatGPT 建一個新的測試外掛**（現有外掛不動）：Server URL 填驗收版本的 `/mcp`，驗證選 OAuth，登入 WorkOS；實測建立、讀取、修改、匯出 PDF 下載。
5. **搬移舊答案**：從 WorkOS 後台取得自己的 user id（即 token 的 `sub`）。
   ```bash
   npx tsx scripts/migrate-owner.ts --environment staging --from <ESSAY_OWNER_KEY> --issuer <issuer> --sub <user id>          # 試算
   npx tsx scripts/migrate-owner.ts --environment staging --from <ESSAY_OWNER_KEY> --issuer <issuer> --sub <user id> --apply  # 寫入
   ```
6. **切換正式**：以正式網址作為 `OAUTH_RESOURCE_URL`、`ESSAY_PUBLIC_BASE_URL` 建立正式 revision，切換流量；把現有 ChatGPT 外掛的驗證改成 OAuth（不能編輯時就新建外掛，再移除舊外掛）。
7. **回退**：`gcloud run services update-traffic police-essay-mcp-staging --region us-central1 --to-tags <切換前的 tag>=100`，回到原本不需登入的版本；舊的固定 owner 資料沒有被改動。

## 不受影響的部分

- Hugging Face 網站（ReeseXISX/police-exam-rag）內建自己的一份 MCP，用網站自己的 token，與 Cloud Run 的登入方式無關。
