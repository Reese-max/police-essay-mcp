import { REVIEW_REASONING_INSTRUCTION, ESSAY_EXAMPLES_RESOURCE } from "./essay-instructions.js";

/** Formatting tools state the 165 paper limits up front so the model explains them instead of retrying. */
export const PAPER_FORMAT_NOTE = " The 165 original-paper template (police_information_essay_165) accepts only left-aligned text without bold or italic; tell the user so instead of attempting that formatting.";
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  create_answer: "Create an editable answer. Omit templateId for the default 165 paper; pass one only when the user picks a paper. Indent values are display-width units: one full-width cell is 2, so a 2-cell first-line indent is firstLineIndent 4. Preserve supplied drafts; include explicit section IDs, matching lineTargets in version 1 and known exam/questionNo. Allocate targets from the user's budget or template capacity, not current usage; do not expand drafts to meet targets. examId resumes existing planned questions; retry with the same idempotencyKey and identical request.",
  write_answer: "Replace all sections at expectedVersion only for a whole-answer rewrite or explicitly requested content clearing; include every section that must remain. Prefer edit_text or replace_text for targeted edits and compression. Keep section IDs, headings, numbering, order, each question's block and distinct substantive points; merge only verbatim-identical or same-point restatements.",
  replace_text: "Replace one section's text or paragraphs at expectedVersion; omit heading to keep it (a new heading replaces it, null removes it); other sections stay untouched. During compression retain headings, numbered subheadings and distinct substantive points; do not replace multiple sections with one summary.",
  format_section: "Change section/paragraph formatting without rewriting content; use expectedVersion. Indent values are display-width units: one full-width cell is 2, so a 2-cell first-line indent is firstLineIndent 4.",
  insert_text: "Insert a section after afterSectionId, or append when omitted; use expectedVersion.",
  delete_text: "Delete one section only when its removal is explicitly requested or authorized; compression alone is not permission to remove sections. preview_change can preview first.",
  render_answer_sheet: "Show one answer canvas with authoritative layout and editing controls; the client renders it, so the default result's line usage and status suffice — omit responseDetail=full unless per-line data is needed. For multiple questions use one render_exam_overview instead.",
  check_layout: "Read authoritative line usage, overflow, targets and quality warnings, not content verification. For fit/export tasks call for EVERY answer before compression and again after its last edit, including answers that batch or overview tools report as fitting. Reuse checks for unchanged versions. Report planned targets separately from actual usage.",
  read_answer: "Read the complete answer, section IDs, current version and rendered lines; no canvas. Before compression obtain the full original, not just a layout summary; reuse full text already available.",
  load_exam_paper: "Load template geometry and formatting rules. Before allocating proportional line targets, load the suitable known/default template if its capacity is not already available; no preceding list_templates is needed. Layout summaries are not full original text or substitutes for per-answer check_layout.",
  list_templates: "List templates only when choosing a non-default paper (ids are paper specs, not subject tags); omitting templateId selects the 165 original paper.",
  list_answers: "Find saved answers grouped by exam and ordered by question number. Reuse a known answerId instead of listing again.",
  update_answer_info: "Edit title, exam, question number, question or layout options at expectedVersion.",
  duplicate_answer: "Copy content, formatting and targets into an independent version-1 answer; do not duplicate merely to edit the original.",
  export_answer: "Export pinned answers as Word and PDF by default; TXT is also available. First check_layout at the final version; pin that checked version and provide both returned download links without another confirmation.",
  export_exam_bundle: "Export all planned questions via examId or ordered pinned answers as PDF and Word by default; all-or-nothing. First check_layout for every answer at its final version. Export once after all fit; give both links without asking to export.",
  move_section: "Move a section before or after another section at expectedVersion. If renumbering is requested, call renumber_items next with the returned version; do not rewrite content or reread known IDs.",
  renumber_items: "Renumber written heading/paragraph numbers by hierarchy without rewriting their substance.",
  set_line_targets: "Set existing sections' line budgets at expectedVersion; include headings and spacing. For proportional allocation, use the user's total budget or available sheet capacity, distribute positive integer targets by content weight, and reconcile rounding so their sum equals that budget. Targets are not current usage and do not add text or remove overflow. Prefer initial targets in create_answer/create_answers.",
  preview_change: "Preview a write operation with its arguments; saves nothing. Use when useful, not as a mandatory extra call for every edit.",
  edit_text: "Replace matching phrases at expectedVersion; send find/replace, selecting an occurrence or all matches and optionally a section. Preserve unrelated text.",
  list_revisions: "Read recent committed versions and change summaries.",
  restore_revision: "Restore historical content as a new version, guarded by expectedVersion.",
  delete_answer: "Explicit permanent deletion only: removes answer, revisions, export files and exam bundles containing it; requires expectedVersion. Vague wording (「這題不要了」「刪掉」) is not explicit — confirm first, naming the answer and that removal is irreversible; if the user only means to skip the question, leave it saved and make no writes.",
};
export const PAPER_FORMAT_INSTRUCTION = "165 原稿紙模板（police_information_essay_165）只接受靠左、非粗體、非斜體的標準楷書；使用者要求粗體、斜體、置中、靠右或分散對齊時，直接說明不支援，不要嘗試寫入。舊代碼 police_information_essay_166 保留為相容別名；既有答案沿用儲存的代碼，不遷移，兩者版面相同，顯示名稱均為「165 原稿紙・兩頁申論」。";
export const REVIEW_INSTRUCTION = "使用者要求確認或審核答案內容時，先取得答案全文並實際核對（既有回傳未含全文時呼叫 read_answer），再依下列原則以 set_answer_review 保存判斷、呼叫 review_answer 確認 freshness 與 pending 後一次簡要回報；不可只在對話中回覆「已確認」而不留核對紀錄。" + REVIEW_REASONING_INSTRUCTION;

