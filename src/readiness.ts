import type { EssayStore } from "./storage.js";
import type { AnswerTemplate } from "./domain.js";
import { validateRuntimeFont } from "./runtime-font.js";

export function createReadinessCheck(store: EssayStore, options: {
  ttlMs?: number; timeoutMs?: number; now?: () => number; fontPath?: () => string | undefined;
  requirePaperFont?: boolean;
} = {}): () => Promise<void> {
  const now = options.now ?? Date.now;
  let readyUntil = 0, templatesUntil = 0;
  let paper: AnswerTemplate | undefined;
  let templatesPending: Promise<void> | undefined;
  let pending: Promise<void> | undefined;
  return async () => {
    if (!paper || now() >= templatesUntil) {
      templatesPending ??= (async () => {
        const templates = await Promise.all([
          store.getTemplate("police_information_essay"), store.getTemplate("police_information_essay_166"),
        ]);
        if (!templates[0] || !templates[1]) throw new Error("Templates are not readable.");
        paper = templates[1];
        templatesUntil = now() + (options.ttlMs ?? 5000);
      })().finally(() => { templatesPending = undefined; });
      await templatesPending;
    }
    const fontPath = (options.fontPath ?? (() => process.env.ESSAY_MCP_PAPER_FONT))();
    if (options.requirePaperFont ?? process.env.REQUIRE_PAPER_FONT === "true") {
      if (!fontPath) throw new Error("166 font is missing.");
    }
    if (fontPath) await validateRuntimeFont(paper!, fontPath);
    if (!store.checkReadiness || now() < readyUntil) return;
    // Keep the actual probe single-flight after a caller times out.
    pending ??= store.checkReadiness().then(() => {
      readyUntil = now() + (options.ttlMs ?? 5000);
    }).finally(() => { pending = undefined; });
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([pending, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Storage readiness timed out.")), options.timeoutMs ?? 3000);
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  };
}

/**
 * google-gax can leave a floating promise that rejects when credentials cannot be loaded; Node would then
 * terminate the whole instance (dropping in-flight requests) instead of /readyz answering 503. Only rejections
 * whose stack is inside the Google auth/gRPC client are contained; every other unhandled rejection stays fatal.
 */
export function isCloudSdkRejection(reason: unknown): boolean {
  const stack = reason instanceof Error ? reason.stack ?? "" : "";
  return /[\\/]node_modules[\\/](google-gax|google-auth-library)[\\/]/.test(stack);
}
