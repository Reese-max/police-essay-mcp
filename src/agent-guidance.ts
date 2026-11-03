import { REVIEW_REASONING_INSTRUCTION, ESSAY_EXAMPLES_RESOURCE } from "./essay-instructions.js";

/** Formatting tools state the 165 paper limits up front so the model explains them instead of retrying. */
export const PAPER_FORMAT_NOTE = " The 165 original-paper template (police_information_essay_165) accepts only left-aligned text without bold or italic; tell the user so instead of attempting that formatting.";
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  create_answer: "Create an editable answer. examId resumes existing planned questions; use idempotencyKey for retries.",
  write_answer: "Replace all sections; expectedVersion protects edits. Prefer edit_text for phrases.",
  replace_text: "Replace one section's text or paragraphs, preserving other sections.",
  format_section: "Change section/paragraph formatting without rewriting content.",
  insert_text: "Insert a section after afterSectionId, or append when omitted.",
  delete_text: "Delete one section; preview_change can preview first.",
  render_answer_sheet: "Show one answer canvas with authoritative layout and editing controls.",
  check_layout: "Read exact line usage, overflow, targets and quality warnings (not content verification).",
  read_answer: "Read the complete answer and rendered lines; no canvas.",
  load_exam_paper: "Load template geometry and formatting rules.",
  list_templates: "List available answer-sheet templates.",
  list_answers: "List saved answers grouped by exam, ordered by question number.",
  update_answer_info: "Edit title, exam, question number, question or layout options.",
  duplicate_answer: "Copy content, formatting and targets into an independent version-1 answer.",
  export_answer: "Export pinned answers as Word and PDF by default; TXT is also available.",
  export_exam_bundle: "Export all planned questions via examId or ordered pinned answers as PDF and Word by default; all-or-nothing. Give both links without asking to export.",
  move_section: "Move a section before or after another section.",
  renumber_items: "Renumber written heading/paragraph numbers by hierarchy.",
  set_line_targets: "Set section line targets for check_layout; targets include headings and spacing.",
  preview_change: "Preview a write operation with its arguments; saves nothing.",
  edit_text: "Replace matching phrases; select occurrence or all matches, optionally within a section.",
  list_revisions: "Read recent committed versions and change summaries.",
  restore_revision: "Restore historical content as a new version, guarded by expectedVersion.",
  delete_answer: "Explicit permanent deletion only: removes answer, revisions, export files and exam bundles containing it; requires expectedVersion.",
};
export const PAPER_FORMAT_INSTRUCTION = "165 原稿紙模板（police_information_essay_165）只接受靠左、非粗體、非斜體的標準楷書；使用者要求粗體、斜體、置中、靠右或分散對齊時，直接說明不支援，不要嘗試寫入。舊代碼 police_information_essay_166 保留為相容別名；既有答案沿用儲存的代碼，不遷移，兩者版面相同，顯示名稱均為「165 原稿紙・兩頁申論」。";
export const REVIEW_INSTRUCTION = REVIEW_REASONING_INSTRUCTION;

export const EDIT_INSTRUCTION = "多題最短流程：start_exam → create_answers(examId) → 修正版面 → render_exam_overview(examId) → export_exam_bundle(examId)。使用者說繼續或前次中斷，先呼叫 get_exam_progress（不知 examId 時省略），依 nextStep 接續，將 summary 告知使用者一次；不要重做已完成題目或逐步旁白。fits 僅代表容量符合，絕不可稱答案已查證。匯出成功只代表檔案產出；get_exam_progress 的 done 保留為匯出流程終點，delivery.status=awaiting_review 表示內容、來源與逐頁視覺驗收待完成，不可稱成品已驗收或因此重複匯出。新答案預設整字換行、標題不落頁尾（layoutOptions）；舊答案可用 update_answer_info 開啟，補入的空白行計入行數與容量。單題用 create_answer 一次帶 exam、questionNo、lineTargets（sectionId 必須等於 sections 明確提供的 id）；重試使用相同 idempotencyKey 與請求，重送回傳目前版本，不同請求會拒絕。多題用 create_answers（1–10 題），全部驗證才開始儲存，逐題給不同 key；中途失敗依錯誤列出的已建立項目處理。只修改需要變更的內容。寫入預設回傳摘要，完整文字用 read_answer 或 responseDetail=full。read_answer 只回傳資料，不顯示畫板；單題畫板用 render_answer_sheet；多題只呼叫一次 render_exam_overview，以分頁切換，不要逐題開畫板。修改字句用 edit_text，只送 find/replace；整段改寫用 replace_text，整份重寫才用 write_answer；只改格式用 format_section。修改時帶 expectedVersion，可先用 preview_change 預覽，套用後回報變更清單。check_layout 檢查行數、目標與品質 warnings（僅提醒、不阻擋匯出）；單題用 export_answer(expectedVersion)，多題版面皆通過後必須呼叫一次 export_exam_bundle(examId)，預設輸出 PDF 與 Word；同一則訊息直接提供兩個下載連結，不要詢問是否匯出。可逐題指定 expectedVersion。合輯隨任一成員答案刪除；handle 建立失敗會回收先前 handle，回收失敗會列出遺留 handle。搬移用 move_section，編號不連續用 renumber_items；調整各節目標用 set_line_targets。list_revisions 查歷史，restore_revision 另存還原版本。update_answer_info 修改考試／題號等資訊，duplicate_answer 複製試寫。";

