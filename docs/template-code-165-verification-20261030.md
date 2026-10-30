# 165 原稿紙代碼改名驗證

> 第一輪歷史紀錄：本輪後另發現舊 ID 的顯示名稱仍為 166，已於第二輪修正為 165。下列「舊模板完整保留」及其 SHA 僅描述第一輪；目前狀態見 [第二輪名稱核對](template-name-165-audit-20261030.md)。

2026-10-30 從 GitHub 讀取最新 `main`，實際版本為 `92911d3475e80650536d753adc1c4e86bc9337b8`；完成前再次查詢遠端，版本相同。本次只在隔離目錄處理 police-essay-mcp，未修改 autodev-ng。

## 變更

- 新建單題、批次、全卷答案及純模板載入的 canonical 預設為 `police_information_essay_165`，名稱為「165 原稿紙・兩頁申論」。同步更新 MCP 運作指示、工具說明、錯誤標籤、啟動與 readiness 的模板選擇。
- `police_information_essay_166.json` 完整保留，作為舊代碼的相容模板；明確指定仍可使用。既有答案、版本、冪等請求及複製仍使用原來儲存的代碼，沒有資料遷移。
- 165 與 166 模板除了 `id`、`name` 外逐欄深度比對完全相同，繼續共用內部 `original_166` profile 與既有資產。歷史 QA 腳本檔名保留；default166-demo 的新建預設斷言更新為 165。

## 驗證結果

- `npm run check`：通過。
- `npm run build`：通過。
- 完整 `npm test`：349 項，329 通過、0 失敗、20 略過。
- 測試使用 `MCP_CONTRACT_BASE_PATH=/workspace/police-essay-contract-base`（實際 pinned base `18cb1760160d2849039277c13546f168a0956329`）與 `REVIEW_RELEASED_SOURCE=/workspace/police-essay-released-source`（`a3792bb`），合約來源重建及實際已發布 codec 相容性均通過。兩個 checkout 的 source 都未修改。
- Docker 實際打包排除測試通過。預設 buildx cache 位於唯讀 home，首次失敗後僅以 `BUILDX_CONFIG=/tmp/police-essay-buildx` 指定可寫 cache 重跑；沒有改變 Docker credentials、DOCKER_CONFIG 或網路設定。
- 新增不需字型的測試覆蓋 165 名稱與預設、166 明確選用、批次／全卷覆寫、舊答案讀取／重排／複製、舊 166 冪等重試與請求衝突，並比對舊答案原檔及 revision 不變。
- 新增有核准字型時執行的相同內容回歸測試，比對自然換行、44 行／兩頁、SVG、DOCX document/header/styles XML 與 PDF 全部文字繪製座標。此環境沒有核准 MOE 字型，該測試本次略過。
- 其餘略過為既有字型測試及未設定 `FIRESTORE_EMULATOR_HOST` 的真實 emulator 測試；未連線雲端資料庫。

## 版面不變的來源證據

以下檔案與上述最新 main 的 committed bytes 完全相同（SHA-256）：

| 檔案 | SHA-256 |
| --- | --- |
| `assets/paper_166.asset.json` | `d76a71e5c5d9fba4877a285e43abaa1fd06325ebef755fcde72f5081e779ba75` |
| `templates/police_information_essay.json` | `c6c94da9471fa65aa1867b25b655aec9f698a450e869cd368c6b1f96f3308cc5` |
| `templates/police_information_essay_166.json` | `8c2b3db854974fe19794aebe5d0eba2a4c359e9339806942fe3d2bf59c9a9b29` |
| `src/domain.ts` | `8eee764e95ebf4d862a0a15e6dfeeb8b252f71d094d3b247d3e116253f436861` |
| `src/layout.ts` | `7f965b90e3cb14eeaab6193882a689d971003854a5e8f79570622e4c17289c5c` |
| `src/metrics.ts` | `b2b78caed49e2153b21770da0e6177ad30d06549dbe0c4928b455ac83d2b74f5` |
| `src/font-subset.ts` | `0d2634f7c0abb9f9ead1a82bd67d96be030015c873e91a22939b2d978b1c9eaf` |

`src/original-paper.ts` 與 `src/exporters.ts` 將新標籤文字 `165` 換回 `166` 後，與原 main 全文完全相同；沒有改變幾何、字距、baseline、換行或匯出演算法。核准字型 SHA、字型名稱與底圖內容均未改。

## 限制

本次沒有核准字型、Word／LibreOffice 或實際 MCP 宿主視覺環境，因此未實際重新渲染原稿紙 PDF／SVG、未做 Word 轉 PDF 或逐頁目視驗收。來源不變及模板設定一致的檢查通過，不代表此次已完成視覺驗收。沒有安裝或重試過往被拒絕的 Word／OS 操作，沒有 push、merge、部署、建立 credentials／IAM 或付費呼叫。
