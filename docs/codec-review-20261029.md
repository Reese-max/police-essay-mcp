# 儲存 codec 資料完整性複核

接續基線 `5ecb0c3109330c7dcd3c4a4b12ceeee9e8f0fa9b`，仍在隔離分支。本輪沒有推送、合併、部署、存取修改雲端答案、切回舊 revision 或變更權限憑證。

## 實證缺陷與修正

補測先確認原 codec 會遺失不認識的頂層欄位及 layoutExtensions 子欄位：decode 的已知 schema 會略去它們，接著 encode 只寫出 runtime 已知欄位。本地失敗紀錄為 `../codec-review-red.tap`，4 項中 1 項失敗。

修正由儲存邊界帶入原始 persisted envelope：FileStore 在原寫入鎖內保留原始主檔，CloudStore 使用同一 transaction 已讀取的資料。只有不認識的欄位會從原 envelope 保留，已知欄位仍以本次答案為準；不因保留舊資料而復活被清除的 question 或覆蓋明確 false 設定。原始資料不就地變更。

encode 現在也驗證原 envelope 的已知欄位、拒絕不同 answer ID、缺損／衝突 metadata；未知擴充欄位保留，已知設定可明確還原為未指定。歷史版本保持原樣；從歷史還原已知答案欄位時保留目前不認識的 metadata，不能宣稱未知未來功能也支援歷史語意還原。

保留 opaque metadata 後，文件大小可能超標。CloudStore 新增合併後的 transaction 內大小檢查，超標則在任何寫入前中止；固定大小驗證錯誤可安全對外回傳，不會被誤包成暫時性 backend 故障，其他 backend 錯誤仍保留遮蔽。

測試覆蓋 FileStore／CloudStore 的 get、list、revision、已知設定還原、未知頂層與擴充欄位、輸入不變、缺損／衝突／不同 ID、超標 transaction 無部分寫入，以及舊 reader 與 writer 的差別。原 schema 與內容斷言均保留，未靠放寬限制通過。

## 唯讀預演

新增 `scripts/audit-answer-compat.ts`，只讀一個本地 JSON 並印出相容性預演，不寫回輸入檔，也不連線雲端。執行方式：

```sh
node --import tsx scripts/audit-answer-compat.ts local-fixture.json
```

本輪只對 `tmp/codec-audit-fixture.json` 合成 fixture 執行；結果在 `../codec-audit-preview.json`。原格式舊 reader 不接受，預演 envelope 可接受；runtime 答案及未知 metadata 完整。輸入 SHA-256 前後相同：`39f006809d0bc0a46acfe12513773b10027f3fc305f185f5a128b81d063d9eee`。

未修改的舊 writer 仍會刪掉 `futureMetadata`、`layoutExtensions`；新版 codec 無法改變既有舊版 binary 的寫入行為。故本修正提供新版 writer 的 metadata 完整性與舊 reader 可讀性，不能當作舊 writer 無損 round-trip，也不能修復既有雲端 nested 資料。本輪沒有遷移任何實際資料。

## 版面與環境邊界

沒有改 166 排版或 Word reserve。原工作區與 reference-ideal-pdf 中沒有找到可讀的原始 `考古題1-1星期二14-16(1).pdf`；已知目錄只有先前自己生成的比較檔，不能拿它當理想參考。沒有重試先前失敗或被拒絕的 Library 操作，沒有改道下載。

目前 bundled native 目錄只有 git、jxrlib、libheif、poppler、powershell，沒有 Office renderer；先前 dependency loader 已明確回覆只支援 local threads。依 documents SKILL.md 的「never use the user's installed desktop LibreOffice」，沒有改用桌面 LibreOffice。最小解鎖條件是正式可讀的原始參考像素，以及受支援 bundled renderer／可運作的 dependency loader；不需要放寬權限、關閉安全設定或安裝未授權工具。

本輪沒有新增參考像素或 Word 成品驗收。上一輪真正看過的是新生成的 166 比較檔兩頁；首行約低 1.72pt 尚未校準，不能宣稱已改善。既有全 22 行 PDF／SVG 基線回歸保留並隨完整測試執行。

## 最終驗證

- 有正式楷書：328 tests，318 pass、0 fail、10 skip；`../codec-review-font-green.tap`。
- 無正式楷書：328 tests，301 pass、0 fail、27 skip；`../codec-review-nofont-green.tap`。
- 相容性／假雲端專項：24 tests 全通過；`../codec-review-target4.tap`。
- TypeScript check、build 與 git diff --check 通過。沒有執行本輪 hosted CI 或線上回退／遷移。
