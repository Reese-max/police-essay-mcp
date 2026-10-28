import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as fontkit from "fontkit";
import type { AnswerTemplate, LayoutOptions, ParagraphFormat } from "./domain.js";

// Resolve both src/ and dist/src/ without depending on the process working directory.
const assetUrl = new URL(import.meta.url.includes("/dist/") ? "../../assets/paper_166.asset.json" : "../assets/paper_166.asset.json", import.meta.url);
export const originalPaper = JSON.parse(readFileSync(fileURLToPath(assetUrl), "utf8")) as { imageBase64: string; sha256: string; imageRect: number[]; rows: number[][] };
export function originalPaperImage(): Buffer {
  const image = Buffer.from(originalPaper.imageBase64, "base64");
  if (createHash("sha256").update(image).digest("hex") !== originalPaper.sha256) throw new Error("166 稿紙底圖雜湊不符。");
  return image;
}
export function originalPaperFontPath(): string {
  const fontPath = process.env.ESSAY_MCP_PAPER_FONT;
  if (!fontPath) throw new Error("166 原稿紙須設定 ESSAY_MCP_PAPER_FONT，指向教育部標準楷書完整字型。");
  return fontPath;
}
export const ORIGINAL_PAPER_FONT_SHA256 = "e2b6b1bd1d6303672a68d5057a1f1e4b5361e3d8842373ff3bd1c71fb9ea9b98";
let cachedFont: { path: string; mtimeMs: number; size: number; face: ReturnType<typeof fontkit.openSync> } | undefined;
export function validateOriginalPaperFontFamily(familyName: string): void {
  if (familyName !== "TW-MOE-Std-Kai") throw new Error("166 原稿紙須使用教育部標準楷書 TW-MOE-Std-Kai。");
}
export function validatedOriginalPaperFont(fontPath: string) {
  const { mtimeMs, size } = statSync(fontPath);
  if (cachedFont?.path === fontPath && cachedFont.mtimeMs === mtimeMs && cachedFont.size === size) return cachedFont.face;
  if (createHash("sha256").update(readFileSync(fontPath)).digest("hex") !== ORIGINAL_PAPER_FONT_SHA256) throw new Error("166 font SHA-256 mismatch. 166 原稿紙須使用教育部標準楷書 5.1 完整未修改字型。");
  const opened = fontkit.openSync(fontPath);
  validateOriginalPaperFontFamily(opened.familyName);
  cachedFont = { path: fontPath, mtimeMs, size, face: opened };
  return opened;
}
function font() { return validatedOriginalPaperFont(originalPaperFontPath()); }
export function validateOriginalPaper(template: AnswerTemplate, fontPath?: string): void {
  if (template.pages !== 2 || template.linesPerPage !== 22 || template.fontSizePt !== 19 || template.fontFamily !== "TW-MOE-Std-Kai" || template.lineHeightPt !== 22 || Math.abs(template.marginsMm.left * 72 / 25.4 - 130.32) > 0.01 || Math.abs(template.marginsMm.top * 72 / 25.4 - originalPaper.rows[0][0]) > 0.01 || Math.abs(595.28 - template.marginsMm.right * 72 / 25.4 - 496) > 0.01) throw new Error("166 原稿紙的頁數、行數、字級及位置須維持標準設定。");
  originalPaperImage();
  validatedOriginalPaperFont(fontPath ?? originalPaperFontPath());
}
export function originalPaperMeasure(template: AnswerTemplate): (value: string) => number {
  const face = font();
  return (value: string) => {
    const glyphWidth = face.layout(value).positions.reduce((sum: number, p: { xAdvance: number }) => sum + p.xAdvance, 0) * template.fontSizePt / face.unitsPerEm;
    // Word may add quarter-em spacing between Han and Latin letters. Reserve it
    // during shared wrapping so the editable Word rows never clip their last glyph.
    const boundaries = Array.from(value.matchAll(/(?<=[\p{Script=Han}])[A-Za-z0-9]|(?<=[A-Za-z0-9])[\p{Script=Han}]/gu)).length;
    return glyphWidth + boundaries * template.fontSizePt / 4;
  };
}
export function originalPaperAvailableWidth(format: ParagraphFormat, template: AnswerTemplate, lineIndex = 1): number {
  // Leave 2pt reserve for Word shaping/rounding; do not rewrite or drop characters.
  return 496 - 130.32 - 2 - (format.leftIndent + format.rightIndent + (lineIndex === 0 ? format.firstLineIndent : 0)) * template.fontSizePt / 2;
}
export function wrapOriginalPaper(text: string, format: ParagraphFormat, template: AnswerTemplate, options: LayoutOptions = {}): string[] {
  validateOriginalPaper(template);
  if (format.bold || format.italic || format.alignment !== "left") throw new Error("166 原稿紙採標準楷書靠左排版，請關閉粗體、斜體與分散對齊。");
  const face = font();
  const measure = originalPaperMeasure(template);
  const lines: string[] = [];
  let current = "";
  const available = (lineIndex = lines.length) => originalPaperAvailableWidth(format, template, lineIndex);
  for (const { segment, index } of new Intl.Segmenter("zh-TW", { granularity: "grapheme" }).segment(text)) {
    if (segment === "\t") throw new Error("166 原稿紙請以明確縮排取代定位字元。");
    for (const character of Array.from(segment)) if (!face.hasGlyphForCodePoint(character.codePointAt(0)!)) throw new Error(`稿紙字型缺字：${character}`);
    if (measure(current + segment) > available()) {
      if (!current) throw new Error("段落縮排使稿紙可用寬度不足。");
      // Move a preceding character with a closing mark; avoid orphan punctuation.
      const characters = Array.from(new Intl.Segmenter("zh-TW", { granularity: "grapheme" }).segment(current), s => s.segment);
      let carry = "";
      if (/[，。；：！？、）】」』〉》]/u.test(segment) || /[（【「『〈《]$/u.test(current)) carry = characters.pop() ?? "";
      const trailing = options.wholeLatinWords && /^[A-Za-z0-9]/.test(carry + segment)
        ? characters.join("").match(/[A-Za-z0-9]+$/)?.[0] ?? "" : "";
      const rest = trailing && /^[A-Za-z0-9]/.test(segment)
        ? text.slice(index + segment.length).match(/^[A-Za-z0-9]*[，。；：！？、）】」』〉》]?/u)?.[0] ?? "" : "";
      if (trailing && /\S/u.test(characters.slice(0, -trailing.length).join(""))
        && measure(trailing + carry + segment + rest) <= available(lines.length + 1)) {
        carry = trailing + carry;
        characters.splice(characters.length - trailing.length);
      }
      if (!characters.length) throw new Error("稿紙縮排不足以容納標點與前一字。");
      lines.push(characters.join("")); current = carry;
      if (measure(current + segment) > available()) throw new Error("段落縮排使稿紙可用寬度不足。");
    }
    current += segment;
  }
  if (current || !lines.length) lines.push(current);
  return lines;
}

