import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import * as fontkit from "fontkit";
import { templateSchema, createAnswerDocument } from "../src/domain.js";
import { exportPdf } from "../src/exporters.js";
import { layoutSections } from "../src/layout.js";

// Noto Sans CJK is shipped as a TrueType Collection (TTC); each face is a separate
// CJK locale (JP/KR/SC/TC/HK). fontkit exposes them as opened.fonts[], and the
// collection's face 0 is Japanese — which is what the PDF exporter used to embed.
const TTC_REGULAR = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
const TTC_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc";
const TEST_TEXT = "直骨次海令臺說戶體警檢察灣";

/** BaseFont entries in a Type0/CIDFontType0C PDF carry the embedded face's postscriptName. */
function pdfBaseFontNames(buffer: Buffer): string[] {
  const text = buffer.toString("latin1");
  const names: string[] = [];
  const re = /\/BaseFont\s*\/([^\s\/]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) names.push(match[1]);
  return names;
}

function tcFace(collection: ReturnType<typeof fontkit.openSync>, suffix: string) {
  const face = collection.fonts.find((f: { postscriptName?: string; familyName?: string }) => f.postscriptName?.endsWith(suffix));
  if (!face) throw new Error(`TTC has no face ending with ${suffix}`);
  return face;
}

test("exported PDF embeds the Traditional Chinese (CJKtc) face, not the Japanese face", async () => {
  const previousFont = process.env.ESSAY_MCP_PDF_FONT;
  const previousBold = process.env.ESSAY_MCP_PDF_BOLD_FONT;
  process.env.ESSAY_MCP_PDF_FONT = TTC_REGULAR;
  process.env.ESSAY_MCP_PDF_BOLD_FONT = TTC_BOLD;
  try {
    const template = templateSchema.parse(JSON.parse(await fs.readFile(path.join("templates", "police_information_essay.json"), "utf8")));
    const answer = createAnswerDocument({ templateId: template.id, title: "tc-face", sections: [{ id: "a", text: TEST_TEXT }] });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-cjk-"));
    try {
      const pdfPath = path.join(directory, "face.pdf");
      const result = await exportPdf(layoutSections(template, answer.sections), template, pdfPath);
      const buffer = await fs.readFile(pdfPath);
      const names = pdfBaseFontNames(buffer);

      // The bug embedded NotoSansCJKjp-Regular (face 0 of the TTC).
      assert.ok(names.some((name) => /CJKtc/.test(name)), `expected an embedded CJKtc face, got ${names.join(", ")}`);
      assert.ok(!names.some((name) => /CJKjp/.test(name)), `Japanese face must not be embedded, got ${names.join(", ")}`);

      // The regression is only meaningful if the JP and TC faces actually differ
      // for these characters; otherwise the bug would be invisible.
      const collection = fontkit.openSync(TTC_REGULAR);
      const jp = tcFace(collection, "NotoSansCJKjp-Regular");
      const tc = tcFace(collection, "NotoSansCJKtc-Regular");
      for (const character of TEST_TEXT) {
        const codePoint = character.codePointAt(0)!;
        const jpGlyph = jp.glyphForCodePoint(codePoint);
        const tcGlyph = tc.glyphForCodePoint(codePoint);
        assert.ok(jpGlyph && tcGlyph, `missing glyph for ${character}`);
        assert.notEqual(JSON.stringify(jpGlyph.path), JSON.stringify(tcGlyph.path),
          `JP and TC glyphs for ${character} are identical — the bug would be invisible`);
      }
      void result;
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    if (previousFont === undefined) delete process.env.ESSAY_MCP_PDF_FONT;
    else process.env.ESSAY_MCP_PDF_FONT = previousFont;
    if (previousBold === undefined) delete process.env.ESSAY_MCP_PDF_BOLD_FONT;
    else process.env.ESSAY_MCP_PDF_BOLD_FONT = previousBold;
  }
});

test("exported PDF embeds the bold Traditional Chinese face when bold lines are present", async () => {
  const previousBold = process.env.ESSAY_MCP_PDF_BOLD_FONT;
  process.env.ESSAY_MCP_PDF_BOLD_FONT = TTC_BOLD;
  try {
    const template = templateSchema.parse(JSON.parse(await fs.readFile(path.join("templates", "police_information_essay.json"), "utf8")));
    const answer = createAnswerDocument({ templateId: template.id, title: "bold-tc", sections: [{ id: "a", text: TEST_TEXT, paragraphs: [{ text: TEST_TEXT, format: { bold: true } }] }] });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "police-essay-cjk-bold-"));
    try {
      const pdfPath = path.join(directory, "bold.pdf");
      await exportPdf(layoutSections(template, answer.sections), template, pdfPath);
      const names = pdfBaseFontNames(await fs.readFile(pdfPath));
      assert.ok(names.some((name) => /CJKtc-Bold/.test(name)), `expected an embedded CJKtc-Bold face, got ${names.join(", ")}`);
      assert.ok(!names.some((name) => /CJKjp-Bold/.test(name)), `bold Japanese face must not be embedded, got ${names.join(", ")}`);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  } finally {
    if (previousBold === undefined) delete process.env.ESSAY_MCP_PDF_BOLD_FONT;
    else process.env.ESSAY_MCP_PDF_BOLD_FONT = previousBold;
  }
});