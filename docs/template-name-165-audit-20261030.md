# 165 原稿紙第二輪名稱核對

本輪接續本機 commit `35b372b0648c0989085f1312e5850f84137f4bc4`，依使用者「再次檢查一下，連名稱也要改變」核對所有名稱。僅修改 police-essay-mcp 的隔離 checkout；未修改 autodev-ng，未 push、merge 或部署。

## 發現與修正

第一輪 canonical 模板已顯示「165 原稿紙・兩頁申論」，但明確使用舊 ID 或重開舊答案時，`police_information_essay_166.json` 的 name 仍是「166 原稿紙・兩頁申論」。這會讓 FileStore／CloudStore 的 `list_templates`、`load_exam_paper` 結構化回傳及「已載入」訊息顯示舊名稱。

現在兩個 ID 的 name 都是「165 原稿紙・兩頁申論」。保留舊 ID、原答案的 templateId、使用者題名與所有版本資料；只改模板顯示名稱，不遷移既有答案。

| 對外位置 | 第一輪狀態 | 本輪結果 |
| --- | --- | --- |
| canonical `police_information_essay_165` | 165 名稱 | 維持「165 原稿紙・兩頁申論」 |
| legacy ID 的模板 name、清單與載入訊息 | 166 名稱 | 改為「165 原稿紙・兩頁申論」 |
| 新建預設與 input schema default | 165 ID | 維持 165；批次／全卷及明確覆寫仍有效 |
| 工具描述、字型／匯出錯誤與 server workflow | 第一輪已改為 165 | 再以實際 MCP 呼叫驗證；指示補明兩個 ID 的顯示名稱均為 165 |
| schema 的 `paperProfile` | `original_166` | 保留內部相容 literal；不是對外模板名稱 |
| `.env.example`、Dockerfile 註解、驗收／部署現行文件 | 部分仍稱 166 | 更新為 165，部署歷史另作明確標記 |
| QA 腳本與新產物檔名 | default166、paper166 | 新入口 default165／paper165／verify-paper165，新檔名使用 165；舊命令檔名只保留轉接 |
| 以前的驗證報告與 proposal | 歷史 166 名稱／產物 | 保留紀錄、SHA 與引用，補歷史說明及本文件連結 |

正式匯出的下載檔名由答案 exam、questionNo、title 決定，Word／PDF 內建文件標題為一般「國考申論答題紙」，沒有硬編碼的 166 顯示標籤。使用者自填或舊答案 title 中的數字仍完整保留，沒有改寫。實際原稿紙渲染與視覺驗收的限制見下方。

## 檢查與驗證

新增三項名稱回歸測試，涵蓋 FileStore／fake CloudStore 的 get/list、實際 in-memory MCP 的清單／載入／重開舊答案、schema defaults、所有工具描述、server instructions、workflow resource，以及兩個 ID 的缺字型 create／DOCX／PDF 錯誤。全部通過；原有答案與 revision 不變測試仍通過。

- 完整 `npm test`：352 項，332 通過、0 失敗、20 略過。
- `npm run check`、`npm run build`：通過。
- pinned 舊版合約來源重建、已發布 codec 相容與實際 Docker context 敏感資料排除測試：通過。沿用第一輪的兩個唯讀 source checkout，buildx cache 使用可寫 `/tmp/police-essay-buildx`；未改 Docker credentials。
- `verify-paper165.py`、舊轉接 `verify-paper166.py`：Python 語法編譯通過，未宣稱執行實際渲染驗收。
- `assets/paper_166.asset.json`、general 模板、domain schema、layout、metrics、font-subset 仍與原 main `92911d3475e80650536d753adc1c4e86bc9337b8` 的 committed bytes 完全相同。
- 165 與舊 ID 模板除 id／name 外的設定，均與原 main 的舊模板深度比對完全相同；`src/original-paper.ts` 與 `src/exporters.ts` 把顯示標籤 165 換回 166 後，全文仍與原 main 相同。沒有改底圖、字型 hash、字型、行數、座標、baseline、Word reserve 或 Word／PDF 幾何演算法。

20 項略過包括核准 MOE 字型相關測試與未設定的 Firestore emulator。此環境仍沒有核准字型、Word／LibreOffice 或實際 MCP 宿主視覺環境，因此未重新渲染原稿紙 PDF／SVG、未做 Word 轉 PDF 或逐頁目視驗收；既有條件式幾何測試本次也略過。沒有安裝或重試過往遭拒的 Word／OS 操作，沒有新 credentials、IAM 或付費呼叫。

## 每個保留 166 的位置與理由

