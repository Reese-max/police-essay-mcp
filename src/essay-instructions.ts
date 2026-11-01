/** Caller instructions only: this MCP does not run a language model or grade answers. */
export const DRAFT_INSTRUCTION = `先拆題再起草：逐一列出必要小問、指令動詞（解釋／比較／分析原因／提出並評析對策／案例適用）、指定範圍與限制，建立穩定 requirement id 對應 sectionIds；同一題可混合題型。題目有配分才按明確配分分配篇幅；沒有配分就標示未知，按任務重要性規劃，不捏造分數或把不明包含關係自行相加。
依題型選論證路徑：解釋題界定概念、構成與作用機制及邊界；比較題先定共同比較維度，逐維度對照並判斷適用條件，不能各說各話；原因題說明原因如何導致結果，區分層次、條件與推測，不能只列因素；對策評析題把每項措施連回原因，交代執行主體、做法、限制與取捨；案例題先辨識爭點、可用規範或原理與關鍵事實，再涵攝、考慮反面可能並下有條件結論。
重要論點要有可辨識的主張、依據或機制、題意應用，以及確有必要的限制或判斷；依題意選擇組合，不要每段硬套四句，也不硬塞案例。標題直接呈現論點，避免空泛的「重要性／對策」標題。先讓所有必要小問的推理完整，再依實際版面壓縮；不能為湊行數新增套話。
區分已提供且可定位的官方教材、其他材料與模型推論。沒有取得原文就標示未核實；推論須表明是推論，不能假稱官方結論。禁止捏造法條、研究、數字或來源頁碼，不自稱90分或保證高分。需要案例但沒有真實材料時，只可明標假設案例。
先讀 essay://instructions/workflow 的五題型教學示例（自製、非官方高分範文），再依本題材料推理，不照抄示例結論。使用 sections 與 lineTargets 規劃；保留165原稿紙兩頁44行及既有165/166相容介面，不改字級或版面。以 create_answer 或 write_answer 寫入後 check_layout；超出實際行數目標或44行容量時，取得 compress_answer 提示詞並依其順序處理。fits僅代表容量符合，不能稱內容通過。`;

export const COMPRESS_INSTRUCTION = `先 read_answer 取得現行版本、全文與 review，依原題逐小問核對指令動詞、範圍、配分與必要論點；先補漏答及斷裂推理，再壓縮，不先用字數刪論證。以 check_layout 的實際行數、lineTargets及compressionHints協助定位；required/priority/compressible僅是編輯線索，不能取代題意判斷。
依序刪除套話、重複前言結論、同義反覆及離題補充，再合併重複主張、縮短語句。保護必要要件與例外、比較的共同維度與對照、原因到結果的推理、原因與對策的對應及執行方式、案例事實涵攝與必要限制；不能只留下名詞、刪掉否定或條件而改變語義。沒有配分不捏造；不得只保住第一小問或為塞入44行犧牲另一小問。
每次修改帶 expectedVersion；壓縮後對照修改前後，逐一重查小問覆蓋、指令動詞、關鍵條件、推理與語義是否保留，再 check_layout。若容量與必要內容無法兼顧，明確列出缺口和取捨交由使用者判斷，不自動刪必要內容，也不縮字級、改165版面或新增湊頁廢話。fits=true仍須複查內容，不是驗收終點。
修改使舊review stale。完成本次真實核對後才以最新 expectedVersion 重存 set_answer_review，且只記錄確實做過的核對；未查來源或未看成品不能補 checked。再 review_answer 確認 freshness=current並揭露pending；semantic/sourceVerification仍為not_checked，MCP沒有自動驗證語義與來源。`;

