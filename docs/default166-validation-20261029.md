# 166 新預設與兩頁比較檔驗證

> 歷史驗證紀錄：下文的 166 為當時的模板代碼或產物名稱，保留以供追溯。現行顯示名稱為 165，舊代碼僅供相容；目前狀態見 [第二輪名稱核對](template-name-165-audit-20261030.md)。

本輪接續基準：`4ed1a1dc6d951f98145b883b84f5b6c1aed6002b`。使用者已明確授權「繼續處理並設為預設」。未推送、開 PR、部署、安裝工具或修改正式答案資料。

## 適用範圍與相容性

- `create_answer`、`create_answers` 及 `start_exam` 後的建立流程省略模板時使用 `police_information_essay_166`。
- `load_exam_paper` 只載入模板時使用新預設；帶答案且省略模板時使用該答案儲存的模板。明確指定與答案不符時仍拒絕。
- 明確指定一般模板仍有效；預覽、複製、匯出不改答案模板。既有一般模板 resource URI 保持一般模板。
- 舊預設建立的同 key 重試先核對完整請求雜湊，保留原模板；不同內容與明確改模板仍拒絕。既有模板損壞及暫時性儲存錯誤仍依原 replay 路徑回報。
- 不更改 166 底圖、字級、座標、換行或格式限制。缺少、修改過或缺字的正式楷書仍明確失敗，不退回一般模板。批次任一題驗證失敗時不寫入其他題。
- `nextStep.action=done` 相容列舉與 `delivery.status=awaiting_review` 分界維持不變，未新增人工驗收寫入 API。

## 實際產物

`output/pdf/default166-reference-comparison/default166-reference-pages1-2.pdf`，212,602 bytes，SHA-256 `5fd876a42fe91e8d50898dd16580bb75a34349055fd7d20095beeda7c8520e69`。

來源是父端提供的理想 PDF 第一、二頁全文，逐段保留文字與英文周邊空格，沒有按原版面行硬切、強制分頁或新增正文標頭。文字輸入保存在 `examples/reference-comparison-1-2.json`；生成器 `scripts/default166-demo.ts` 使用隔離 FileStore、實際 MCP 工具及省略模板的新建流程，不呼叫付費 API。

教育部標準楷書 5.1 完整字型通過既有 SHA-256 校驗。新 PDF 兩頁均只含 `TW-MOE-Std-Kai` 子集字型、19pt，每頁一張原稿紙底圖；文字擷取移除空白後與來源全文完全一致。自然排版共 43 行，第一頁 22 行、第二頁 21 行；第一頁自然短尾「器。」保留。

隔離 FileStore 中實際儲存的正文亦逐字與提供文字相等，包含英文周邊空格，不只比較移除空白的 PDF 文字。

以 Poppler 120 dpi 渲染兩頁 PNG，並實際逐頁開圖查看：印刷抬頭、注意文字、記分欄及底圖保留；未見超框、缺字或行間重疊。未經 Word/LibreOffice 轉檔，未宣稱 DOCX 視覺驗收。

生成前 delivery 為 `not_ready`，匯出後為 `awaiting_review`；容量 `passed`，內容、來源、視覺 API 狀態仍皆 `not_checked`。外部看圖不會被誤稱為 API 已記錄人工驗收。

## 尚未完成的參考對照

HP 尚未取得理想 PDF bytes，也未看過其參考像素；不能宣稱像素對齊完成。新檔可供父端獨立比較。下表參考值來自父端實測，新檔值由 HP 的 pdfplumber 實測；兩邊不是本機同檔比較：

| 項目 | 父端參考值 pt | 新檔實測 pt |
| --- | --- | --- |
| A4 寬×高 | 595.304×841.890 | 595.280×841.890 |
| 底圖 x／top | 90／77.35 | 90／77.40 |
| 底圖寬×高 | 411.95×566.30 | 411.96×566.28 |
| 正文左起 | 130.4 | 130.32 |
| 首行 baseline（距頁頂） | 139.30 | 141.022 |
| 行數 | 22＋21 | 22＋21 |

首行約低 1.72pt；本輪沒有為此全局調整 166。逐行座標、字型與底圖資料在產物旁 `inspection.json`，MCP layout、完整文字與 delivery 在 `manifest.json`，兩頁圖為 `page-1.png`、`page-2.png`。

## 傳輸阻礙

目前未對新 PDF 呼叫 Library create，沒有遠端新項目或不確定寫入。自動安全審核拒絕保存本次官方 `library_file_transfer.py`：認為它含憑證讀取及認證網路下載能力，使用者尚未授權引入該安全敏感能力。父端已另外詢問本次傳輸許可；收到新授權前保持停止，不改路下載或上傳，不修改官方 helper。原理想 PDF 的舊 materialization 下載失敗也沒有重試。

## 測試原則

新增專項涵蓋新預設、明確覆寫、舊答案不變、舊 key 重試、模板資源身分、預覽沿用模板、缺字型與批次無部分寫入。MCP 契約只對兩個既有工具的精確 template default 作受約束的相容比較，其他 schema 仍嚴格核對。既有一般模板案例逐項指定一般模板，保留全部斷言，讓無私有字型的 CI 仍測其原行為；另以已校驗字型驗證真正的 166 新預設與兩頁實檔。

Node 24.19.0 下最終完整測試均為 323 項：

- 配置正式楷書：313 通過、0 失敗、10 略過，69.4 秒；紀錄 `../default166-withfont-green.tap`。
- 未配置正式楷書：297 通過、0 失敗、26 略過，61.5 秒；紀錄 `../default166-nofont-green.tap`。
- TypeScript 型別檢查、編譯與 `git diff --check` 通過。
- 未驗證 Node 20／22、Linux CI、Firestore emulator 與 Word/LibreOffice 成品轉檔；依條件略過的外部工具案例仍保留，沒有放寬斷言。正式四題答案與原講義仍未核對。
