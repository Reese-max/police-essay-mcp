import { z } from "zod";
import { answerDocumentSchema, type AnswerDocument } from "./domain.js";

// Older readers strip unknown top-level keys, but reject unknown nested layoutOptions.
// Keep the public/runtime shape unchanged and extend only the persisted envelope.
// Stored extensions can grow; validate known fields and ignore future keys.
const extensions = z.object({ avoidPunctuationOnlyLines: z.boolean().optional() });
export function encodeAnswer(answer: AnswerDocument) {
  const normalized = answerDocumentSchema.parse(answer);
  const { avoidPunctuationOnlyLines, ...legacyOptions } = normalized.layoutOptions ?? {};
  return { ...normalized,
    ...(normalized.layoutOptions ? { layoutOptions: legacyOptions } : {}),
    ...(avoidPunctuationOnlyLines === undefined ? {} : { layoutExtensions: { avoidPunctuationOnlyLines } }),
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
