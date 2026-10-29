import { z } from "zod";
import { answerDocumentSchema, type AnswerDocument } from "./domain.js";

// Older readers strip unknown top-level keys, but reject unknown nested layoutOptions.
// Keep the public/runtime shape unchanged and extend only the persisted envelope.
// Stored extensions can grow; validate known fields and ignore future keys.
const extensions = z.object({ avoidPunctuationOnlyLines: z.boolean().optional() });
export function encodeAnswer(answer: AnswerDocument, previous?: unknown): AnswerDocument & Record<string, unknown> & { layoutExtensions?: Record<string, unknown> } {
  const normalized = answerDocumentSchema.parse(answer);
  const { avoidPunctuationOnlyLines, ...legacyOptions } = normalized.layoutOptions ?? {};
  const stored = previous === undefined ? {} : z.record(z.string(), z.unknown()).parse(previous);
  if (previous !== undefined && decodeAnswer(previous).id !== normalized.id) {
    throw new Error("Persisted envelope belongs to a different answer.");
  }
  const opaque = Object.fromEntries(Object.entries(stored).filter(([key]) =>
    key !== "layoutExtensions" && !Object.hasOwn(answerDocumentSchema.shape, key)));
  const oldExtensions = stored.layoutExtensions === undefined ? {} :
    z.record(z.string(), z.unknown()).parse(stored.layoutExtensions);
  const { avoidPunctuationOnlyLines: _oldFlag, ...futureExtensions } = oldExtensions;
  const nextExtensions: Record<string, unknown> = { ...futureExtensions,
    ...(avoidPunctuationOnlyLines === undefined ? {} : { avoidPunctuationOnlyLines }) };
  return { ...opaque, ...normalized,
    ...(normalized.layoutOptions ? { layoutOptions: legacyOptions } : {}),
    ...(Object.keys(nextExtensions).length || Object.hasOwn(stored, "layoutExtensions") ? { layoutExtensions: nextExtensions } : {}),
  };
}

export function decodeAnswer(value: unknown): AnswerDocument {
  const envelope = z.object({ layoutExtensions: extensions.optional() }).parse(value);
  const answer = answerDocumentSchema.parse(value);
  const flag = envelope.layoutExtensions?.avoidPunctuationOnlyLines;
  if (flag !== undefined) {
    const nested = answer.layoutOptions?.avoidPunctuationOnlyLines;
    if (nested !== undefined && nested !== flag) throw new Error("Conflicting persisted layout options.");
    answer.layoutOptions = { ...answer.layoutOptions, avoidPunctuationOnlyLines: flag };
  }
  return answer;
}
