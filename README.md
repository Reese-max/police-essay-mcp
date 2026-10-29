# police-essay-mcp

「國考申論答題紙排版與 AI 編修引擎」的 MCP server，包含 ChatGPT Apps SDK 互動畫板。

它把答案保存成有順序的 sections 與可獨立格式化的 paragraphs，透過固定模板計算中英文字寬與實際行數，再提供縮排、對齊、段落間距、Tab、標題粗體／編號、局部修改、溢出檢查與 DOCX/PDF 固定格線輸出。預設模板是 A4、2 頁、每頁 22 行。

## 新建答案的預設模板

`create_answer` 與 `create_answers`（含 `start_exam` 全卷流程）省略 `templateId` 時，使用 `police_information_essay_166` 原稿紙：A4、兩頁、每頁 22 行、19pt 教育部標準楷書、原底圖與自然字距。必須先設定 `ESSAY_MCP_PAPER_FONT`，字型來源與 SHA 校驗見 [166 工作流](docs/original-paper-workflow.md)；缺少、遭修改或缺字會明確失敗，不會改用一般模板或替代字型。

一般模板及其粗體、縮排等格式仍可明確指定 `templateId: "police_information_essay"`。既有答案、預覽、複製與匯出沿用各答案儲存的模板，不遷移資料。`load_exam_paper` 不帶答案時使用新預設；帶 `answerId` 且省略模板時沿用該答案，明確指定不符模板仍拒絕。既有一般模板資源 URI `essay://templates/police_information_essay` 保持原意。

同一 `idempotencyKey` 的省略模板重試沿用已存答案模板，完整請求雜湊仍會拒絕不同內容或明確改模板。匯出成功仍是 `delivery.status=awaiting_review`，不代表內容、來源或視覺已驗收。

## 執行

```powershell
npm install
npm run build
$env:MCP_AUTH_TOKEN = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
npm start
```

預設 MCP endpoint：`http://127.0.0.1:8787/mcp`。

