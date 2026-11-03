/** Caller instructions only; no model, source lookup or automatic grading. */
export const COMPACT_PAPER_INSTRUCTION = `165/166稿紙新稿預設緊湊排版：不為前言、本文、結論等功能標籤另占一行；必要短標題與首句同段，例如「壹、前言：依題示情況……」。sections[].heading會獨占一行；要同列就省略heading，把標題及首句一起放sections[].text或paragraphs[].text，不在兩者間插入換行。段落只以單一換行分隔，不加空白段、首尾空行或非必要spaceBeforeLines/spaceAfterLines；長標題自然折行不是空白。小題編號及獨立論點仍須清楚，不把不同小問壓成一段。先以read_answer或render_answer_sheet取得逐行資料，配合check_layout核對空文字、isSpacer及isPadding，區分輸入空段、段距與keepHeadingWithNext跨頁補位，不能把每個短尾行當錯。只對本次新稿或明確同意的修改採用；既有答案、明確留白／獨立標題偏好與其他模板保持原設定，不自動重寫。PDF與DOCX都須依同一版答案核對，不能靠縮字級、刪論證或改格線填頁。`;
export const APPLICABILITY_INSTRUCTION = `先區分三層：本次考試與作答方式真正適用的硬性規定、教學建議、工具容量。先確認規定適用範圍，未提供就標待核；線上閱卷紙本規則不能套用所有考試。兩頁44行只是165/166模板容量，不是國考普遍規則；其他模板以回傳設定為準。前言本文結論可選，不強制每題同時定義、分類、舉例及評析。`;
export const MATERIAL_BOUNDARY_INSTRUCTION = `先列材料已知事實，再分開合理推論、待核原因與缺少資訊；不能把未記載當成不存在，也不能只因不同編號就斷言沒有共同規則。推論須指出依據與限制，不補入題目沒有的事實。涵攝要將具體事實連結要件或判斷標準，不是重抄題目；只有真正相關且有依據的爭議才列不同見解。`;
export const TASK_BOUNDARY_INSTRUCTION = `先列硬性數量、資源與範圍限制，按可獨立實施的措施或功能逐項計數；同一標題包含多項也分別計數，不得打包規避上限。改善方案要承認既有控制已能發揮的作用，再指出缺口，不因不足就否定原有紀錄或控制的有限用途。保持題示動作、對象、強度與規模，不把分類、提示或抽樣擴張成更強或全面措施；另提更強方案須明標建議及所需授權，不能當成題示事實。技術紀錄只支持可觀察事件或有依據的帳號關聯；區分帳號歸屬、設備使用與實際操作者，不保證已追到本人。`;
export const DRAFT_INSTRUCTION = `先審題擬綱：逐小問列指令動詞、範圍與限制，建立穩定requirement id對應sectionIds。依明確配分安排時間、核心篇幅與標題，先回答核心再深入、分層展開；沒有配分就標未知，不捏造或自行相加不明包含關係。
依題型選路徑，不把五種路徑全套上每題：解釋看概念與機制；比較先定共同比較維度再逐項對照；原因交代原因到結果的機制與條件；對策對應原因，交代執行主體、做法與取捨；案例辨爭點、規則與事實，再涵攝及下有條件結論。
重要主張有依據或機制、題意應用及必要限制，不每段硬套四句或硬塞案例。標題呈現論點；先完成必要論證再壓縮，不為湊行數加套話。禁止捏造法條、研究、數字、頁碼或官方採點；不自稱90分或保證高分。
以sections及lineTargets規劃，create_answer或write_answer寫入後check_layout；超出實際目標或模板容量時取得compress_answer提示詞。參考essay://instructions/workflow或load_exam_paper.writingGuide的自製示例，不照抄結論；未取得資源不可假稱已讀。`;
export const COMPRESS_INSTRUCTION = `先read_answer取得全文與版本，按原題逐小問核對；先補漏答與斷裂推理，再壓縮。check_layout、lineTargets、compressionHints及required/priority/compressible只是編輯線索，不取代題意。
依序刪除套話、重複前言結論、同義反覆與離題補充，再合併重複主張、縮句。保護必要要件、否定與例外、比較維度、推理、原因對策對應、事實涵攝及必要限制，不只留名詞或犧牲另一小問。
每次修改帶expectedVersion，對照前後重查小問、指令動詞、事實/推論界線及語義，再check_layout。不能為塞入工具容量而改字級或版面；必要內容無法兼顧時揭露缺口與取捨。fits=true不代表內容通過。
修改使review stale；實際重核後以最新expectedVersion重存set_answer_review，再review_answer確認freshness=current及pending，不複製舊checked。`;
export const REVIEW_REASONING_INSTRUCTION = `${APPLICABILITY_INSTRUCTION}
${COMPACT_PAPER_INSTRUCTION}
${MATERIAL_BOUNDARY_INSTRUCTION}
${TASK_BOUNDARY_INSTRUCTION}
依原題核對小問/動詞是否完整、標題及核心篇幅是否對題；比較成對、原因有機制、對策可執行、案例有事實要件連結。來源以sourceIds對應小問；配分只有明確可相加才設additive，包含關係不明用unknown。mapped、fits、no_structural_issues不是內容通過；不能以關鍵字出現代替語義核對。
區分已核官方材料、其他資料與模型推論；未取原文標未核，舊教材法律例不能當現法，不捏造法條或官方採點。required/supplemental來源分開，locator不等於核證；掃描逐頁標content/blank/unreadable/missing，缺頁或空白不算完整。
讀essay://schemas/review-plan，將對應requirementId、sectionIds、quote原句/位置、problem、suggestedRevision、evidenceNeeded放入既有review.note；只能保存呼叫者真正核對的判斷，無法定位標待定位。清單完整性、語義、來源與逐頁視覺須各自實際核對才記錄review。未解決用rejected，未核則省略；實際解決才checked，並記method/reviewer/checkedAt與具體note。修改後須重新核對，再以最新expectedVersion保存set_answer_review並呼叫review_answer，不只刷新版本或複製舊證據。
freshness=current只是紀錄對應現況；semantic/sourceVerification=not_checked，review_recorded不是軟體查證或評分，不保證高分。匯出前處理或揭露pending，既有done合約不變。無prompts/resources的客戶端可由load_exam_paper讀取writingGuide。`;

