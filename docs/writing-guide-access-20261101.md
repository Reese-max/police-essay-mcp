# 原生工具寫作指引與可行動缺口

## 最小設計

已知原生目錄有load_exam_paper，所以沿用它：不增加工具或輸入參數，也不要求客戶端先支援prompts/resources。既有template/answer/layout保持，回應新增optional writingGuide，文字摘要也提示採用。guide含版本、限制、draft/compress/review三階段精簡指令、五題型自製示例與缺口格式；它不讀取答案內容作判斷、不寫答案、不抓來源或調模型。

載入既有答案也會回同一份靜態guide，不把範例當成本題答案。client可依自身情境讀相應stage與type，沒有新增複雜的選擇API。折衷是每次load回應較長；tools/list不增加工具或輸入schema，僅增加optional輸出欄位。完整協定與bytes budget回歸仍待實際執行。

## 呼叫端採用

1. 仍呼叫load_exam_paper；從writingGuide.stages選階段，依examples辨認題型。題目/材料/硬限制仍由呼叫者提供，不能從示例推定。
2. 真正核對原題與答案後，將缺口填為requirementId、sectionIds、quote（短原句/位置）、problem、suggestedRevision、evidenceNeeded。
3. 格式放入既有requirements[].review.note文字或JSON字串，不增加儲存schema。note最多2000字元。另依既有schema填method、reviewer、checkedAt與status；未解決缺口rejected，未查則省略證據，不能套用空白模板寫checked。
4. 用set_answer_review(expectedVersion, plan)保存。review_answer.requirements[].callerNote原樣回傳文字，judgmentSource=caller_reported，並保留對應requirementId/sectionIds與reportedReview。
5. 答案改動後freshness與reportedReview仍會stale；保留callerNote不代表舊判斷有效。實際重核後再保存。semantic/sourceVerification固定not_checked，沒有自動推論漏答、辨識語義或驗證引用。

沒有額外欄位解析器、關鍵字評分器、LLM或自動修正文句。read_answer仍可取得完整原始review。舊答案沒有review時不會憑空生成callerNote，現有寫入/匯出/版本合約不變。

## 測試狀態

新增static guide正負向/新回應不共用可變狀態測試、既有read-only工具真MCP取guide與不存在模板錯誤測試、callerNote原樣回傳/拒絕/無紀錄/stale且semantic/source不自動核證測試。這些測試已準備，因先前OS拒絕依賴安裝且尚未獲准，未跑完整套件、型別檢查或build。可執行的只讀runtime語法與pure-guide檢查須另與實際MCP驗收區分。

## 第二輪實驗紀錄

父端提供的實際第二輪結果：F4既有控制價值與F6獨立功能邊界有改善，其他題平手。F6原47行按新版compress縮為42行，語義對照未見必要論證遺失。HP沒有重跑或獨立評閱該答案；這是特定題組的結果，不能宣稱普遍高分或所有情境改善。首輪負向結果繼續保留於prompt-blind-review-round1-20261101.md。
