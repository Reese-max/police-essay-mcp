# 外部 OAuth Authorization Server 要求

本服務只驗證 access token，不提供 /authorize、/token、/register。Provider、租戶、client 與費用尚未決定，也未建立任何雲端資源。

## ChatGPT MCP App 接線驗收

- AS discovery 提供 issuer、authorization_endpoint、token_endpoint；註冊採 DCR 或預註冊 client。支援 CIMD 的 AS 可另評估 CIMD。
- Authorization Code + PKCE S256；discovery 宣告 S256，token exchange 必須核對 verifier。
- 接受 authorization／token request 的 resource indicator，簽發 aud 精確等於 OAUTH_RESOURCE_URL 的 JWT；支援 RS256 或 ES256、固定 HTTPS JWKS 與 kid 輪替。
- 支援 essay.read／essay.write／essay.export 的授權。Refresh／rotation／撤銷須實測；是否需要 offline_access 由 provider 決定，不預先宣告。
- Redirect URI 從該 MCP connection 的 ChatGPT 管理頁原樣複製至 allowlist；不猜 callback、不使用萬用字元。RFC 9207 issuer identification 是否支援也須確認。

以上依 [OpenAI 官方認證文件](https://developers.openai.com/plugins/build/auth) 核對（2026-10-14）。Refresh 是本專案持續使用的驗收要求，是否可用仍待 provider 與實際 ChatGPT 流程確認。

## 本服務設定與權限

AUTH_MODE 預設 bearer；oauth 僅接受 JWT；both 可同時接受原 owner/read token 與 JWT。原固定 bearer 不映射到 OAuth 使用者，cloud bearer/both 仍限 staging。

OAuth 須設定 OAUTH_RESOURCE_URL、OAUTH_ISSUERS（逗號分隔、精確比對）、OAUTH_JWKS_URI。多個 issuer 必須共用同一可信的權威 JWKS；不同 keyset 的 provider 分別部署，本版不加入多 provider 路由。正式 URL 使用 HTTPS；HTTP 僅允許 loopback 本機測試。

JWKS 成功快取 5 分鐘；未知 kid 的 refresh 不清除仍有效的 key，refresh 失敗也保留原有效期，過期 key 不作為備援。取得使用 single-flight；未知 kid 與失敗請求共用退避，OAUTH_JWKS_BACKOFF_SECONDS 預設 30 秒（須為正數），不因變換 kid 放大請求。初次成功取回後最多立即 refresh 一次，其後每個退避區間最多一次。Token 的 jku/x5u 不作為 key 來源；exp/nbf 容許 30 秒時鐘偏差。

OAUTH_REQUIRE_AT_JWT=true 時只接受 header typ=at+jwt；預設 false。支援 scope 字串或 scp 陣列；已簽章但沒有所需 scope 的 token 回 403 insufficient_scope。有 token 的 401 challenge 含 error="invalid_token"；無 token 不附 error。

所有 OAuth MCP 請求需 essay.read；寫入另需 essay.write，匯出工具與 artifact 讀取另需 essay.export。三者齊全 21 個工具；read 12；read+write 18；read+export 15。工具 metadata 與 HTTP 403 insufficient_scope 同時強制，不能靠直接 tools/call 繞過。

essay.export 獨立於 essay.write（read+export 可以產生及讀取 artifact，且會寫入 manifest／物件），與原 owner-only 規劃有差異；這是**待產品確認**的決策，本回合保留現有行為。

CloudStore 使用 SHA-256(JSON.stringify([issuer, sub])) 作為 ownerKey；issuer/sub 僅來自驗證通過的 token。舊固定 bearer owner 的資料不自動遷移。FileStore 維持單一擁有者，OAuth 必須設定 OAUTH_FILE_OWNER_KEY；其他 principal 在接觸資料前回 401。

/.well-known/oauth-protected-resource 與 /.well-known/oauth-protected-resource/mcp、/health、/readyz 可匿名；其他資料路由先認證。OPTIONS 僅為既有 CORS preflight，不提供資料。401 帶固定 resource_metadata URL；不足 scope 回 403。Protected-resource metadata 依 [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html)。

本回合只完成 resource server；外部 AS、閘道、Cloud Run IAM、實際 ChatGPT linking／refresh／撤銷均待另行驗收。SDK 1.30 的 registerTool 接受 _meta，本版使用 _meta.securitySchemes；ChatGPT host 的實際 metadata 解讀仍須驗收。

## Bearer 行為差異與契約重現

bearer 模式的 GET / 現在需認證：無 token 回 401，原基準版匿名回 200；匿名未知路徑也由原 404 變成 401。監控探針請使用 /health 或 /readyz，本回合不調整此行為。

完整 owner/read 契約由固定基準 worktree 實際程式碼產生，沒有欄位差異。OAuth 四種 scope 的工具名稱清單從基準 owner/read 集合產生；工具其他欄位逐一比對。唯一刻意差異白名單是 Round B 已有的 _meta.securitySchemes OAuth scope 宣告（原基準無 OAuth）；測試精確核對每個工具的 scopes，不允許其他 metadata 漂移。MCP wire protocol 不提供 prompt argsSchema，檢查另讀取 SDK 1.30 已註冊的完整 schema。

```powershell
npx tsx scripts/generate-contract-from-base.ts C:\Users\Administrator\work\pem-wt-base
```

來源測試重新執行 git rev-parse HEAD、驗證固定 revision、乾淨的 src 與來源 SHA-256，再逐欄位比對。測試預設基準位於 ../pem-wt-base；其他環境可設定 MCP_CONTRACT_BASE_PATH，須指向同一固定 revision 的唯讀 worktree（包含既有依賴）。

## 候選 provider 評估表

未評估或選定 provider；不得把一般 Google/OIDC 登入視為已符合 MCP OAuth。

| 欄位 | 候選 A | 候選 B |
|---|---|---|
| Provider／方案／官方證據 URL／查核日期 | 待查證 | 待查證 |
| DCR／預註冊 client／CIMD | 待查證 | 待查證 |
| PKCE S256／AS discovery／RFC 9207 | 待查證 | 待查證 |
| resource indicator → aud／自訂 scopes | 待查證 | 待查證 |
| RS256／ES256／JWKS 輪替 | 待查證 | 待查證 |
| 精確 redirect allowlist／client 保存期限 | 待查證 | 待查證 |
| Refresh／rotation／撤銷／取消登入 | 待查證 | 待查證 |
| 額度／費用／超量行為／停止條件 | 待查證 | 待查證 |
| 真實 ChatGPT linking 與到期續用收據 | 待查證 | 待查證 |

## Known limitations (accepted, reviewed 2026-10-14)

- JWKS fetch failure or cooldown returns `401 invalid_token` (fail closed) rather than 503; a client may re-authorize needlessly during an IdP outage.
- A key rotation where the IdP signs with a new `kid` before publishing it can be delayed by at most one `OAUTH_JWKS_BACKOFF_SECONDS` window (default 30s, max 300s).
- The path-insertion well-known route is fixed to `/mcp`; `OAUTH_RESOURCE_URL` must end in `/mcp`.
- `OAUTH_REQUIRE_AT_JWT` and `OAUTH_JWKS_BACKOFF_SECONDS` reject unrecognised values at startup instead of silently ignoring them.
