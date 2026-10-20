import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type SubsetExports = {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  malloc(size: number): number;
  free(pointer: number): void;
  hb_blob_create(data: number, length: number, mode: number, userData: number, destroy: number): number;
  hb_blob_destroy(blob: number): void;
  hb_blob_get_data(blob: number, length: number): number;
  hb_blob_get_length(blob: number): number;
  hb_face_create(blob: number, index: number): number;
  hb_face_destroy(face: number): void;
  hb_face_reference_blob(face: number): number;
  hb_set_add(set: number, codepoint: number): void;
  hb_subset_input_create_or_fail(): number;
  hb_subset_input_destroy(input: number): void;
  hb_subset_input_unicode_set(input: number): number;
  hb_subset_or_fail(face: number, input: number): number;
};

const HB_MEMORY_MODE_WRITABLE = 2;
let compiled: WebAssembly.Module | undefined;

/**
 * Keeps only the glyphs for `characters` (cmap, metrics and names stay valid) so a Word file can
 * embed the paper font. A fresh instance per call releases the wasm heap after each export.
 */
export async function subsetFont(fontPath: string, characters: Iterable<string>): Promise<Buffer> {
  compiled ??= new WebAssembly.Module(readFileSync(createRequire(import.meta.url).resolve("harfbuzzjs/dist/harfbuzz-subset.wasm")));
  const hb = (await WebAssembly.instantiate(compiled, {})).exports as unknown as SubsetExports;
  hb._initialize?.();
  const font = readFileSync(fontPath);
  const fontPointer = hb.malloc(font.byteLength);
  if (!fontPointer) throw new Error("字型子集記憶體配置失敗。");
  let face = 0, input = 0, subset = 0, result = 0;
  try {
    new Uint8Array(hb.memory.buffer).set(font, fontPointer);
    const blob = hb.hb_blob_create(fontPointer, font.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
    face = hb.hb_face_create(blob, 0);
    hb.hb_blob_destroy(blob);
    input = hb.hb_subset_input_create_or_fail();
    if (!input) throw new Error("字型子集初始化失敗。");
    const unicodes = hb.hb_subset_input_unicode_set(input);
    for (const character of characters) for (const symbol of character) hb.hb_set_add(unicodes, symbol.codePointAt(0)!);
    subset = hb.hb_subset_or_fail(face, input);
    if (!subset) throw new Error("字型子集產生失敗。");
    result = hb.hb_face_reference_blob(subset);
    // Read the heap only after subsetting: the wasm memory may have grown and detached older views.
    const data = Buffer.from(new Uint8Array(hb.memory.buffer, hb.hb_blob_get_data(result, 0), hb.hb_blob_get_length(result)));
    if (!data.length) throw new Error("字型子集為空。");
    return data;
  } finally {
    if (result) hb.hb_blob_destroy(result);
    if (subset) hb.hb_face_destroy(subset);
    if (input) hb.hb_subset_input_destroy(input);
    if (face) hb.hb_face_destroy(face);
    hb.free(fontPointer);
  }
}
