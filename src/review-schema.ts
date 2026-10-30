import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const uniqueIds = z.array(id).max(100).refine(xs => new Set(xs).size === xs.length, "IDs must be unique.");
/** A caller's review record, never a claim that this server verified semantics or fetched a source. */
export const reviewEvidenceSchema = z.strictObject({
  status: z.enum(["checked", "rejected"]), method: z.enum(["human", "model"]),
  reviewer: z.string().trim().min(1).max(100), note: z.string().trim().min(1).max(2000),
  checkedAt: z.string().datetime(),
});
export const reviewPlanSchema = z.strictObject({
  requirements: z.array(z.strictObject({
    id, prompt: z.string().trim().min(1).max(1000), required: z.boolean().optional(),
    sectionIds: uniqueIds, sourceIds: uniqueIds.optional(),
    points: z.number().finite().nonnegative().max(1000).optional(),
    review: reviewEvidenceSchema.optional(),
  })).min(1).max(100),
  sources: z.array(z.strictObject({
    id, locator: z.string().trim().min(1).max(2000), role: z.enum(["required", "supplemental"]),
    review: reviewEvidenceSchema.optional(),
  })).max(100).optional(),
  scoring: z.strictObject({ total: z.number().finite().nonnegative().max(1000),
    mode: z.enum(["additive", "overlapping", "unknown"]) }).optional(),
  // A complete manifest is itself an assertion requiring comparison with the original question.
  scopeReview: reviewEvidenceSchema.optional(),
  scan: z.strictObject({ expectedPages: z.number().int().min(1).max(500),
    pages: z.array(z.strictObject({ page: z.number().int().min(1).max(500),
      status: z.enum(["content", "blank", "unreadable", "missing"]) })).max(500) }).optional(),
  visualReview: reviewEvidenceSchema.optional(),
}).superRefine((plan, ctx) => {
  for (const key of ["requirements", "sources"] as const) {
    const xs = plan[key] ?? [];
    if (new Set(xs.map(x => x.id)).size !== xs.length)
      ctx.addIssue({ code: "custom", path: [key], message: "IDs must be unique." });
  }
  const sourceIds = new Set(plan.sources?.map(s => s.id));
  plan.requirements.forEach((r, i) => r.sourceIds?.forEach(s => {
    if (!sourceIds.has(s)) ctx.addIssue({ code: "custom", path: ["requirements", i, "sourceIds"], message: `Unknown source: ${s}` });
  }));
  if (plan.scan && (new Set(plan.scan.pages.map(p => p.page)).size !== plan.scan.pages.length
    || plan.scan.pages.some(p => p.page > plan.scan!.expectedPages)))
    ctx.addIssue({ code: "custom", path: ["scan", "pages"], message: "Duplicate or out-of-range page." });
});
export type ReviewPlan = z.infer<typeof reviewPlanSchema>;
export const answerReviewSchema = z.object({
  plan: reviewPlanSchema, reviewedVersion: z.number().int().positive(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