export const EDIT_INSTRUCTION = [
  "依任務選流程：新建多題先 start_exam，保留 examId 供建立、進度、總覽及合輯匯出使用；續做或前次中斷先 get_exam_progress（不知 examId 時省略），依 nextStep 接續，只回報 summary 一次，不重做已完成題目、不逐步旁白。既有答案沿用已知 answerId；未知才 list_answers 一次。",
  "完整草稿入紙保留全部節、標題、順序與原文。要求依內容比例配置行數目標時，容量未知先 load_exam_paper，已有適用模板不先 list_templates。總預算依使用者明訂行數，未指定則用該題整份答題紙容量，僅扣除引擎確認不屬各節的固定占行。依各節文字量與論點份量分配含標題及段距的正整數目標，依餘數補齊取整差額，合計等於可分配預算。目標是作答額度，不是短稿目前使用行數；不為達標擴寫、加空白或改動原稿。",
  "自行撰寫答案時先估篇幅：165 原稿紙兩頁 44 行實測約 650–700 字（含標題、縮排與懸掛），初稿控制在此範圍；建立後若超頁就精簡到 fits 再回報，原稿保留限制只適用使用者提供的草稿，不因自己寫的論點而停在超頁。",
  "自行撰寫答案時分層成節：每個大點（壹、或一、）各成一節，編號與標題放 heading，不寫成段落文字；其下小點（一）、1. 各自成段，不把多個編號項併在同一段；同層用同一編號家族並連號，逐層往下（壹、→一、→（一）→1.→（1）），不跳層。新答案編號段續行由引擎自動懸掛對齊內文，勿自行設定 hangingIndent，layoutOptions 保留預設勿關閉；懸掛比頂格多佔行，配置與壓縮時預留。check_layout notes 列出「結構提醒」時，依提示就地修正（replace_text／write_answer／update_answer_info）並再查，不改動實質內容。",
  "單題用 create_answer 一次帶明確 id 的 sections、匹配的 lineTargets 及已知 exam、questionNo，不臆造缺少的資訊；lineTargets.sectionId 必須等於 section id，目標在版本 1 儲存，不另加設目標的寫入。多題用 create_answers(examId)，每批 1–10 題，全部驗證才開始儲存，每題不同 idempotencyKey。重試使用相同 key 與完全相同請求，重送回傳目前版本，不同請求會拒絕；部分失敗依錯誤列出的已建立項目接續，不重建。",
  "多題合版／匯出流程：start_exam → create_answers(examId) → 每題 check_layout → 只修超頁題 → 對修過的題目再 check_layout → 一次 render_exam_overview(examId) → 一次 export_exam_bundle(examId)。兩頁／容量／匯出任務每題都要實際呼叫 check_layout，包含短題或批次及 overview 已顯示 fits 的題目；建立、寫入、模板及 overview 摘要不能取代逐題檢查。未變更且已檢查的版本不重查。",
  "壓縮既有答案前，先掌握完整原文與目前版本：已有完整 sections 可沿用，只有摘要則 read_answer；寫入前先 check_layout，確認實際超出行數及 compressionHints。記下原有節 id、標題、順序、段內編號小節、各節獨立論點及使用者指定重點，作為保留清單。不能沒讀原文就判斷內容重複。",
  "壓縮以消除超出行數為目標：依 compressionHints 選最少必要節，先合併逐字相同或同一論點的重述、精簡措辭，保留各節 id、標題、順序、題目區塊及實質內容。不把多節合併成單節、不只留下空標題、不用一句概括而遺失獨立論點；壓縮不等於授權 delete_text 刪節。未授權不得捨棄獨立論點；保留要求與容量無法兼顧時先說明取捨，不悄悄刪除。",
  "只修改需要變更的內容：字句用 edit_text，只送 find/replace；整段用 replace_text；整份重寫或使用者明確要求清掉舊內容改寫用 write_answer，必須包含所有應留下的 sections（清掉內容不等於刪除答案）；只改格式用 format_section。以回傳 sections 的標題與順序對應使用者所指的第幾節再取 sectionId，不猜 id；已知 id、版本與所需內容就直接操作，不額外重讀或整份重寫。使用者給定替換文字照錄原文含標點，不代為增刪潤飾；「一、」類節次編號只出現一處：text 已含編號時勿再設 heading，改以 heading 編號時 text 內勿重寫；標題與編號為獨立欄位，不併入段落文字。",
  "修改帶目前 expectedVersion；連續修改沿用前次工具回傳的最新版本，不猜版本或沿用舊版。版本衝突先重讀受影響答案再套用最小差異，不盲目重送覆寫。preview_change 可在有疑慮時預覽，不強制每次呼叫；套用後回報變更清單。搬移用 move_section；若需重編號再呼叫 renumber_items，帶搬移回傳版本，不額外重讀已知 id 或重寫內容。",
  "壓縮每次寫入後依回傳版面決定是否續修，fits 即停止刪減，不為寫滿而擴寫。修改期間不必每個小改動都額外 check_layout；停止修改後對最終版本再查。以原文保留清單及工具變更摘要核對節數、標題、獨立論點與指定重點；摘要不足才 read_answer。稱其餘部分不變前，確認變更清單只列目標節。若精確局部替換造成超頁，告知使用者，不擅自改動其他原文。",
  "寫入預設回傳摘要，完整文字用 read_answer 或 responseDetail=full。read_answer 只回傳資料、不顯示畫板；使用者要求觀看、建立後顯示或編輯時，單題用 render_answer_sheet，多題只呼叫一次 render_exam_overview，以分頁切換，不逐題開畫板。",
  "配置回報分列各節目標行數與 check_layout 實際行數、總使用／容量及溢出狀態；低於目標只代表餘裕，不必補文。新答案預設整字換行、標題不落頁尾（layoutOptions）；舊答案可用 update_answer_info 開啟，補入空白行計入行數與容量。check_layout 的品質 warnings 僅提醒、不阻擋匯出；只有最終版本 fits=true 才符合兩頁限制，不能因此聲稱內容完整或已查證。",
  "建立完成或要求匯出時，單題用 export_answer(expectedVersion)；多題每題最終版本 check_layout 都 fits=true 後，呼叫一次 export_exam_bundle(examId)，可逐題釘選最新已檢查 expectedVersion，依指定題序輸出 PDF 與 Word，不逐題另行匯出。同一則訊息直接提供工具回傳的兩個下載連結，不詢問是否匯出。兩頁任務不得用 allowOverflow 規避限制；165 原稿紙及其 166 相容別名皆不允許超頁。",
  "匯出成功只代表檔案產出；get_exam_progress 的 done 保留為匯出流程終點，delivery.status=awaiting_review 表示內容、來源與逐頁視覺驗收待完成，不可稱成品已驗收或因此重複匯出。",
  "TXT 的 textMode 預設 paper；paragraphs 去除視覺換行、保留編號並以 _段落.txt 命名；pages 仍計算稿紙頁數。合輯隨任一成員答案刪除；handle 建立失敗會回收先前 handle，回收失敗會列出遺留 handle。",
  "既有答案各節目標用 set_line_targets；改目標不增加文字、不消除超頁，初始目標優先在建立時帶入。update_answer_info 修改考試／題號等資訊；duplicate_answer 複製試寫，不為編輯原答案而複製。list_revisions 查歷史，restore_revision 另存新版本還原。",
  "只有使用者明確要求永久刪除才用 delete_answer，並帶目前 expectedVersion 與 userRequest（使用者要求刪除的原話）；不為重寫或壓縮而刪除重建。「這題不要了／取消／刪掉」等未明言永久的說法不算授權，先停止處理並保留答案；若意圖刪除，先口頭確認要刪的答案，說明會連同修訂、匯出檔案及包含它的合輯一併移除且不可復原，確認後才呼叫；只是不想作答則保留答案、不寫入。",
].join("\n");

