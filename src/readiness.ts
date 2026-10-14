import type { EssayStore } from "./storage.js";
import { validateRuntimeFont } from "./runtime-font.js";

export function createReadinessCheck(store: EssayStore, options: {
  ttlMs?: number; timeoutMs?: number; now?: () => number; fontPath?: () => string | undefined;
} = {}): () => Promise<void> {
  const now = options.now ?? Date.now;
  let storageReadyUntil = 0;
  let pending: Promise<void> | undefined;
  return async () => {
    const [template, paper] = await Promise.all([
      store.getTemplate("police_information_essay"), store.getTemplate("police_information_essay_166"),
    ]);
    if (!template || !paper) throw new Error("Templates are not readable.");
    const fontPath = (options.fontPath ?? (() => process.env.ESSAY_MCP_PAPER_FONT))();
    if (fontPath) await validateRuntimeFont(paper, fontPath);
    if (!store.checkReadiness || now() < storageReadyUntil) return;
    if (!pending) {
      pending = (async () => {
        let timeout: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            store.checkReadiness!(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(() => reject(new Error("Storage readiness timed out.")), options.timeoutMs ?? 3000);
            }),
          ]);
          storageReadyUntil = now() + (options.ttlMs ?? 5000);
        } finally {
          if (timeout) clearTimeout(timeout);
          pending = undefined;
        }
      })();
    }
    await pending;
  };
}
