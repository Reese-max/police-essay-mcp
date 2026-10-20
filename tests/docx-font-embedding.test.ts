import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Document, Packer, Paragraph, TextRun } from "docx";
import * as fontkit from "fontkit";
import JSZip from "jszip";
import { embeddedFontOptions, embeddedFontTable } from "../src/exporters.js";
import { subsetFont } from "../src/font-subset.js";

// The paper font is private, so CI checks the same embedding path with a system TrueType face.
const systemFont = ["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "C:\\Windows\\Fonts\\arial.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf"]
  .find(candidate => existsSync(candidate));
type Face = { familyName: string; numGlyphs: number; hasGlyphForCodePoint(codePoint: number): boolean };
const open = (data: Buffer) => (fontkit as unknown as { create(data: Buffer): Face }).create(data);

test("harfbuzz subset keeps only the requested characters with a usable cmap and name table", { skip: !systemFont && "no system TrueType font" }, async () => {
  const original = open(readFileSync(systemFont!));
  const subset = open(await subsetFont(systemFont!, ["Hello"]));
  assert.equal(subset.familyName, original.familyName);
  for (const character of "Helo") assert.ok(subset.hasGlyphForCodePoint(character.codePointAt(0)!), character);
  assert.ok(!subset.hasGlyphForCodePoint("Z".codePointAt(0)!));
  assert.ok(subset.numGlyphs < 10 && subset.numGlyphs < original.numGlyphs);
});

test("embedded Word font keeps docx relationships, an uppercase key and one style default", { skip: !systemFont && "no system TrueType font" }, async () => {
  const data = await subsetFont(systemFont!, ["Hello"]);
  const document = new Document({ ...embeddedFontOptions("Embedded Face", data),
    sections: [{ children: [new Paragraph({ children: [new TextRun({ text: "Hello", font: "Embedded Face" })] })] }] });
  const zip = await JSZip.loadAsync(await Packer.toBuffer(document, false, embeddedFontTable(document, "Embedded Face", "替代名")));
  const read = (path: string) => zip.file(path)!.async("string");
  const types = await read("[Content_Types].xml");
  assert.ok([...types.matchAll(/<Default [^>]*\/>/g)].some(([tag]) => tag.includes('Extension="odttf"')
    && tag.includes('ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"')), types);
  assert.match(await read("word/_rels/fontTable.xml.rels"), /Id="rId1"[^>]*Target="fonts\/font1\.odttf"/);
  const fontTable = await read("word/fontTable.xml");
  assert.match(fontTable, /<w:font w:name="Embedded Face"><w:altName w:val="替代名"\/>/);
  const key = fontTable.match(/w:fontKey="\{([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\}" w:subsetted="1"/)![1];
  // ECMA-376 font obfuscation: XOR the first 32 bytes with the GUID bytes in reverse order.
  const odttf = Buffer.from(await zip.file("word/fonts/font1.odttf")!.async("uint8array"));
  const bytes = key.replace(/-/g, "").match(/../g)!.reverse().map(hex => parseInt(hex, 16));
  for (let i = 0; i < 32; i++) odttf[i] ^= bytes[i % 16];
  assert.ok(odttf.equals(data));
  const styles = await read("word/styles.xml");
  assert.equal(styles.match(/<w:docDefaults>/g)?.length, 1);
  const ids = [...styles.matchAll(/w:styleId="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(styles, /<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"\/><w:pPr><w:autoSpaceDE w:val="0"\/><w:autoSpaceDN w:val="0"\/>/);
});
