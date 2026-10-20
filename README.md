# police-essay-mcp

「國考申論答題紙排版與 AI 編修引擎」的 MCP server，包含 ChatGPT Apps SDK 互動畫板。

它把答案保存成有順序的 sections 與可獨立格式化的 paragraphs，透過固定模板計算中英文字寬與實際行數，再提供縮排、對齊、段落間距、Tab、標題粗體／編號、局部修改、溢出檢查與 DOCX/PDF 固定格線輸出。預設模板是 A4、2 頁、每頁 22 行。

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
- `ESSAY_MCP_PDF_FONT`：PDF 使用的中文字型檔路徑
- `ESSAY_MCP_PDF_BOLD_FONT`：PDF 粗體段落使用的中文字型檔路徑
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

儲存採原子替換、每份答案有寫入鎖，且儲存時會再次檢查版本；因此併發修改不會默默覆蓋較新的答案。

## 工具工作流

1. `load_exam_paper` 讀取模板。
2. `create_answer` 建立文件，或 `write_answer` 寫入 sections。
3. `read_answer` / `check_layout` 讀取真實行數。
4. 修改前先用 `preview_change` 查看差異：`operation` 填要預覽的修改工具（`write_answer`、`replace_text`、`format_section`、`insert_text`、`delete_text`、`edit_text`、`move_section` 或 `renumber_items`），其餘參數與該工具相同。
5. 確認預覽後才呼叫對應的寫入工具；所有修改都帶 `expectedVersion`。
6. 超出時依 `compressionHints` 使用 `replace_text` 濃縮指定區塊。
   - `move_section` 把區塊移到另一個區塊之前或之後。
   - 插入、刪除或搬移後，手寫編號（壹、一、（一）、1.、（1））若不再連續，`renumber_items` 會依層級重新編號：標題自成一串，各區塊的段落各自一串，下層遇到上層項目時從 1 重新起算。
   - `set_line_targets` 設定各節目標行數（含標題與空行）；`check_layout` 會回報各節行數、與目標的差距，以及補滿或壓縮時該從哪一節增減。
   - `update_answer_info` 修改標題、題目，或記錄這份答案屬於哪場考試、第幾題；`list_answers` 會依考試分組、依題號排序。`duplicate_answer` 複製目前內容成一份新答案，用來試寫另一個版本。
7. `fits=true` 後呼叫 `export_docx`、`export_pdf` 或 `export_text`。結果保留本機 `path`，另附不含檔名的隨機 `exportUri` 與 `resource_link`；remote owner client 可在 24 小時內用 `resources/read` 取回 bytes。
   - `export_answer` 一次輸出同一版本的 Word 與 PDF（`formats` 可選 `docx`、`pdf`、`txt`），檔名例如 `114年警察特考_第1題_資訊系統可行性評估.docx`；設定 `ESSAY_PUBLIC_BASE_URL` 時另附直接下載連結。
8. 使用者明確要求永久刪除時，以 `read_answer` / `list_answers` 取得目前版本，再呼叫 `delete_answer`（必須帶 `expectedVersion`）。答案、全部修改紀錄與匯出檔一併刪除，無法復原；唯讀 credential 看不到此工具。

工具的 `outputSchema` 只列出關鍵欄位（例如 `answer.id`／`version`、`layout.fits`／`totalLines`），巢狀的段落格式與逐行排版仍完整出現在 `structuredContent`。這讓 `tools/list` 從約 262 KB 降到約 64 KB；`npm test` 的契約檢查會確認精簡 schema 只刪減、不新增或改型別任何基準欄位。

## 正式格式

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


## 166 原稿紙模式

新增模板 `police_information_essay_166`；既有模板及答案不變。原稿紙以不可編輯底圖呈現，保留記分欄與印刷提示，正文為可編輯的 Word 表格文字或 PDF 文字。每頁 22 行，共兩頁；不增加標題、姓名、頁碼或字型註記。`title` 僅供答案管理及檔案中繼資料使用。

此模式須取得教育部標準楷書 5.1 完整未修改字型，設定 `ESSAY_MCP_PAPER_FONT` 為檔案絕對路徑。`export_docx` 與 PDF 一樣只內嵌答案用到的字形（另含 ASCII 與常用全形標點），未安裝此字型的 Word／LibreOffice 也以同一字型、同一換行顯示；在 Word 新增內嵌範圍以外的字時才改用替代字型。字型不隨 repository 分發。字型來源與使用條件見 [原稿紙工作流](docs/original-paper-workflow.md)。

`check_layout` 採實際字型寬度，預留 Word 中英文間距，並避免孤立句號。換行不刪改文字；超出 44 行會回報壓縮建議，但須由使用者或模型另行編輯。此模板的 `export_docx`、`export_pdf`、`export_text` 均拒絕超頁及 `allowOverflow: true`。

驗證新模式：設定字型後執行 `npm run check`、`npm test`、`npm run build`。可以 `node --import tsx scripts/paper166-smoke.ts /path/to/blocks.json` 建立測試輸出；blocks 為 `[{"text":"正文","kind":"normal"}]`。輸出位於 `exports/paper166-qa/`，須再轉出 Word PDF，核對兩頁、完整文字及每行位置。

## 互動畫板

呼叫 `render_answer_sheet` 開啟已儲存答案。166 模式的畫板使用原稿紙及字型輪廓，閱讀端不必下載字型；一般模式顯示行數與區塊編輯預覽。可點選一行定位區塊、預覽修改、再套用；`expectedVersion` 保護既有答案。畫板另有：字句修改（找／換成，可指定第幾處或全部取代，可把文字框選取的字帶入）、上移／下移目前區塊、重新編號（先預覽，再按一次確認）、版本紀錄與「還原成這一版」。唯讀連線停用所有修改，只能查看版本紀錄。Word 定稿仍須依原稿紙工作流實際渲染驗收。

畫板支援 MCP Apps 初始化與宿主工具呼叫，也支援宿主提供的 `window.openai.callTool`。未收到宿主回應時顯示逾時，不會自動重送修改。
