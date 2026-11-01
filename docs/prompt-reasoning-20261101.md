# 生成、壓縮與複查指令

這次只修改呼叫端取得的提示詞與教學示例，不增加LLM、模型費用、來源抓取或評分功能。版面、模板、165預設、166別名及儲存格式不變。

## 呼叫入口

- `prompts/get`，name=`draft_answer`，arguments=`{question, scoringPoints?}`：逐小問與動詞拆題，依五種題型選擇論證路徑，重要論點有主張、機制或依據與題意應用，必要時作限制判斷。這些要素不是每段固定四句，也不強迫加入案例。
- `prompts/get`，name=`compress_answer`，arguments=`{answerId, overflowLines?}`：先取得全文與版本，先補漏答再刪套話重複；保留必要要件、對照維度、推理與語義。每次修改後重新檢查，不以fits作內容通過。
- 初始化instructions及既有`essay://instructions/workflow`沿用REVIEW_INSTRUCTION，新增題意與論證複查、版本新鮮度及未自動查證界線。
- `resources/read`，uri=`essay://instructions/workflow`：原工作流程末尾可讀取「五題型教學示例」，含六個同題比較案例。沒有新增resource或tool介面，既有權限與參數保持。

六案例包括解釋、比較、原因、對策評析、案例與雙小問壓縮。示例是自製教學材料，非官方高分範文、非真正模型生成或實測成績。材料中沒有外部法條、研究或統計。沒有配分的案例保持未知；雙小問案例明確3+2=5。

## 複查界線

先完成必要論證才壓縮；修改後舊review仍依原機制stale。呼叫端須實際重核再以最新expectedVersion保存證據，不能只刷新版本或複製舊checked。來源未查或成品未看不能補checked。`semantic`、`sourceVerification`維持not_checked；mapped、fits、freshness=current與review_recorded均不代表語義正確、已核來源或保證得分。

## 比較與重現

`scripts/prepare-prompt-comparison.mjs <existing-typescript-package> <output-directory>`只讀取指定既有TypeScript runtime，從基準commit取得舊提示詞，輸出六組同題、同材料、同篇幅預算的新舊prompt。它不呼叫模型，也不是新server的prompts/get執行證據。

比較時另需控制同一模型、採樣參數、來源存取與修改次數。逐項盲查必要小問、論證機制、比較成對、原因對策對應、案例涵攝、來源標記、語義保留及行數。不要用關鍵字覆蓋率取代語義評閱，沒有實際模型執行與評閱就不報提升分數。

`tests/essay-prompts.test.ts`已準備真InMemory MCP initialize、prompts/get、resources/read與165/166的44行及45行溢出回歸；現有paper-code-compatibility測試另涵蓋PDF座標與DOCX幾何。它們需要完整測試依賴及官方楷書。本輪執行限制與已驗結果請看工作區外的verification-report.md，不能把尚未執行的測試當成通過。
