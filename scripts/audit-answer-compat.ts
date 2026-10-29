import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { answerDocumentSchema } from "../src/domain.js";
import { decodeAnswer, encodeAnswer } from "../src/answer-codec.js";

// Local JSON only. Prints a preview; never writes files or contacts a service.
if (process.argv.length !== 3) throw new Error("Usage: node --import tsx scripts/audit-answer-compat.ts local-fixture.json");
const raw = JSON.parse(await readFile(process.argv[2], "utf8"));
const answer = decodeAnswer(raw);
const preview = encodeAnswer(answer, raw);
assert.deepEqual(decodeAnswer(preview), answer, "preview must preserve every runtime answer field");
for (const key of Object.keys(raw)) {
  if (!Object.hasOwn(answerDocumentSchema.shape, key) && key !== "layoutExtensions") assert.deepEqual(preview[key], raw[key]);
}
for (const key of Object.keys(raw.layoutExtensions ?? {})) {
  if (key !== "avoidPunctuationOnlyLines") assert.deepEqual(preview.layoutExtensions?.[key], raw.layoutExtensions[key]);
}
const legacy = answerDocumentSchema.extend({ layoutOptions: z.strictObject({
  wholeLatinWords: z.boolean().optional(), keepHeadingWithNext: z.boolean().optional(),
}).optional() });
const oldRead = legacy.parse(preview);
console.log(JSON.stringify({ answerId: answer.id, version: answer.version, mode: "read-only-preview",
  legacyReadableBefore: legacy.safeParse(raw).success, legacyReadableAfter: true,
  runtimeAndOpaqueMetadataPreserved: true,
  oldWriterWouldDropTopLevelKeys: Object.keys(preview).filter(key => !Object.hasOwn(oldRead, key)),
  cloudDataChanged: false }, null, 2));
