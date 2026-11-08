# 新版儲存相容性與 166 回歸驗證

> 歷史驗證紀錄：下文的 166 為當時的模板代碼或產物名稱，保留以供追溯。現行顯示名稱為 165，舊代碼僅供相容；目前狀態見 [第二輪名稱核對](template-name-165-audit-20261030.md)。

基線 `30782dd10c3c96fec7e161a100d3eb4d283e8fbe`，隔離分支 `fix/storage-compat-baselines-20261029`。本輪未推送、合併、部署、修改雲端答案、切回舊 revision，亦未變更權限、憑證或資源。

## 已重現的原因與修正

從 Git 取出 `349bdfa:src/domain.ts`，在本機直接載入其實際 schema：新版答案中的 `layoutOptions.avoidPunctuationOnlyLines` 會產生 `unrecognized_keys`，path 為 `layoutOptions`。舊 CloudStore 把 schema 失敗包成 StoreUnavailableError，符合先前線上舊 revision 回傳的「儲存暫時故障」。這輪沒有再次操作雲端來重現。

新增共用持久化 codec：將此新選項寫在頂層 `layoutExtensions`，保留舊版可接受的 nested layoutOptions；舊 schema 本來就會忽略未知頂層欄位，因此同一舊 schema 現在可讀。新版解碼時還原原有 runtime/API layoutOptions，不改公開請求或排版行為。FileStore 的主檔、歷史及列表，與 CloudStore 的 transaction、歷史及列表均使用此 codec；實際持久化大小也納入文件大小檢查。

新讀取器仍接受已存的 nested 新選項，不要求遷移；true、false、未指定均回復原值。衝突或型別錯誤會拒絕，未來未知 extension key 可略過。測試確認主檔與每個歷史 generation 都可通過舊 schema，且新讀取器仍保留設定。

這是後續寫入格式的修正，不是既有雲端資料遷移：已在線上的舊 nested 格式仍需在正常儲存時重新編碼，或另作經授權的遷移，不能宣稱線上 rollback 已全面恢復。舊版本可讀新 envelope，但若由舊版本再寫入，會略去不認識的新設定；不保證舊 writer 保留新功能 metadata，也未放寬舊版程式本身的 schema。

## 166 匯出與基線

新增實際 PDF 匯出回歸，覆蓋完整 22 行：逐行比較 PDF draw baseline 與 SVG glyph placement，確認 mixed-script 空白不被改寫；正式字型缺少時明確 skip。此測試驗證跨輸出一致性，不把兩者相同當成與理想參考相同。

修正既有 default166-demo 在乾淨工作目錄缺少 tmp/pdfs 時失敗的問題。已重新使用父端提供的參考第一、二頁全文，自然排版匯出 166 PDF，沒有重用八頁 general 合成樣本，沒有硬切參考版面行。

新產物在 `output/pdf/default166-reference-comparison/`：19pt TW-MOE-Std-Kai，兩頁各 22／21 行，正文連英文周邊空白在去除版面換行後完全一致，無 fontWarning。已以 Poppler 120dpi 重新渲染兩頁並實際逐頁看圖：原稿紙表頭與記分欄保留，未見缺字、超框或重疊。PDF SHA-256 `3eae7604aeca15f107d6369d182f0ebaac1d4eff65c97f45e616ebc91dc8d1ab`，座標與每行 baseline 在 inspection-next.json。

首 baseline 仍為 141.022pt，父端先前量測參考為 139.301pt；約 1.721pt 差異尚未修正。HP 仍未取得理想 PDF 參考像素，只有既有父端量測摘要；依前次 materialization 下載失敗且本輪禁止無新證據重試的限制，未重試或改道。完整參考每行 baseline 與像素尚未在 HP 核對，不能用單一首行偏差全局移動所有行、宣稱對齊。

Word reserve、字級、22 行上限、自然換行與 166 預設保持原狀。既有 spacing audit 已證實空白量測／PDF 皆 9.5pt，兩處較早換行來自歷史 Word compatibility reserve；本輪沒有任意移除它。

## 檢查結果與限制

- Node 24.19.0 有正式楷書：327 tests，317 pass、0 fail、10 skip；`../optimize-next-font-final.tap`。
- 未配置正式楷書：327 tests，300 pass、0 fail、27 skip；`../optimize-next-nofont-final.tap`。
- 型別檢查、build、git diff --check 通過。
- 實際舊 domain 程式的失敗／通過證據：`../old-schema-proof.json`。常態回歸測試使用相同舊 nested schema，避免 CI 依賴完整 Git 歷史。
- 本輪 Word/LibreOffice 視覺驗收未通過，也沒有宣稱執行：dependency loader 回 `Workspace dependency tools are only supported for local threads.`；文件技能要求 bundled LibreOffice，禁止以使用者桌面 LibreOffice 替代，因此未改走桌面程式或安裝工具。
- 未執行本輪 hosted CI、Node 20／22、真實 Firestore emulator 或線上 rollback。假雲端測試不能當作實際資料遷移／回退驗收。

建立 node_modules junction 被檔案系統拒絕，未成功建立連結。改以一般檔案複製現有依賴，不取得額外權限、不執行安裝；沒有其他待批准或不確定的外部寫入。
