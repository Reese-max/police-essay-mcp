import { createHash } from "node:crypto";
import type { z } from "zod";
import { reviewEvidenceSchema } from "./review-schema.js";
import type { AnswerDocument, AnswerTemplate, LayoutReport } from "./domain.js";
import { planLines } from "./planning.js";

/** Bind evidence to identity, exact content, formatting and current template geometry, not keywords. */
export function reviewFingerprint(answer: AnswerDocument, template: AnswerTemplate): string {
  const { review: _review, version: _version, createdAt: _created, updatedAt: _updated,
    createRequestHash: _hash, ...content } = answer;
  const canonical = JSON.stringify({ content, template }, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
  return createHash("sha256").update(canonical).digest("hex");
}

export function reviewAnswer(answer: AnswerDocument, template: AnswerTemplate, layout: LayoutReport) {
  const record = answer.review;
  const freshness = !record ? "not_checked" : record.reviewedVersion === answer.version
    && record.fingerprint === reviewFingerprint(answer, template) ? "current" : "stale";
  const plan = record?.plan;
  const issues: Array<{ code: string; requirementId?: string; sourceId?: string; page?: number; message: string }> = [];
  const issue = (code: string, message: string, extra = {}) => issues.push({ code, message, ...extra });
  if (!plan) issue("REVIEW_NOT_CONFIGURED", "尚未建立小問、來源與驗收清單；不可視為完整。 ");
  if (freshness === "stale") issue("REVIEW_STALE", "答案版本、內容或模板已改變；請重新核對並保存紀錄。");
  const reported = (evidence: z.infer<typeof reviewEvidenceSchema> | undefined) => !evidence ? "not_checked"
    : freshness !== "current" ? "stale" : evidence.status === "rejected" ? "rejected" : "recorded";
  if (plan && reported(plan.scopeReview) !== "recorded")
    issue("SCOPE_REVIEW_PENDING", "請對照原題確認所有必要小問均已列入；軟體無法推定清單完整。");
  const counts = new Map<string, number>();
  const bodySections = new Set<string>();
  for (const line of layout.lines) {
    counts.set(line.sectionId, (counts.get(line.sectionId) ?? 0) + 1);
    if (!line.isHeading && !line.isSpacer && !line.isPadding && line.text.trim()) bodySections.add(line.sectionId);
  }
  const requirements = (plan?.requirements ?? []).map(r => {
    const sections = r.sectionIds.map(id => answer.sections.find(s => s.id === id));
    const missing = r.sectionIds.length === 0 || sections.some(s => !s);
    // Old stored documents can contain noncanonical text/paragraphs; inspect what actually renders.
    const empty = sections.some(s => s && !bodySections.has(s.id));
    const coverage = missing ? "missing" : empty ? "empty" : "mapped";
    if (r.required !== false && coverage !== "mapped") issue("REQUIRED_UNCOVERED", `${r.id} 缺少對應段落或正文。`, { requirementId: r.id });
    if (r.required !== false && reported(r.review) !== "recorded")
      issue("CONTENT_REVIEW_PENDING", `${r.id} 仍需核對具體證據、用途、概念與題意；段落對應不代表已答對。`, { requirementId: r.id });
    if (r.required !== false && !r.sourceIds?.length)
      issue("SOURCE_LINK_MISSING", `${r.id} 尚未指定核對來源。`, { requirementId: r.id });
    return { requirementId: r.id, prompt: r.prompt, required: r.required !== false, sectionIds: r.sectionIds, sourceIds: r.sourceIds ?? [],
      coverage, lines: r.sectionIds.reduce((sum, id) => sum + (counts.get(id) ?? 0), 0),
      semantic: "not_checked" as const, reportedReview: reported(r.review) };
  });
  const shared = new Map<string, string[]>();
  for (const r of plan?.requirements ?? []) for (const sectionId of r.sectionIds) {
    const ids = shared.get(sectionId) ?? []; ids.push(r.id); shared.set(sectionId, ids);
  }
  for (const [sectionId, ids] of shared) if (ids.length > 1)
    issue("SHARED_SECTION_MAPPING", `段落 ${sectionId} 同時對應 ${ids.join("、")}；行數不能重複加總，請逐小問確認實際覆蓋。`);
  const sources = (plan?.sources ?? []).map(s => {
    const status = reported(s.review);
    const linkedRequired = plan!.requirements.some(r => r.required !== false && r.sourceIds?.includes(s.id));
    if ((s.role === "required" || linkedRequired) && status !== "recorded")
      issue("SOURCE_REVIEW_PENDING", `${s.id} 來源尚未核對或已失效；locator 不是已查證證據。`, { sourceId: s.id });
    return { sourceId: s.id, role: s.role, locator: s.locator, verification: "not_checked" as const, reportedReview: status };
  });
  const points = plan?.requirements.map(r => r.points) ?? [];
  const completePoints = points.length > 0 && points.every(p => p !== undefined);
  const sum = points.reduce<number>((total, p) => total + (p ?? 0), 0);
  const scoringStatus = !plan?.scoring ? "not_checked" : plan.scoring.mode !== "additive" || !completePoints ? "pending"
    : Math.abs(sum - plan.scoring.total) > 1e-6 ? "conflict" : "consistent";
  if (plan && scoringStatus !== "consistent") issue(scoringStatus === "conflict" ? "SCORING_CONFLICT" : "SCORING_PENDING",
    scoringStatus === "conflict" ? `小問配分合計 ${sum}，題目總分 ${plan!.scoring!.total}；請核對包含關係，不可自行相加或改分。`
      : "配分未完整提供或包含關係不明；保留待核，不推算得分。");
  let scanStatus = "not_checked";
  if (plan?.scan) {
    const pages = new Map(plan.scan.pages.map(p => [p.page, p.status]));
    for (let page = 1; page <= plan.scan.expectedPages; page++) {
      const status = pages.get(page) ?? "missing";
      if (status !== "content") issue("SCAN_PAGE_PENDING", `掃描第 ${page} 頁為 ${status}，不能當作完整可讀內容。`, { page });
    }
    scanStatus = freshness === "stale" ? "stale" : issues.some(i => i.code === "SCAN_PAGE_PENDING") ? "pending" : "recorded";
  }
  const allocation = planLines(answer, layout);
  const allocationStatus = !Object.keys(answer.lineTargets ?? {}).length ? "not_checked"
    : allocation.sections.some(s => s.overTarget !== undefined && s.overTarget !== 0) ? "needs_review" : "within_targets";
  if (plan && allocationStatus === "not_checked") issue("ALLOCATION_NOT_PLANNED", "尚未設定各節行數目標；請依小問配分／重要性分配容量。");
  if (allocationStatus === "needs_review") issue("ALLOCATION_REVIEW", "各節行數偏離設定目標；請先補足必要小問，再壓縮補充說明。");
  if (!layout.fits) issue("LAYOUT_OVERFLOW", "內容超過答案紙容量。");
  if (plan && reported(plan.visualReview) !== "recorded") issue("VISUAL_REVIEW_PENDING", "尚未記錄目前版本的逐頁視覺驗收。");
  const result = { answerId: answer.id, version: answer.version, freshness,
    structuralStatus: !plan ? "not_checked" : requirements.some(r => r.required && r.coverage !== "mapped") || scoringStatus === "conflict" || !layout.fits ? "issues_found" : "no_structural_issues",
    semantic: "not_checked", sourceVerification: "not_checked", requirements, sources,
    scoring: { status: scoringStatus, ...(plan?.scoring ? { ...plan.scoring, ...(completePoints ? { itemTotal: sum } : {}) } : {}) },
    scan: { status: scanStatus }, scopeReview: reported(plan?.scopeReview), visualReview: reported(plan?.visualReview),
    allocation: { status: allocationStatus, ...allocation }, issues,
    status: !plan ? "not_checked" : issues.length ? "pending" : "review_recorded",
    summary: !plan ? "尚無驗收清單；內容、來源及逐頁視覺驗收未核對。" : `已對應 ${requirements.filter(r => r.coverage === "mapped").length}/${requirements.length} 個小問；${issues.length} 項待處理。軟體僅檢查結構，語義與來源未自動查證。`,
  };
  return result;
}