export const SERVER_INSTRUCTIONS = "新建答案及全卷建立省略 templateId 時使用 police_information_essay_165；須配置已校驗教育部標準楷書，字型缺少時明確失敗。明確選其他模板及既有答案沿用原模板。這是一個固定版面國考申論答題紙 MCP。多題先呼叫 start_exam；單題先呼叫 load_exam_paper 或 create_answer；所有答案都必須透過版面引擎計算行數。使用者要求觀看、建立後顯示或編輯時，單題呼叫 render_answer_sheet；多題只呼叫一次 render_exam_overview 顯示同一畫板的題目分頁。修改後呼叫 check_layout，只有 fits=true 才可視為符合兩頁限制。" + EDIT_INSTRUCTION + PAPER_FORMAT_INSTRUCTION + REVIEW_INSTRUCTION;

export const WORKFLOW_RESOURCE_LINES = [
  "# 申論答題紙工作流程",
  "1. create_answer 一次帶 exam、questionNo、lineTargets 與 sections；lineTargets.sectionId 必須等於 sections 明確提供的 id，在版本 1 儲存；load_exam_paper 可先查看模板。省略 templateId 時新建答案使用 police_information_essay_165；明確選其他模板及既有答案沿用原模板。" + PAPER_FORMAT_INSTRUCTION,
  "建立重試帶相同 idempotencyKey 與請求；不同請求不可共用 key。create_answers 一次 1–10 題，全數驗證後逐題儲存，每題使用不同 key；部分儲存失敗會列出已建立項目。",
  "2. 只修改需要變更的文字：edit_text 改字句，replace_text 整段改寫，write_answer 整份重寫；format_section 只改格式。修改帶 expectedVersion，可先用 preview_change 預覽。",
  "3. 寫入預設回傳摘要；完整文字用 read_answer，或寫入時指定 responseDetail=full。read_answer 只回傳資料，不顯示畫板；單題畫板用 render_answer_sheet；多題只呼叫一次 render_exam_overview，以分頁切換，不要逐題開畫板。",
  "4. check_layout 查看真實行數、目標差距與 warnings；新答案預設避免英文斷字與標題落頁尾；舊答案可用 update_answer_info.layoutOptions 開啟，補入空白行計入行數與容量。warnings 僅提醒、不阻擋匯出。超出容量時依 compressionHints 修改，再重新檢查。",
  "5. 單題用 export_answer 並帶 expectedVersion；多題用 export_exam_bundle，逐題釘選 expectedVersion，按指定順序合成 PDF 與 Word。只有 fits=true 才可正常匯出；165 原稿紙不允許超頁。全部題目通過後直接匯出，同一則訊息提供兩個下載連結，不要詢問是否匯出。",
  "TXT 的 textMode 預設 paper，paragraphs 去除視覺換行、保留編號並以 _段落.txt 命名；pages 仍計算稿紙頁數。合輯隨任一成員答案刪除；handle 失敗會回收先前 handle，回收失敗會列出遺留 handle。",
  "6. move_section 搬移；renumber_items 修正不連續編號；set_line_targets 調整各節目標；update_answer_info 修改答案資訊；duplicate_answer 複製試寫。",
  REVIEW_INSTRUCTION,
  ESSAY_EXAMPLES_RESOURCE,
  "7. list_revisions 查歷史，restore_revision 另存新版本還原；只有使用者明確要求永久刪除時才用 delete_answer，並帶目前 expectedVersion。",

];