type PathCommand = { command: string; args: number[] };
const PATH_LETTERS: Record<string, string> = { moveTo: "m", lineTo: "l", quadraticCurveTo: "q", bezierCurveTo: "c" };
/**
 * Lossless compact SVG path: relative coordinates in hundredths, implicit repeated commands and no
 * separator before a minus sign. Absolute font-unit outlines are about a third longer.
 */
export function compactGlyphPath(commands: PathCommand[]): string {
  let out = "", last = "", x = 0, y = 0, startX = 0, startY = 0;
  for (const { command, args } of commands) {
    if (command === "closePath") { out += "z"; last = "z"; x = startX; y = startY; continue; }
    const letter = PATH_LETTERS[command];
    if (!letter) throw new Error(`Unsupported glyph path command ${command}.`);
    const points = args.map(value => Math.round(value * 100));
    let numbers = "";
    points.forEach((point, index) => {
      const text = String((point - (index % 2 ? y : x)) / 100);
      numbers += numbers && !text.startsWith("-") ? " " + text : text;
    });
    out += letter === last && letter !== "m" ? (numbers.startsWith("-") ? numbers : " " + numbers) : letter + numbers;
    last = letter;
    [x, y] = points.slice(-2);
    if (letter === "m") [startX, startY] = [x, y];
  }
  return out;
}

/** Glyph outlines give the browser the same paper/font geometry without downloading a font. */
export function originalPaperPreview(template: AnswerTemplate, report: import('./domain.js').LayoutReport): string[] {
  validateOriginalPaper(template);
  const face = font();
  const scale = template.fontSizePt / face.unitsPerEm;
  const escape = (value: string) => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]!));
  const round = (value: number) => Math.round(value * 100) / 100;
  return Array.from({length: template.pages}, (_, index) => {
    const [x,y,right,bottom] = originalPaper.imageRect;
    // Each outline is defined once per page and placed with <use>; ids carry the page so both
    // pages can share one document. Repeated characters no longer repeat their outlines.
    const defined = new Map<number, string>();
    const groups = report.lines.filter(l => l.page === index+1 && l.text && !l.isSpacer).map(line => {
      const row = originalPaper.rows[line.lineOnPage-1];
      let pen = 130.32 + (line.format.leftIndent + (line.isFirstLineOfParagraph ? line.format.firstLineIndent : 0)) * template.fontSizePt / 2;
      const run = face.layout(line.text);
      const uses = run.glyphs.map((glyph: {id: number; path: {commands: PathCommand[]}}, i: number) => {
        const position = run.positions[i];
        const id = `p${index+1}g${glyph.id}`;
        if (!defined.has(glyph.id)) defined.set(glyph.id, `<path id="${id}" d="${compactGlyphPath(glyph.path.commands)}" transform="scale(${scale} ${-scale})"/>`);
        const use = `<use href="#${id}" x="${round(pen+position.xOffset*scale)}" y="${round(row[1]-3.5-position.yOffset*scale)}"/>`;
        pen += position.xAdvance * scale;
        return use;
      }).join('');
      return `<g data-section-id="${escape(line.sectionId)}" role="button" tabindex="0" aria-label="${escape(line.text)}"><rect x="130.32" y="${row[0]}" width="365.68" height="${row[1]-row[0]}" fill="none" pointer-events="all"/>${uses}</g>`;
    }).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 595.3 841.9" role="img" aria-label="第${index+1}頁原稿紙"><defs>${[...defined.values()].join('')}</defs><rect width="595.3" height="841.9" fill="white"/><image href="data:image/jpeg;base64,${originalPaper.imageBase64}" x="${x}" y="${y}" width="${right-x}" height="${bottom-y}"/><g fill="#111111">${groups}</g></svg>`;
  });
}