健康檢查：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/health
```

就緒檢查（會確認預設模板可讀取）：

```powershell
Invoke-WebRequest http://127.0.0.1:8787/readyz
```

本機 stdio 模式：

```powershell
$env:MCP_TRANSPORT = "stdio"
npm start
```

可用環境變數：

- `PORT`：HTTP port，預設 `8787`
- `HOST`：綁定位址，預設 `127.0.0.1`
- `ESSAY_MCP_TEMPLATE_DIR`：模板目錄
- `ESSAY_MCP_ANSWER_DIR`：答案 JSON 目錄
- `ESSAY_MCP_EXPORT_DIR`：DOCX/PDF 輸出目錄
- `ESSAY_MCP_PDF_FONT`：PDF 使用的中文字型檔路徑。若指向 Noto Sans CJK 的 TTC（例如 Docker 預設的 `NotoSansCJK-Regular.ttc`），PDF 會依 postscriptName 選取正體中文（CJKtc）字面，而不是固定取集合中的第 0 個（日文 JP）字面；找不到正體字面才退回單一字型。
- `ESSAY_MCP_PDF_BOLD_FONT`：PDF 粗體段落使用的中文字型檔路徑。TTC 同樣選取 CJKtc 粗體字面，而非 JP 粗體。
- `ESSAY_MCP_PDF_ITALIC_FONT`：PDF 斜體段落使用的中文字型檔路徑
- `MCP_AUTH_TOKEN`：HTTP owner Bearer token；所有 HTTP 模式預設都必須設定，包含 tunnel 代理的 loopback
- `MCP_READ_TOKEN`：可選的獨立唯讀 Bearer token，只提供讀取與不寫入的預覽工具
- `MCP_ALLOW_ANONYMOUS_LOOPBACK`：只有在完全沒有 tunnel／代理的純本機 loopback 用途，才能明確設為 `true`，且不得同時設定 token
- `MCP_ALLOW_ANONYMOUS_REMOTE`：明確設為 `true` 時，遠端 `/mcp` 不需任何認證即可讀寫、刪除與匯出全部答案；只能搭配 `AUTH_MODE=bearer`，且不得設定非空白的 owner／read token、`CORS_ORIGIN` 或 `MCP_ALLOW_ANONYMOUS_LOOPBACK`；帶瀏覽器 Origin 的請求一律拒絕
- `MCP_MAX_BODY_BYTES`：HTTP 請求大小上限，預設 2 MB
- `MCP_REQUEST_TIMEOUT_MS`：HTTP 請求逾時，預設 30 秒
- `CORS_ORIGIN`：可選的單一可信 HTTPS origin（或本機 HTTP origin）；未設定時不允許跨來源瀏覽器請求
- `ESSAY_PUBLIC_BASE_URL`：可選，服務對外的 HTTPS origin。設定後，匯出結果會附上直接下載連結 `/downloads/<代號>/<檔名>`：代號隨機、隨匯出檔 24 小時後失效，下載檔名用考試、題號與標題。純 OAuth 模式不提供這個路由。

## 驗證

```powershell
npm run check
npm test
```

若要接 ChatGPT Developer Mode，先確認連接器能對每次 `/mcp` GET／POST／DELETE 請求提供 owner Bearer credential，或由可信 access gateway 驗證使用者後代送 credential。確認 HTTPS tunnel 本身的存取控制，再使用 tunnel URL 加上 `/mcp` 建立 app。若連接器無法提供這項驗證，請勿公開 tunnel；可改用本機 stdio。唯一例外是擁有者明確接受風險並啟用 `MCP_ALLOW_ANONYMOUS_REMOTE=true`，此時 app 以無認證連線，任何知道網址的人都能讀寫全部答案。工具描述或 resource URI 更新後，需在 ChatGPT 中重新整理 app。

## 安全與部署

HTTP 預設只綁定 `127.0.0.1`，但 tunnel 可以直接代理這個位址，因此 HTTP 預設沒有 owner token 就拒絕啟動。使用高熵隨機 token，勿放進 URL 或提交到 Git。可另外設定不同的 `MCP_READ_TOKEN` 給唯讀客戶端；此 token 無法呼叫建立、修改、刪除或匯出工具，也不能讀取匯出 artifact resource。`MCP_ALLOW_ANONYMOUS_LOOPBACK=true` 僅保留給沒有 tunnel／代理的純本機使用，非 loopback `HOST` 會拒絕此模式。`MCP_ALLOW_ANONYMOUS_REMOTE=true` 會讓任何能連到服務的人匿名讀寫全部答案，只應在擁有者明確接受此風險時使用，啟動時會記錄警告。除匿名模式外，缺少或無效 credential 的 `/mcp` 請求會在進入 MCP handler 前回傳 401，並附 `WWW-Authenticate: Bearer` challenge，讓連接器能辨識所需的 credential 類型。CORS 只接受明確設定的可信來源，而且不能代替認證。`/health` 是存活檢查，`/readyz` 會額外確認模板可讀取。

匿名 loopback 的 `/mcp` 只接受 `127.0.0.1`、`localhost` 或 `[::1]` 的 Host（可帶目前監聽 port）；公開 Host 或帶有 `Forwarded`、`X-Forwarded-*`、`Via` 的請求會在建立 MCP transport 前回傳 401。這也阻擋以公開網域連到 loopback 的 DNS rebinding 請求。代理若改寫 Host 並移除所有代理標頭，server 無法辨識，所以任何 tunnel／代理仍必須使用 owner token 模式。此限制不影響有 owner／唯讀 token 的代理請求；自動測試使用隔離資料，不能代替實際 HTTPS tunnel／ChatGPT 連接器的 credential／401 收據。

儲存採原子替換、每份答案有寫入鎖，且儲存時會再次檢查版本；因此併發修改不會默默覆蓋較新的答案。

## 工具工作流

多題試卷最短流程：`start_exam` → `create_answers(examId)` → 修正版面 → `render_exam_overview(examId)` → `export_exam_bundle(examId)`。`start_exam` 記錄考試名稱、1–20 個不重複題號、題目與目標頁數，可指定合輯格式 `pdf`／`docx`，預設兩者皆輸出。同一個 `idempotencyKey` 與請求可安全重送，換內容須換 key。

中斷或使用者說「繼續」時，先呼叫 `get_exam_progress(examId)`，告知 `summary` 一次，再依 `nextStep` 接續。進度來自目前儲存的內容、版面與匯出版本，沒有估算百分比。已連結的題號再次呼叫 `create_answer`／`create_answers` 會回傳既有答案與 `replayed: true`，即使沒有 key 也不會重複建立；省略考試名稱、題號或題目時由計畫補入（題號取第一個未開始的題目）。批次可在最外層提供 `examId`，或逐題提供；兩者同時提供時必須一致。刪除答案會解除計畫連結。

`get_exam_progress` 每題回傳 `not_started`（未建立）、`drafted`（已保存，版面待修正）、`layout_ok`（目前版本版面通過）或 `exported`（目前版本已收入合輯），並回傳合輯 `none`／`current`／`outdated` 與下一步 `create_answer`／`fix_layout`／`export_exam_bundle`／`done`。匯出後修改答案會讓合輯過期。舊答案版面無效時，該題回傳遮蔽路徑的 error 與 drafted，其餘題目仍可讀取。**版面通過僅代表容量符合，內容未經查證。**

交付狀態另以 `delivery` 回傳：合輯尚未匯出、缺少計畫要求的格式或版本過期時，`status` 為 `not_ready`；目前版本及格式均已匯出時為 `awaiting_review`，摘要只宣告「合輯已匯出」。為相容既有客戶端，`nextStep.action=done` 保留為匯出流程終點，不能解讀為驗收通過。`checks.layoutCapacity` 只依目前各題的容量結果回傳 `pending`／`passed`，不表示品質警告已排除。`checks.content`、`source`、`visual` 固定為 `not_checked`，因為目前沒有保存內容、講義頁碼核對或逐頁視覺驗收的證據。待驗收是人工／助理核對階段，不是可呼叫的 MCP 工具；檢查時應逐題核對題意、來源與實際匯出頁面，不能因此重複建立或匯出。此版本尚未提供記錄驗收通過的工具。

`render_exam_overview(examId)` 依題號顯示同一畫板，尚未建立的題目仍列為「未建立」。頂端只有一個考試進度區域（`role="status"`、`aria-live="polite"`），重新載入分頁及寫入後原地讀取最新進度；唯讀模式可以查進度、不能建立計畫或改寫答案。

所有題目版面通過後，直接匯出一次，於同一則訊息提供 **PDF 與 Word 兩個下載連結**，不詢問是否匯出。整卷不提供 TXT；單題 TXT 保留供相容使用。

`export_exam_bundle(examId)` 未指定 formats 時遵循計畫格式（預設 PDF 與 Word），省略 `answers` 時，依題號釘選全部已連結答案的目前版本；缺題會回傳含 `questionNo` 的結構化錯誤。所有格式成功才保存計畫的 `lastBundle`，包含格式、各格式實際匯出頁數、逐題版本與匯出時間；若保存失敗會回收匯出 handle。帶 MCP `_meta.progressToken` 時，於全部驗證、每格式逐題繪製、每格式合併、全部保存等真實階段發送 `notifications/progress`；`total = 1 + 題數 × 格式數 + 格式數 + 1`。未帶 token 不發送通知。題目目標頁數是計畫資訊；實際版面容量仍由所選模板決定。

單題及進階編修沿用下列流程：

1. `load_exam_paper` 讀取模板。
2. `create_answer` 可同時帶 `exam`、`questionNo`、`lineTargets`，在版本 1 建立文件（lineTargets.sectionId 必須等於 sections 明確提供的 id），或 `write_answer` 寫入 sections。
3. `read_answer` 讀取完整文字；`check_layout` 讀取真實行數與品質警告（孤立標題、英文斷字，僅提醒、不阻擋匯出）。
4. 修改前先用 `preview_change` 查看差異：`operation` 填要預覽的修改工具（`write_answer`、`replace_text`、`format_section`、`insert_text`、`delete_text`、`edit_text`、`move_section` 或 `renumber_items`），其餘參數與該工具相同。
5. 確認預覽後才呼叫對應的寫入工具；所有修改都帶 `expectedVersion`。

一般模板新答案另預設 `layoutOptions.avoidPunctuationOnlyLines=true`：自然換行若只剩結尾標點，將前行最後一個字素（可完整容納時優先保留英文整詞）連同標點放入下一行，保留全部文字與字級；明確輸入的獨立標點或分隔線不改動。舊答案省略此旗標時維持既有換行，可用 `update_answer_info` 明確啟用。未啟用且發生自然換行的純標點行會回報 `PUNCTUATION_ONLY_LINE`。166 的量測換行沿用既有實作。

一般模板 PDF 在整行可容納時，會使用實際字形 advance 避免寬英文字母互相覆畫；放不下時保留原欄位位置並警告，不把更多字元推離頁面。實際字形寬度仍可能超出名義欄數，所以匯出 `fontWarning` 會指明合輯頁／行與不重疊排版所需寬度的超出點數。遇到這個警告應明確換行再匯出，不能把 `fits=true` 當成實際字形均在格內，也不會默默縮字或刪字。
6. 超出時依 `compressionHints` 使用 `replace_text` 濃縮指定區塊。
   - `move_section` 把區塊移到另一個區塊之前或之後。
   - 插入、刪除或搬移後，手寫編號（壹、一、（一）、1.、（1））若不再連續，`renumber_items` 會依層級重新編號：標題自成一串，各區塊的段落各自一串，下層遇到上層項目時從 1 重新起算。
   - `set_line_targets` 設定各節目標行數（含標題與空行）；`check_layout` 會回報各節行數、與目標的差距，以及補滿或壓縮時該從哪一節增減。
   - `update_answer_info` 修改標題、題目，或記錄這份答案屬於哪場考試、第幾題；`list_answers` 會依考試分組、依題號排序。`duplicate_answer` 複製目前內容成一份新答案，用來試寫另一個版本。
7. `fits=true` 後呼叫 `export_docx`、`export_pdf` 或 `export_text`（均可選填 `expectedVersion`，不符時回傳 `VERSION_CONFLICT`）。結果保留本機 `path`，另附不含檔名的隨機 `exportUri` 與 `resource_link`；remote owner client 可在 24 小時內用 `resources/read` 取回 bytes。
   - `export_answer(expectedVersion)` 釘選版本，一次輸出同一版本的 Word 與 PDF（`formats` 可選 `docx`、`pdf`；舊單題 TXT 介面保持相容），檔名例如 `114年警察特考_第1題_資訊系統可行性評估.docx`；設定 `ESSAY_PUBLIC_BASE_URL` 時另附直接下載連結。
8. 使用者明確要求永久刪除時，以 `read_answer` / `list_answers` 取得目前版本，再呼叫 `delete_answer`（必須帶 `expectedVersion`）。答案、全部修改紀錄與匯出檔一併刪除，無法復原；唯讀 credential 看不到此工具。

`export_answer` 與 `export_exam_bundle` 執行失敗回傳 `isError: true` 與 `structuredContent.errors: [{ code, answerId?, questionNo?, format?, retryable, message }]`，保留原有錯誤文字。代碼為 `ANSWER_NOT_FOUND`、`VERSION_CONFLICT`、`LAYOUT_OVERFLOW`、`LAYOUT_INVALID`、`EXPORT_FAILED`；`EXPORT_FAILED` 僅在明確暫時故障時可重試：Node `ETIMEDOUT`、`ECONNRESET`、`ECONNREFUSED`、`EAI_AGAIN`、`EBUSY`、`EMFILE`、`ENFILE`、`EPIPE`，或儲存／HTTP 狀態 408、429、500、502、503、504（含 Firestore 對應的 gRPC 暫時狀態）；未知、字型、內容與確定性繪製錯誤不可重試。錯誤訊息中的絕對檔案路徑遮蔽為 `<path>`，不公開內部堆疊。單題部分格式成功時保留 files、failed 與 errors，結果不標為 isError；合輯仍全部成功才回傳檔案。

多題考試可用 `export_exam_bundle`：`answers: [{ answerId, expectedVersion }]` 按順序合成一份 PDF（含逐題書籤）與 Word（DOCX；逐題從新頁開始，與單題共用固定格紙及字型）；重複 answerId 的拒絕訊息與結構化錯誤會列出各個重複 id；所有題目通過版本與容量檢查，且所有格式完成繪製後才建立匯出 handle；回傳逐題頁碼範圍與品質警告，PDF 字型警告列於 files[].fontWarning 與文字結果。合輯 manifest 以 relatedAnswerIds 關聯全部成員，刪除任一成員也會刪除並計入 deletedExports。後續格式建立 handle 失敗時會盡力回收先前 handle；錯誤列出失敗格式及回收失敗的遺留 handle。

`create_answer` 可帶 8–128 字元的 `idempotencyKey`（英數、`_`、`-`）：同 key、同請求重送會回傳原答案目前狀態及 `replayed: true`，不另存版本；同 key 不同請求回報 `IDEMPOTENCY_KEY_REUSED`。key 產生確定的 answerId，建立請求以排序 JSON 的 SHA-256 儲存為 createRequestHash；複製答案不帶此雜湊。`create_answers`（essay.write）一次接受 1–10 題，先驗證全部，再按順序儲存，回傳精簡摘要；每題使用不同 key。驗證錯誤列出項次／代碼，完全不寫入；中途 I/O 失敗列出已建立與失敗項目，相同批次搭配原 keys 可安全重試。

單題 `export_answer` 的 `textMode` 僅影響 TXT：預設 `paper` 保留目前格紙輸出；`paragraphs` 依權威版面去除視覺換行、縮排填充與間距行，保留標題編號、每段一行、節間空行，檔名加 `_段落`。容量／166 規則不變，pages 仍是稿紙頁數。

`read_answer` 只回傳資料，不顯示畫板；單題畫板用 `render_answer_sheet`，多題只呼叫一次 `render_exam_overview`，以題目分頁共用一個畫板。 兩種畫板工具預設 `responseDetail: "summary"`，`structuredContent` 僅含目前題目的 id／版本、版面統計與 `warningCount`（多題另含逐題摘要）；完整答案與逐行版面始終放在元件專用 `_meta.snapshot`；`responseDetail: "full"` 也在 `structuredContent` 回傳完整 snapshot 與 `readOnly`，166 模式另含 `paperSvgPages`。v12 畫板自行呼叫 render 工具一律要求 full，依序讀取結果 `_meta.snapshot`、完整 `structuredContent`、宿主初始輸出的 `toolResponseMetadata`，不依賴 `window.openai.callTool` 回傳 `_meta`。唯讀狀態依序取結果 `_meta.readOnly`、`structuredContent.readOnly`、僅宿主初始輸出的 `toolResponseMetadata.readOnly`、同答案既有狀態；皆未知時停用編輯。`openai:set_globals` 僅接受同次事件且答案 id／版本相符的 metadata；摘要缺少可用資料時呼叫一次 full render，避免顯示其他答案或舊版本。SVG 缺少時僅保留同答案同版本已顯示的原稿紙。分頁會更新寫入完成題目的行數與版本，重按目前分頁保留未儲存草稿。多題載入失敗會彙整缺少答案及帶答案 id 的版面錯誤，並遮蔽內部路徑與堆疊。

寫入工具預設 `responseDetail: "summary"`，只回傳答案基本資訊、版面統計與各節行數；`responseDetail: "full"` 保留完整答案與逐行版面。`read_answer`、`load_exam_paper`、`reflow_answer`、`check_layout` 仍回傳完整資料；所有工具輸出均排除僅供儲存使用的 `createRequestHash`。畫板收到寫入摘要時會透過 render_answer_sheet 載入完整答案，載入失敗顯示通知，過期回應不會蓋過後來顯示的答案。

工具的 `outputSchema` 只列出關鍵欄位（例如 `answer.id`／`version`、`layout.fits`／`totalLines`），完整模式的巢狀段落格式與逐行排版仍出現在 `structuredContent`，畫板工具預設使用 `_meta.snapshot`，full 模式也放入 `structuredContent`。`tools/list` 上限維持 80,000 bytes；`npm test` 的契約檢查會確認精簡 schema 只刪減、不新增或改型別任何基準欄位。

## 正式格式

新答案預設 `layoutOptions: { wholeLatinWords: true, keepHeadingWithNext: true }`，避免英數字詞跨行及標題落在頁尾、內文在次頁。整個英數字詞能放入下一行，且原行仍有非空白字元時才搬移（166 另計標點攜帶寬度）；超長字詞或原行僅有空白時沿用原斷行。標題與首行內文合計超過一頁時不搬移。舊答案未設定選項時維持原版面，可用 `update_answer_info` 局部開啟或以 `false` 關閉。為標題補入的空白行（`isSpacer`、`isPadding`）計入總行數、區塊行數與容量；複製沿用來源選項，還原內容保留目前選項。

`sections[].paragraphs[]` 可讓每個段落使用獨立格式；格式欄位的縮排與 Tab 單位都是顯示欄位：

```json
{
  "id": "body",
  "heading": "防制措施",
  "headingStyle": { "numbered": true, "bold": true },
  "paragraphs": [
    {
      "text": "第一段",
      "format": { "firstLineIndent": 2, "alignment": "justify", "spaceAfterLines": 1 }
    },
    {
      "text": "第二段\t補充說明",
      "format": { "leftIndent": 2, "tabSize": 4, "alignment": "distributed" }
    }
  ]
}
```

`text` 與 `paragraphs` 不必重複提供：可以只傳 `text`，也可以只傳至少一個項目的 `paragraphs`。若要在文字已存在後單獨調整格式，呼叫 `format_section`，例如只把第二段改成粗斜體：

```json
{
  "answerId": "ans_…",
  "sectionId": "body",
  "paragraphFormats": [
    { "index": 1, "format": { "bold": true, "italic": true } }
  ],
  "expectedVersion": 1
}
```

可用對齊值為 `left`、`right`、`justify`、`distributed`。`spaceBeforeLines` 與 `spaceAfterLines` 會實際佔用答題格紙行數；Word 會輸出正式段落屬性，PDF 與 TXT 會依相同欄位模型定位文字。

完整 v1 契約與排版規則請看 [SPECIFICATION.md](SPECIFICATION.md)。

## Figma 樣板

[開啟 Police Essay MCP｜申論答題紙樣板](https://www.figma.com/design/SBAKYNQQh3Mzv8MFKFwIrX)

視覺樣板對應 MCP 的固定格線、段落格式化、標題樣式與 `check_layout` 狀態。細節與節點對照請看 [docs/figma-template.md](docs/figma-template.md)。


## 165 原稿紙模式

新增模板 `police_information_essay_166`；既有模板及答案不變。原稿紙以不可編輯底圖呈現，保留記分欄與印刷提示，正文為可編輯的 Word 表格文字或 PDF 文字。每頁 22 行，共兩頁；不增加標題、姓名、頁碼或字型註記。`title` 僅供答案管理及檔案中繼資料使用。

此模式須取得教育部標準楷書 5.1 完整未修改字型，設定 `ESSAY_MCP_PAPER_FONT` 為檔案絕對路徑。`export_docx` 與 PDF 一樣只內嵌答案用到的字形（另含 ASCII 與常用全形標點），未安裝此字型的 Word／LibreOffice 也以同一字型、同一換行顯示；在 Word 新增內嵌範圍以外的字時才改用替代字型。字型不隨 repository 分發。字型來源與使用條件見 [原稿紙工作流](docs/original-paper-workflow.md)。

`check_layout` 採實際字型寬度，預留 Word 中英文間距，並避免孤立句號。換行不刪改文字；超出 44 行會回報壓縮建議，但須由使用者或模型另行編輯。此模板的 `export_docx`、`export_pdf`、`export_text` 均拒絕超頁及 `allowOverflow: true`。

驗證新模式：設定字型後執行 `npm run check`、`npm test`、`npm run build`。可以 `node --import tsx scripts/paper166-smoke.ts /path/to/blocks.json` 建立測試輸出；blocks 為 `[{"text":"正文","kind":"normal"}]`。輸出位於 `exports/paper166-qa/`，須再轉出 Word PDF，核對兩頁、完整文字及每行位置。

## 互動畫板

呼叫 `render_answer_sheet` 開啟已儲存答案。166 模式的畫板使用原稿紙及字型輪廓，閱讀端不必下載字型；一般模式顯示行數與區塊編輯預覽。可點選一行定位區塊、預覽修改、再套用；`expectedVersion` 保護既有答案。畫板另有：字句修改（找／換成，可指定第幾處或全部取代，可把文字框選取的字帶入）、上移／下移目前區塊、重新編號（先預覽，再按一次確認）、版本紀錄與「還原成這一版」。唯讀連線停用所有修改，只能查看版本紀錄。Word 定稿仍須依原稿紙工作流實際渲染驗收。

畫板支援 MCP Apps 初始化與宿主工具呼叫，也支援宿主提供的 `window.openai.callTool`。未收到宿主回應時顯示逾時，不會自動重送修改。