export const SERVER_INSTRUCTIONS = "新建答案及全卷建立省略 templateId 時使用 police_information_essay_165（38欄、兩頁各22行、19pt 教育部標準楷書、超頁拒絕）；須配置已校驗教育部標準楷書，字型缺少時明確失敗。只有使用者明確指定其他紙張才傳 templateId，紙張在建立時即固定，未指定時也不必先呼叫 list_templates；既有答案沿用原模板。templateId 是紙張規格不是題材分類：police_information_essay（無 _165 後綴）是42欄14pt、標題粗體、超頁壓縮的另一種練習格紙，行容量同為44行但非同一版型；題目涉及警察資訊不代表選它，行數符合也不代表選對。建立後以回傳的 templateId 核對版型再匯出（需要欄數時以 load_exam_paper 查詢）。這是一個固定版面國考申論答題紙 MCP。單題先呼叫 load_exam_paper 或 create_answer；所有答案都必須透過版面引擎計算行數。" + EDIT_INSTRUCTION + PAPER_FORMAT_INSTRUCTION + REVIEW_INSTRUCTION;

export const WORKFLOW_RESOURCE_LINES = [
  "# 申論答題紙工作流程",
  "省略 templateId 時新建答案使用 police_information_essay_165；僅使用者明確指定其他紙張才傳 templateId，既有答案沿用原模板。police_information_essay（無後綴）是 42 欄練習格紙、標題粗體、行容量同為44行，非 165 原稿紙，勿依題材挑名稱相近者。建立後核對回傳 templateId，再依流程匯出。",
  PAPER_FORMAT_INSTRUCTION,
  ...EDIT_INSTRUCTION.split("\n"),
  REVIEW_INSTRUCTION,
  ESSAY_EXAMPLES_RESOURCE,
];
