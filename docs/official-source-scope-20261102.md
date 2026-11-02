# 官方來源的適用界線與本機修正

本輪依使用者指定來源調整呼叫端寫作方法，沒有自動抓取考題來源、取得官方答案或評分。以下將來源、用途與查閱限制分開，均以轉述整理，沒有把教學建議提升為普遍規定。

| 來源 | 可支持的範圍 | 不可推論與查閱狀態 |
| --- | --- | --- |
| [考選部官方PDF file_id=13407](https://wwwc.moex.gov.tw/main/controls/wHandEditorExtend_File.ashx?Fun=Menu&file_id=13407&item_id=5483&menu_id=5483) | 父端已核文字標51–53涉及審題擬綱、依配分安排時間篇幅、核心到深入及分層 | HP本輪取讀逾時，未獨立重驗PDF頁序或像素；不能稱實際頁序51–53已目視確認，也不能據此稱所有考試有固定段落或44行 |
| [高雄市立空中大學108民事訴訟法授課大綱（1）](https://www.ouk.edu.tw/FileDownload/Activities/20190314104937157607130.pdf) | 已讀文字標第3–4頁的作答策略：緊扣問題、分層，法律三段論連接規則與具體事實；涵攝不只是抄題 | 這是2019年課程教材，不是所有國考硬規則；法律三段論不同於前言本文結論；歷史法律例子不當作現行法。HP本輪只核文字，未聲稱PDF視覺驗收 |
| [FL064662 國家考試線上閱卷申論式試卷作答注意事項](https://law.exam.gov.tw/LawContent.aspx?id=FL064662) | 本輪讀到第1、2點的適用對象與第6點篇幅分配規定，頁面標示110年9月3日修正 | 線上閱卷是掃描紙本後在螢幕評閱，不能當成所有考試的作答規則；沒有普遍44行規定 |
| [FL016722 題庫建立及運用辦法](https://law.exam.gov.tw/LawContent.aspx?id=FL016722) | 本輪讀到第6條針對題庫命題附參考答案及評分標準，頁面標示112年7月13日修正 | 指命題端供閱卷參考，不代表模型取得或知道某題的官方採點；本輪不據此捏造參考答案 |

## 實作與取捨

- APPLICABILITY_INSTRUCTION區分硬規定、教學建議與工具容量；165/166才是兩頁44行，其他模板照回傳設定。
- DRAFT按每小問/動詞擬綱，依明確配分分配時間與核心篇幅，再逐層深入；前言本文結論可選，不強制每題定義分類舉例評析全部出現。
- MATERIAL_BOUNDARY_INSTRUCTION分清已知事實、合理推論、待核原因與缺資訊；不同編號不足以證明沒有共同規則，涵攝須把事實連到要件。只有相關且有依據的爭議才列不同見解。
- 共用REVIEW由單一整理後常數提供，移除server再串接舊版整段review的重複；prompts/get與比較包使用相同組裝方式。writingGuide同步更新為essay-guide-20261102.4。
- 自製案例改為逐要件對應，並明示未證實成立不等於已證實不成立；沒有抄入教材舊法例。
- 保留callerNote、版本新鮮度及semantic/source未自動核證。API、模板、字型、版面與儲存schema不變。

## 回歸與未驗

新增四個自製source-scope對照fixture及真MCP待執行回歸，覆蓋規定/建議/容量、不同編號推斷、事實涵攝及舊教材/採點誤用。knownBad是人工寫出的反例，不是本輪模型輸出；測試契約可取得不等於模型遵守。

本輪實際完成：5個變更TypeScript檔以既有唯讀TypeScript runtime做transpileModule語法檢查，error diagnostics為0；純函式驗證writingGuide版本、兩個共用邊界欄位、五題型與未自動核證旗標；讀取四個fixture；核對匯出的新draft正文等於目前DRAFT與REVIEW常數組裝、共用適用性及材料界線各一次。比較包保留六組同題新舊提示詞，modelExecuted=false、scored=false。git diff --check通過；模板、素材、layout、metrics、exporters、domain相對5251d6e沒有改動。這些不算完整typecheck、建置、測試套件或真MCP執行。

依賴安裝先前遭OS拒絕，本輪沒有Police沙箱外批准，沒有沿用其他專案授權、重試安裝或升權。完整typecheck/build/tests、真prompts/get、connector與第二輪以後內容測試仍須各自取得證據；不可把靜態或純函式檢查當通過，也沒有刪除skip或放寬語義界線。先前精確字句斷言依新共用文案更新為同一「關鍵字不能代替語義核對」契約，不是刪除該檢查。首輪負向及第二輪有限改善紀錄保留。