下表逐檔列出所有來源引用的確切行號；完整逐行文字與理由在 [retained-166-locations-20261030.json](retained-166-locations-20261030.json)。0 表示檔名本身。清單不掃描本核對文件及清單自身的說明引用、不展開不可變資產的 base64 圖像內容，亦排除 dependency integrity 字串中偶然出現的數字。其餘 124 個位置均已分類，沒有未分類的現行顯示名稱。

| 保留位置 | 行號（0 表示檔名） | 理由 |
| --- | --- | --- |
| `README.md` | 183 | 只說明舊 ID 相容、內部 profile 或不可改的歷史底圖路徑；現行名稱與預設均為 165。 |
| `SPECIFICATION.md` | 17 | 只說明舊 ID 相容、內部 profile 或不可改的歷史底圖路徑；現行名稱與預設均為 165。 |
| `assets/paper_166.asset.json` | 0 | 原始底圖資產檔名與完整內容不改，避免改變底圖或部署路徑。 |
| `docs/cloud-run-rollout.md` | 10, 20 | 只說明舊 ID 相容、內部 profile 或不可改的歷史底圖路徑；現行名稱與預設均為 165。 |
| `docs/codec-review-20261029.md` | 3, 33, 37 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `docs/default166-validation-20261029.md` | 0, 1, 3, 9, 13, 18, 20, 43, 51, 55, 56 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `docs/optimization-next-20261029.md` | 1, 3, 17, 21, 23, 27 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `docs/original-paper-workflow.md` | 3, 25 | 只說明舊 ID 相容、內部 profile 或不可改的歷史底圖路徑；現行名稱與預設均為 165。 |
| `docs/paper-baseline-calibration-20261029.md` | 1, 3, 23 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `docs/quality-e2e-20261029.md` | 3, 15, 30, 32, 82 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `docs/template-code-165-verification-20261030.md` | 3, 10, 11, 20, 30, 32, 38 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `docs/verification-answer-review-20261030.md` | 3, 29 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `proposal.md` | 3, 5, 7, 9, 11, 28, 57, 85 | 明確標註的歷史驗證紀錄；保留當時代碼、檔名、雜湊與測試結果以追溯。 |
| `scripts/check-mcp-contract.ts` | 156 | before 為 pinned 舊版合約的歷史說明；after 與實際 tools/list 已使用 165。 |
| `scripts/default166-demo.ts` | 0 | 舊命令檔名保留為轉接入口，執行 canonical 165 腳本；新 QA 輸出名稱使用 165。 |
| `scripts/paper166-smoke.ts` | 0 | 舊命令檔名保留為轉接入口，執行 canonical 165 腳本；新 QA 輸出名稱使用 165。 |
| `scripts/verify-paper165.py` | 8 | 仍讀取同一個 paper_166.asset.json 原底圖，不改資產或幾何。 |
| `scripts/verify-paper166.py` | 0 | 舊命令檔名保留為轉接入口，執行 canonical 165 腳本；新 QA 輸出名稱使用 165。 |
| `src/domain.ts` | 104 | 內部 original_166 schema literal 保留，使舊模板與工具輸出合約仍可讀。 |
| `src/original-paper.ts` | 8 | 仍讀取同一個 paper_166.asset.json 原底圖，不改資產或幾何。 |
| `src/server.ts` | 667 | 明確說明舊 ID 為相容別名，同句指定兩個 ID 的顯示名稱均為 165。 |
| `templates/police_information_essay_165.json` | 44 | 舊 ID／內部 original_166 profile 相容；兩個模板 name 均已改為 165。 |
| `templates/police_information_essay_166.json` | 0, 2, 44 | 舊 ID／內部 original_166 profile 相容；兩個模板 name 均已改為 165。 |
| `tests/cloud-storage.test.ts` | 149, 151 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/default-template.test.ts` | 14, 48, 51, 57, 86, 100, 102, 106, 124, 133, 144 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/exam-workflow.test.ts` | 177, 181, 189, 293, 294, 650, 652, 909, 912, 1014, 1017 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/fixtures/mcp-contract.json` | 5495, 5774, 15293, 18682, 18961, 28480 | 凍結的舊版 MCP 合約／內部 original_166 schema；保留基準與已發布來源可重建性。 |
| `tests/format-inheritance.test.ts` | 35, 46, 55 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/layout-options.test.ts` | 154, 156 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/layout.test.ts` | 205 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/original-paper.test.ts` | 9, 11, 17, 22, 32, 60, 68, 92, 112, 117, 128, 139, 178, 184 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/paper-baselines.test.ts` | 13, 16 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/paper-code-compatibility.test.ts` | 14, 21 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/paper-multipage-baselines.test.ts` | 13, 16 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/runtime-health.test.ts` | 126 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
| `tests/widget-tools.test.ts` | 721, 722, 725 | 使用舊 ID、舊資料或舊 SVG fixture 的向後相容回歸；不是現行模板顯示名稱。 |