export const ESSAY_TEACHING_CASES = [
  {id:'explanation', type:'解釋', question:'解釋資料備份的用途與限制。', material:'自製材料：備份保留可恢復副本；恢復需測試。', budgetLines:8, teachingExample:'備份提供可恢復副本。資料損毀後，可用副本回復先前狀態，因此應同時規劃保存與恢復程序。只有產生副本，尚不能證明能成功恢復；必須實測恢復。', checkpoints:['概念與機制','恢復用途','測試限制']},
  {id:'comparison', type:'比較', question:'比較預防性控制與偵測性控制。', material:'自製材料：預防控制降低事件發生可能；偵測控制發現事件跡象。', budgetLines:8, teachingExample:'兩者可依介入時點與直接目的比較。預防控制在事件前降低發生可能；偵測控制著重發現已出現的跡象，供後續處置。故兩者可互補，不能以部署其中一種就推定另一種不必要。', checkpoints:['共同維度','逐項對照','互補判斷']},
  {id:'causes', type:'原因', question:'分析缺乏責任分工如何影響事件處置。', material:'自製材料：無明確通報與核准責任時，可能等待或重複處理；不提供實證因果資料。', budgetLines:8, teachingExample:'責任不明可能拖延通報與決策。若各單位都等待他人核准，處置便可能停留在交接階段；反之，重複核准也可能耗時。這是依材料提出的機制推論，不能據此斷言所有遲延都由分工造成。', checkpoints:['原因到結果','條件與層次','推論限制']},
  {id:'measures', type:'對策評析', question:'針對責任不明造成的處置遲延，提出並評析對策。', material:'自製材料：可能原因為通報與核准責任不明；未提供成本與人力數字。', budgetLines:8, teachingExample:'以明確權責縮短等待。主管應指定通報窗口、核准責任與替代人員，並用演練確認交接是否順暢；這直接處理責任不明的原因。惟規則過細可能降低臨場彈性，須保留例外升級程序，不臆測節省多少時間。', checkpoints:['原因與措施對應','主體與執行','限制與取捨']},
  {id:'case', type:'案例', question:'甲單位已有備份檔，能否認定已完成恢復準備？', material:'假設案例、自製規則：恢復準備須確認副本可用及恢復程序可執行；僅知備份檔存在。', budgetLines:8, teachingExample:'規則要求副本可用且程序可執行；檔案存在只對應有副本，尚不足以證明另外兩項條件。故目前不能認定準備完成，也不能反推已證明無法恢復。若有成功演練紀錄才可再判斷。這是假設案例，並非法規適用結論。', checkpoints:['爭點與規則','事實涵攝','有條件結論']},
  {id:'dual_compression', type:'雙小問壓縮', question:'（一）說明備份用途（3分）。（二）說明恢復測試必要性（2分）。', material:'自製材料：副本可供恢復；檔案存在未必代表恢復成功。', budgetLines:6, teachingExample:'（一）備份保留可恢復副本，供資料損毀後回復。（二）仍須測試副本可用及恢復程序，因檔案存在不能證明能恢復。', checkpoints:['3+2=5明確可加','兩小問均保留','不刪除必要性推理']},
] as const;
export const ESSAY_EXAMPLES_RESOURCE = '## 五題型教學示例\n自製教學示例與比較題組，非官方高分範文、非模型實測生成結果；材料均為自製或明標假設，無實際評分。budgetLines為相同題目的比較預算，不改兩頁44行模板。\n```json\n'+JSON.stringify(ESSAY_TEACHING_CASES,null,2)+'\n```';
