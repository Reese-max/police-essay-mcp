import type { EssayStore } from "./storage.js";
import { isStoreNotFound } from "./storage.js";
import { layoutSections } from "./layout.js";
import { publicExportMessage } from "./export-errors.js";
import { layoutWarnings } from "./planning.js";
import { reviewAnswer } from "./review.js";

export async function examProgress(store: EssayStore, examId: string) {
  const plan = await store.getExam(examId);
  const questions = await Promise.all([...plan.questions].sort((a, b) => a.questionNo - b.questionNo).map(async q => {
    const missing = { questionNo: q.questionNo, stage: "not_started" as const, answerId: undefined, version: undefined };
    if (!q.answerId) return missing;
    let answer;
    try { answer = await store.getAnswer(q.answerId); } catch (error) { if (isStoreNotFound(error)) return missing; throw error; }
    try {
      const template = await store.getTemplate(answer.templateId);
      const layout = layoutSections(template, answer.sections, answer.layoutOptions);
      const review = reviewAnswer(answer, template, layout);
      const stage = !layout.fits || layout.overflowLines > 0 ? "drafted" as const
        : plan.lastBundle?.members.some(m => m.answerId === answer.id && m.version === answer.version) ? "exported" as const : "layout_ok" as const;
      return { questionNo: q.questionNo, stage, answerId: answer.id, version: answer.version,
        totalLines: layout.totalLines, capacity: layout.capacity, overflowLines: layout.overflowLines,
        warningCount: layoutWarnings(layout, template).length,
        review: { status: review.status, freshness: review.freshness, pendingCount: review.issues.length } };
    } catch (error) {
      return { questionNo: q.questionNo, stage: "drafted" as const, answerId: answer.id, version: answer.version,
        error: publicExportMessage(error instanceof Error ? error.message : String(error)).slice(0, 240) };
    }
  }));
  const current = questions.every(q => q.stage === "exported") && plan.lastBundle?.members.length === questions.length
    && (!plan.formats || plan.formats.every(f => plan.lastBundle?.formats.includes(f)));
  const bundle = { status: !plan.lastBundle ? "none" as const : current ? "current" as const : "outdated" as const,
    ...(plan.lastBundle ? { exportedAt: plan.lastBundle.exportedAt, pages: plan.lastBundle.pages } : {}) };
  // Export/version freshness is observable; content, source and visual approval are not recorded.
  // Keep those checks unknown even when capacity passes and all files have been exported.
  const delivery = { status: current ? "awaiting_review" as const : "not_ready" as const, checks: {
    layoutCapacity: questions.every(q => q.stage === "layout_ok" || q.stage === "exported") ? "passed" as const : "pending" as const,
    content: "not_checked" as const, source: "not_checked" as const, visual: "not_checked" as const,
  } };
  const missing = questions.find(q => q.stage === "not_started");
  const drafted = questions.find(q => q.stage === "drafted");
  const completed = questions.filter(q => q.stage === "layout_ok" || q.stage === "exported").map(q => q.questionNo);
  const doneText = completed.length ? `第${completed.join("、")}題版面已通過；` : `已辨識${questions.length}題；`;
  const exportedPages = plan.lastBundle?.pages;
  const pageCounts = plan.lastBundle?.formats.map(f => exportedPages?.[f]);
  const pageText = pageCounts?.every(n => n !== undefined) && new Set(pageCounts).size === 1 ? `${pageCounts[0]} 頁 ` : "";
  const fileText = plan.lastBundle?.formats.includes("pdf") && plan.lastBundle.formats.includes("docx") ? "PDF 與 Word"
    : plan.lastBundle?.formats.map(f => f === "docx" ? "Word" : "PDF").join("、");
  const nextStep = missing ? { action: "create_answer" as const, questionNo: missing.questionNo,
    message: `${doneText}第${missing.questionNo}題尚未建立，從第${missing.questionNo}題接續。` }
    : drafted ? { action: "fix_layout" as const, questionNo: drafted.questionNo,
      message: `${doneText}內容已保存，從第${drafted.questionNo}題接續檢查版面。` }
    : !current ? { action: "export_exam_bundle" as const,
      message: `${questions.length}題版面皆通過；${bundle.status === "outdated" ? "合輯已過期，請重新匯出" : "尚未匯出合輯"}。` }
    : { action: "done" as const, message: `合輯已匯出：${pageText}${fileText}（容量檢查通過；內容、來源與逐頁視覺驗收尚未完成）。` };
  return { examId, title: plan.title, questions, bundle, delivery, nextStep, summary: nextStep.message };
}
