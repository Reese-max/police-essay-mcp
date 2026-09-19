# police-essay-mcp 產品董事會稽核

- 稽核時間：2026-09-19T23:00Z
- Repository：`Reese-max/police-essay-mcp`（private、未封存、default branch `main`）
- inspected product HEAD：`9dbe0c7d604f1f8025aae591ead2b870fe200dab`
- issue-quality 規則 blob：`8167e10798071d2276addaff6b201c6b0e904a2a`
- 證據等級：除另註外皆為 `SOURCE_CONFIRMED` 靜態檢視；本輪沒有正式 tunnel、ChatGPT connector、Office／LibreOffice、瀏覽器、手機、列印或輔助科技實測
- 結論：`INVEST / NARROW / SECURE REMOTE BEFORE CONNECT`；固定 A01–J05 portfolio audit 為 `NOT CLEAN, 0/2`

## Executive decision

產品服務需要把臺灣警察／公務人員申論內容整理成固定 A4 兩頁、每頁 22 行並匯出 DOCX／PDF／TXT 的個人考生。差異化不是通用文件編輯，而是「結構化段落編修、可預測行數、可移植考卷版面」的本機優先 MCP 工作流。

只做三件事：

1. 在任何 tunnel／remote HTTP 使用前建立 fail-closed 的 owner 授權邊界，追蹤於 [Issue #1](https://github.com/Reese-max/police-essay-mcp/issues/1)。
2. 以同一份 44 行答案驗證 DOCX、PDF、Word、LibreOffice、列印與手機預覽的分頁／行距／換行一致性，保存 exact-head receipt。
3. 驗證一條 ChatGPT → 建立答案 → 局部改段落 → 預覽 → 匯出的首次成功旅程，保留失敗與復原證據。

不做：OCR、AI 評分、題庫／LMS、帳號與雲端同步、多人協作、商城、通用文件平台或通用 IAM。競品的廣度不是本產品擴張理由。

## Discovery 與 inventory delta

本輪完整分頁 inventory 為 Reese-max 42 個 repositories：41 個未封存、1 個封存（`obsidian-vault`）。`police-essay-mcp` 是前次巡檢後新增的未封存 repository，因涉及使用者答案內容、遠端 connector 與寫入／刪除能力，優先於原持久游標檢查；下輪游標仍從原序列續行，不把新 repo 插隊永久化。

本 repo default branch 只有 `main`；沒有 Issue、PR、其他 branch、Actions workflow、HEAD workflow run 或 commit status。缺 CI 只能阻止 CLEAN，不能單獨證明產品失效。本輪建立 Issue 前再次搜尋所有狀態 Issues／PR、中央 audit／roadmap 與 branches，沒有相同 fingerprint，也沒有 owner heartbeat、有效 lease、活躍 branch 或 PR。

檢查範圍：README、SPECIFICATION、package manifest、HTTP／stdio entry、MCP tools、storage、layout、exporters、tests、近期 commits、所有 Issues／PR／branches、workflow runs 與 commit status。未啟動 autodev run、worker、GOAL、部署或正式資料寫入。

## 產品與程式證據

| 證據 | blob / SHA | 結論 |
|---|---|---|
| default HEAD | `9dbe0c7d604f1f8025aae591ead2b870fe200dab` | 最新產品基線；commit 為段落格式改進 |
| README | `fe0c0db3e1d535a09eab5c694fc03711e19679e9` | 支援啟動 HTTP server、透過 HTTPS tunnel 暴露 `/mcp`、加入 ChatGPT |
| `src/index.ts` | `570d550464bc944203f905e90f09d664a0aea587` | `/mcp` GET／POST／DELETE 無 auth；未設定時 CORS origin 為 `*` |
| `src/server.ts` | `a5baf07d8c7d7792c6fc4a4de3acdf7ad35e4771` | list/read/create/full-write/replace/format/insert/delete/layout/export 全部可由 HTTP MCP 呼叫 |
| `src/storage.ts` | `8baa5e9afb8b0262b63dbf9b93608fcc2fa3cd30` | 答案與匯出檔實際落在本機 storage |
| `src/layout.ts` | `fc00c8bd18ec396f85214fc22451b3eb5c40a912` | 44 行模型由靜態邏輯計算，仍需真實 renderer／列印驗證 |
| `src/exporters.ts` | `bd8ab8659e10407dd35e350a75cb238fa7a34786` | 產生 DOCX／PDF／TXT；檔案存在不等於跨 renderer 版面一致 |
| `package.json` | `2ecab78b5d328d213d48fe27b938f9aacb2fa46f` | 定義 build/test，但 HEAD 無遠端執行收據 |

## Finding 與 Issue 對應

### F1 — remote HTTP MCP 沒有 owner 授權邊界

- kind：`BUG`
- severity：`P1`
- decision_priority：`HIGH_BEFORE_REMOTE_USE`
- triage：`NEEDS_REVIEW`
- evidence：`SOURCE_CONFIRMED`
- runtime：`NEEDS_RUNTIME_VERIFICATION`
- auto_implementation：`false`
- fingerprint：`police-essay-mcp + HTTP MCP + README-supported HTTPS tunnel + unauthenticated /mcp + list/read/mutate/delete/export all local answers`
- 追蹤：[Issue #1](https://github.com/Reese-max/police-essay-mcp/issues/1)

可達因果鏈：使用者依 README 把 `/mcp` 暴露到 HTTPS tunnel；endpoint 沒有驗證 Authorization；取得可達 URL 的呼叫者即可列出完整答案、改寫／刪除內容並建立匯出。這是資料機密性、完整性與權限的重大影響，因此為 P1。未升 P0：預設 host 仍是 `127.0.0.1`，需要使用者主動 tunnel／代理；沒有已部署、URL 外洩或事故證據。

最小修正是保留 stdio／loopback 本機模式，remote mode 無明確認證即 fail closed；驗證發生在 MCP transport 與 tool handler 前；CORS 限於設定 origin，不能取代 auth。若採 MCP auth，僅建單一 owner／read-write 邊界，不建立通用 IAM。

驗收與完整限制已置於 Issue。建立前重複檢查 0；建立後讀回 Issue 與 comments，取得並釋放本輪 lease。沒有啟動實作。

### Evidence backlog（未開單）

- DOCX／PDF 在 Word、LibreOffice、瀏覽器 PDF viewer、手機與實體列印能否維持兩頁 44 行：`VALIDATION_GAP / NOT_ESTABLISHED`，目前沒有失敗重現。
- 同一 answer 的並行 expected-version 編輯是否有使用者可達衝突：需要隔離 concurrency reproduction，現有來源不足以確認產品缺陷。
- Actions／deployment receipt 缺失：阻止 CLEAN，但不是自動 P1／P2。

## 外部競品與替代工作流

查閱日均為 2026-09-19；只採官方頁面。頁面未標發布／更新日者記 `UNKNOWN`。產品功能宣稱不視為獨立成效證據。

| 替代 | 類型／使用者 | 已確認能力 | 相對位置 | 信號 |
|---|---|---|---|---|
| [Google Docs：Pages / Pageless](https://support.google.com/docs/answer/11528737?hl=en) | 通用協作文件 | pages mode 可控制 page break、margin、header/page number；pageless 改變 wrapping | 首次成功、手機、協作、分享強；固定 44 行需人工 template 與逐次檢查 | `CONFIRMED`；頁面日期 `UNKNOWN` |
| [Microsoft Word：調整表格列欄](https://support.microsoft.com/en-us/office/resize-a-table-column-or-row-5b770bba-f5c2-4e3b-b2fb-51d89fbd5515) | 桌面文件／列印 | 以固定列高／表格模板手工建立答題紙 | 列印與版面成熟；結構化段落 MCP 編修與 deterministic line receipt 需人工 | `CONFIRMED`；本輪頁面內容存取受限，日期 `UNKNOWN` |
| [Typst：Page setup](https://typst.app/docs/guides/page-setup/) | 程式化排版使用者 | 可程式化 page size、margin、header/footer 與 page breaks | 排版可重現、開源／CLI 強；對一般考生首次成功門檻較高 | `CONFIRMED`；頁面日期 `UNKNOWN` |
| LaTeX／紙本表格模板 | 間接替代 | 以既有模板人工填寫或編譯 PDF | 可控且離線；局部文字調整、回饋與非技術 UX 弱 | `LIKELY`；未取得本輪一手產品頁，不作優先級證據 |

比較：

- `MUST MATCH`：可預覽、可匯出、可恢復原稿、不因局部編修意外破壞整份答案。
- `SHOULD BE BETTER`：從段落意圖到 44 行答題紙的首次成功；超行時指出具體段落而非只給總錯誤。
- `DIFFERENTIATOR`：本機優先、結構化段落、明確版本檢查、針對臺灣申論紙的 deterministic line model。
- `DO NOT COPY`：通用文件套件的協作、雲端硬碟、模板市集、AI 寫作／評分與帳號平台廣度。
- 安全／隱私：本機 storage 是優勢，但 README 支援的 tunnel 會改變信任邊界；未修 F1 前不能以「local-first」概括 remote path。
- API／自動化：MCP 工具比手工模板直接；目前 remote auth 是必要門檻。
- 手機、效能、定價、分發：repository 未提供可驗證的正式資料，均為 `UNKNOWN`，不編造 benchmark 或 ROI。

## 產品董事會多視角推演

這是模型多視角推演，不是 13 位獨立專家投票。

| 角色 | 判斷／分歧 |
|---|---|
| CEO | 只做 remote safety、真實版面 receipt、單一路徑首次成功；不做通用寫作平台。 |
| CPO | INVEST 於「段落意圖 → 固定考卷」；NARROW 所有非核心擴張。 |
| CTO | 認證必須在 handler 前；反對先做帳號／租戶系統。 |
| Staff/Principal Engineer | 保留 stdio/loopback 簡單性；remote config 明確 fail closed，測試不共享 production data。 |
| UX Lead | 使用者需要知道還能寫幾行、哪段超行、局部操作是否改到其他段。 |
| UX Researcher | 合成 Persona 只能找假設；首次成功、超行修復與列印仍需真人／實機觀察。 |
| Growth | ChatGPT connector 是可能分發面，但在安全與可靠性收據前不擴大宣傳。 |
| CFO | 不投入雲端 storage、帳號與多 provider；先證明本機單人旅程，避免固定成本。 |
| Security/Privacy | F1 是 remote use blocker；wildcard CORS 不是 auth，URL 保密也不是權限模型。 |
| QA | unit test 不等於 tunnel、Office renderer、手機與列印；需要 exact-head journey receipts。 |
| SRE | 無 deployment/run 證據，不宣稱可用性；若未來 remote service 化才定義 SLO。 |
| Accessibility | DOCX/PDF 的 reading order、heading、zoom、screen reader 與鍵盤路徑未驗證。 |
| Support | 先提供「只用 stdio/loopback」安全替代與明確復原步驟，減少誤暴露和版面求助。 |

實質分歧：Growth 希望及早利用 ChatGPT connector；Security、QA 與 Support 認為在 F1 和真實匯出收據前只能小規模隔離驗證。CEO 採後者，不把模擬票數當成 PASS。

## 50 合成 Persona（獨立於固定 A01–J05）

以下為模型合成推演，不能當真人比例、發生率、營收或優先級證據。30 個 regression baseline 保留核心既有旅程，20 個 exploration 擴充邊界。

| ID | 背景／限制 | 目標與旅程 | 摩擦／結果 | 分級與建議 | 證據 |
|---|---|---|---|---|---|
| R01 | 警察特考新手；只會 ChatGPT | 建立四段答案並匯出 PDF | tunnel 步驟跨越信任邊界；阻擋 remote | P1：先修 #1 | source + synthetic |
| R02 | 在職考生；時間零碎 | 手機改第三段後續寫 | 手機 connector／預覽未驗證 | NEEDS_EVIDENCE：實機 journey | synthetic |
| R03 | 補習班學員；Word 熟悉 | 匯出 DOCX 再調字型 | 可能改變換行／頁數 | NEEDS_EVIDENCE：Word receipt | synthetic |
| R04 | 純本機隱私使用者 | stdio 建立與保存答案 | 不需要 OAuth；過度設計會傷首次成功 | KEEP：local path 回歸 | source + synthetic |
| R05 | 初次寫申論；不懂行數 | 寫滿 44 行 | 需要指出超行段落與修正方向 | P2 假設：先 usability test | synthetic |
| R06 | 既有長文使用者 | 匯入後切成前言／本文／結論 | 匯入能力未明確 | NEEDS_EVIDENCE，不開大單 | synthetic |
| R07 | 低頻使用者 | 一月後重開舊答案 | storage 可讀但 backup／restore 未驗證 | P3 假設：復原測試 | source + synthetic |
| R08 | 多科準備者 | 列出並切換多份答案 | list 會回完整內容且 remote 無 auth | P1：#1 | source + synthetic |
| R09 | 逐段校稿者 | 只改第二段格式 | HEAD 改進此流程但無 receipt | NEEDS_RUNTIME | source + synthetic |
| R10 | 容易誤刪者 | 刪除文字後想復原 | destructive tool 存在；復原 UX 未證明 | P2 假設：隔離測試 | source + synthetic |
| R11 | 網路不穩使用者 | tunnel 中斷後續作 | session／重試結果未知 | NEEDS_EVIDENCE | synthetic |
| R12 | 不懂技術設定者 | 按 README 接 ChatGPT | 裸 URL 指引可造成暴露 | P1：#1，先給安全替代 | source + synthetic |
| R13 | 公共電腦使用者 | 臨時編修不留資料 | local JSON 可能持久化 | P3 假設：文件化 storage | source + synthetic |
| R14 | 使用 LibreOffice | DOCX 開啟後列印 | line/page fidelity 未驗證 | NEEDS_EVIDENCE | synthetic |
| R15 | 直接印 PDF | A4 雙面列印 | printer scaling 可能改版面 | NEEDS_EVIDENCE | synthetic |
| R16 | 使用繁中標點 | 大量全形標點與引號 | line estimator 對字寬的真實性未知 | NEEDS_EVIDENCE | synthetic |
| R17 | 含英文法條縮寫 | 中英數混排 | wrapping 可能偏離 44 行模型 | NEEDS_EVIDENCE | synthetic |
| R18 | 需要列點 | 多層清單轉答題紙 | layout／indent 可能吃行 | P3 假設：render test | synthetic |
| R19 | 長標題題目 | 題目與答案同頁 | 題目是否占行需清楚 | P3：文件／測試 | source + synthetic |
| R20 | 強迫症版面需求 | 每段間距一致 | 格式局部變更可能牽動全文 | NEEDS_RUNTIME | synthetic |
| R21 | 兩裝置使用者 | 桌機寫、手機看 | local-first 無同步屬設計取捨 | DON'T ADD cloud；先 export | synthetic |
| R22 | 無網路環境 | 完全離線寫作 | stdio/local 符合需求 | MUST PRESERVE | source + synthetic |
| R23 | 輔助科技使用者 | screen reader 讀 DOCX/PDF | reading order 未驗證 | NEEDS_EVIDENCE：AT test | synthetic |
| R24 | 低視力使用者 | 放大 200% 預覽 | 固定版面與可讀性衝突 | NEEDS_EVIDENCE | synthetic |
| R25 | 鍵盤操作使用者 | 不用滑鼠完成流程 | ChatGPT/connector path 未測 | NEEDS_EVIDENCE | synthetic |
| R26 | 多次修訂者 | 以 expected version 防覆寫 | 並行衝突需 reproduction | evidence backlog | source + synthetic |
| R27 | 備份敏感者 | 損壞後找回 JSON | 無 durable receipt | P2 假設：restore drill | synthetic |
| R28 | 法規引用密集 | 編號與括號不可錯 | TXT/DOCX/PDF fidelity 未測 | NEEDS_EVIDENCE | synthetic |
| R29 | 臨考急用者 | 五分鐘內完成首次匯出 | setup/tunnel 複雜度可能失敗 | SHOULD BE BETTER：one journey | synthetic |
| R30 | 安全保守者 | 只允許本人讀寫 | remote 路徑目前失敗 | P1：#1 | source + synthetic |
| E01 | 補習班老師；不授權協作 | 示範模板給學生 | 多人平台不是需求 | DON'T BUILD collaboration | synthetic |
| E02 | Mac 使用者 | Pages 開 DOCX | renderer fidelity 未驗證 | NEEDS_EVIDENCE | synthetic |
| E03 | Windows 路徑特殊字元 | 匯出到深層目錄 | 路徑錯誤處理未知 | P3 假設：platform test | synthetic |
| E04 | Linux/Typst 使用者 | 用 CLI 比對 PDF | 可作獨立 benchmark，不必整合 | EXPERIMENT：golden render | synthetic |
| E05 | 多語考生 | 中英日混排 | glyph/font fallback 未驗證 | NEEDS_EVIDENCE | synthetic |
| E06 | 弱網路但需 connector | tunnel 斷線重連 | session recovery 未證明 | NEEDS_EVIDENCE | synthetic |
| E07 | 使用公司代理 | proxy 後接 MCP | URL 可達不等於 owner auth | P1：#1 | source + synthetic |
| E08 | 共享家用網路 | host 改成 `0.0.0.0` | LAN 其他人可達全部工具 | P1：#1 | source + synthetic |
| E09 | 惡意 URL 猜測者 | 探測公開 tunnel | 無 auth 便可列／改答案 | P1：#1 | source + synthetic |
| E10 | 合法只讀 reviewer | 只看答案不應修改 | 現在沒有 read/write scope | SHOULD：最小 scope 或單 owner | source + synthetic |
| E11 | 版本衝突使用者 | 兩個 ChatGPT 對話同改 | 可能遭 expected-version 拒絕或競態 | NEEDS_REPRODUCTION | synthetic |
| E12 | 自動備份使用者 | 同步 answers 目錄 | repo 未承諾；外部替代可用 | DON'T BUILD cloud backup | synthetic |
| E13 | PDF 無障礙審查者 | 檢查標記與 reading order | exporter 證據不足 | NEEDS_EVIDENCE | synthetic |
| E14 | 印表機縮放預設 97% | 列印兩頁答題紙 | 尺寸與行距可能偏移 | NEEDS_EVIDENCE | synthetic |
| E15 | 大字型需求 | 調大字仍想 44 行 | 目標本身衝突 | UX：明示取捨，不承諾同時滿足 | synthetic |
| E16 | 題庫平台期待者 | 搜題、評分、排名 | 超出核定範圍 | DEFER/REJECT | synthetic |
| E17 | AI 代寫期待者 | 自動生成申論答案 | 信任、學術與定位風險 | DO NOT COPY | synthetic |
| E18 | 檔案取證敏感者 | 確認刪除後無殘留 | storage/delete 語義未實測 | P3 research：隔離驗證 | synthetic |
| E19 | npm 安裝新手 | 乾淨機首次啟動 | 無 CI/clean-install receipt | VALIDATION_GAP／NOT_ESTABLISHED | source + synthetic |
| E20 | 維護者 | 升級 MCP SDK | auth/session 相容性風險 | MAINTAIN：pin + regression | source + synthetic |

合成偏好不計票。質性 switching test：需要協作／雲端／手機共同編輯者較可能留在 Google Docs／Word；需要本機、段落級指令與固定申論紙者才有切換理由。這是模擬，不是市場占比或真人意願。

## Red Team：嘗試推翻建議

1. **「預設只綁 loopback，所以不算問題」**：對純本機成立；但 README 明確支援 HTTPS tunnel，且沒有 remote mode gate，因此只推翻「本機一定需要 OAuth」，不能推翻 F1。
2. **「CORS `*` 就是暴露根因」**：不完整。非瀏覽器 MCP client 不受 CORS 保護；根因是 remote request 沒有身分／權限驗證。只改 CORS 不足。
3. **「URL 很難猜，可當 secret」**：URL 可能進入瀏覽器歷史、代理、log 或分享紀錄，且 repo 沒有把它定義為可輪替 credential；不能取代 auth。
4. **「直接建 OAuth／帳號平台」**：過度工程。單人本機產品可先用符合 client 能力的窄 owner boundary 或可信 tunnel access control，並保留 stdio。
5. **「沒 CI 所以產品 P1」**：否。缺 receipt 只形成 validation gap／阻止 CLEAN；F1 的 P1 來自具體可達資料與權限因果鏈。
6. **「44 行演算法已有測試，所以跨 Office 已完成」**：否。單元邏輯不能證明 renderer、font、printer scaling、mobile 或 AT path。
7. **「競品有協作／AI，所以也要做」**：否。尚無使用者授權、需求與經濟證據；增加範圍會稀釋可驗證差異化。
8. **相反證據上限**：沒有正式 exposure／incident，故不升 P0；沒有真實 renderer 失敗，故不為版面假設開 P2 bug。

## NOW / NEXT / LATER / DON'T

- **NOW**：review Issue #1；remote use 前 fail closed；維持 stdio／loopback 安全替代。
- **NEXT**：以隔離資料保存 exact-head ChatGPT remote auth、44 行 DOCX/PDF/Word/LibreOffice/print、首次成功與復原 receipts。
- **LATER**：只有實測顯示高頻完成率問題時，才收斂超行說明、衝突復原、accessibility 或 platform-specific patch。
- **DON'T**：OCR、AI 評分／代寫、題庫、LMS、帳號／雲端同步、多人協作、商城、通用 IAM／文件平台。

## 固定 A01–J05 與回歸狀態

本報告的 50 Persona 是產品市場合成推演，與固定 A01–J05 稽核完全分開，沒有替代或改寫固定角色。本輪未在必要 runtime 執行 A01–J05，也沒有形成一個完整合格輪次；因 F1 尚未修正且 Office／print／remote connector／accessibility 證據待補，portfolio 狀態維持 `NOT CLEAN, 0/2`。

Default branch 尚無產品修正可重跑，因此：

- VERIFIED_FIXED：0
- PARTIALLY_FIXED：0
- STILL_REPRODUCIBLE：0（未執行破壞性 runtime reproduction）
- REGRESSION：0
- CANNOT_VERIFY / NEEDS_RUNTIME_VERIFICATION：F1 remote journey、renderer／print、mobile、AT、clean install

## 寫入、互斥與統計

- 新增 actionable Issue：1（#1）
- 更新／重開 Issue：0
- 去重避免：0（建立前 repo Issues／PR／branches 及中央 audit 搜尋均無相同 fingerprint）
- evidence backlog：3
- 分級修正：0
- Verified Fixed：0
- 產品程式／CI／設定修改：0
- report write：本檔，audit-only
- issue lease：建立後追加唯一 lock marker、讀回確認為最早有效 marker；完成後以相同 run/repo/issue 釋放
- 寫入阻塞：0

## Decision Memo

**服務誰：**重視本機隱私、需要把段落內容精準收斂到臺灣警察／公務人員申論答題紙的個人考生。  
**為何選擇／如何競爭：**不和 Word／Google Docs 比協作廣度；以結構化段落指令、固定行數回饋與可攜匯出降低手工模板迭代。  
**差異化：**local-first、deterministic 44-line model、版本化局部編修；前提是 remote connector 不破壞 local-first 的信任承諾。  
**前三優先：**remote owner boundary、跨 renderer／列印 receipt、單一首次成功／復原旅程。  
**刪除／不做：**不新增帳號、雲端、協作、AI 評分、OCR、題庫、LMS、商城與通用平台。  
**主要風險：**tunnel 未授權存取；演算法與真實列印不一致；沒有可保存的 exact-head runtime 證據。  
**最小實驗：**在隔離答案上以 auth/no-auth 兩條 tunnel journey 驗證拒絕邊界，再用同一 golden answer 比對 DOCX／PDF／Word／LibreOffice／print；不使用正式資料。  
**建議：**`INVEST` 核心 journey；`SIMPLIFY` remote trust boundary；`MAINTAIN` local mode；其他方向 `PAUSE/DEFER`。建議不構成實作、merge、部署或付費授權。