export const REVIEW_REASONING_INSTRUCTION = `複查先回到原題，確認小問與指令動詞的清單完整，再沿各題型路徑核對論證；比較維度要成對、原因需有機制、對策需對原因且可執行、案例需有事實適用，不能以關鍵字出現或mapped當作答對。檢查重要主張是否有依據或機制與題意應用，必要時交代限制；不得要求每段四句或強加案例。區分官方教材與模型推論；沒有配分不捏造，沒有來源不假稱已核。
每次壓縮或修改後重新檢查漏答、否定與條件、推理及語義；舊review stale時，須實際重核後才以最新expectedVersion保存，不能只刷新版本或複製舊證據。freshness=current只是紀錄對應目前內容；fits與no_structural_issues都不是內容通過。semantic/sourceVerification固定not_checked，review_recorded不是自動評分，不保證高分。`;

export const ESSAY_TEACHING_CASES = [
  {id:'explanation', type:'解釋', question:'解釋資料備份的用途與限制。', material:'自製材料：備份保留可恢復副本；恢復需測試。', budgetLines:8, teachingExample:'備份提供可恢復副本。資料損毀後，可用副本回復先前狀態，因此應同時規劃保存與恢復程序。只有產生副本，尚不能證明能成功恢復；必須實測恢復。', checkpoints:['概念與機制','恢復用途','測試限制']},
  {id:'comparison', type:'比較', question:'比較預防性控制與偵測性控制。', material:'自製材料：預防控制降低事件發生可能；偵測控制發現事件跡象。', budgetLines:8, teachingExample:'兩者可依介入時點與直接目的比較。預防控制在事件前降低發生可能；偵測控制著重發現已出現的跡象，供後續處置。故兩者可互補，不能以部署其中一種就推定另一種不必要。', checkpoints:['共同維度','逐項對照','互補判斷']},
  {id:'causes', type:'原因', question:'分析缺乏責任分工如何影響事件處置。', material:'自製材料：無明確通報與核准責任時，可能等待或重複處理；不提供實證因果資料。', budgetLines:8, teachingExample:'責任不明可能拖延通報與決策。若各單位都等待他人核准，處置便可能停留在交接階段；反之，重複核准也可能耗時。這是依材料提出的機制推論，不能據此斷言所有遲延都由分工造成。', checkpoints:['原因到結果','條件與層次','推論限制']},
  {id:'measures', type:'對策評析', question:'針對責任不明造成的處置遲延，提出並評析對策。', material:'自製材料：可能原因為通報與核准責任不明；未提供成本與人力數字。', budgetLines:8, teachingExample:'以明確權責縮短等待。主管應指定通報窗口、核准責任與替代人員，並用演練確認交接是否順暢；這直接處理責任不明的原因。惟規則過細可能降低臨場彈性，須保留例外升級程序，不臆測節省多少時間。', checkpoints:['原因與措施對應','主體與執行','限制與取捨']},
  {id:'case', type:'案例', question:'甲單位已有備份檔，能否認定已完成恢復準備？', material:'假設案例、自製規則：恢復準備須確認副本可用及恢復程序可執行；僅知備份檔存在。', budgetLines:8, teachingExample:'僅有檔案不足以認定準備完成。依本題自製規則，仍須確認副本可用及程序可執行；已知事實只能證明檔案存在，未證明已測試恢復。若另有成功演練紀錄，判斷才可能改變。這是假設案例，並非法規適用結論。', checkpoints:['爭點與規則','事實涵攝','有條件結論']},
  {id:'dual_compression', type:'雙小問壓縮', question:'（一）說明備份用途（3分）。（二）說明恢復測試必要性（2分）。', material:'自製材料：副本可供恢復；檔案存在未必代表恢復成功。', budgetLines:6, teachingExample:'（一）備份保留可恢復副本，供資料損毀後回復。（二）仍須測試副本可用及恢復程序，因檔案存在不能證明能恢復。', checkpoints:['3+2=5明確可加','兩小問均保留','不刪除必要性推理']},
] as const;
export const ESSAY_EXAMPLES_RESOURCE = '## 五題型教學示例\n自製教學示例與比較題組，非官方高分範文、非模型實測生成結果；材料均為自製或明標假設，無實際評分。budgetLines為相同題目的比較預算，不改兩頁44行模板。\n```json\n'+JSON.stringify(ESSAY_TEACHING_CASES,null,2)+'\n```';
