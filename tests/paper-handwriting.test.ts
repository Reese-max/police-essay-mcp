import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as fontkit from 'fontkit';
import JSZip from 'jszip';
import { templateSchema, createAnswerDocument } from '../src/domain.js';
import { FileStore } from '../src/storage.js';
import { CloudStore } from '../src/cloud-storage.js';
import { MemoryFirestore, MemoryStorage } from './fakes/cloud-clients.js';
import { layoutSections } from '../src/layout.js';
import { originalPaperFont, originalPaperPreview, wrapOriginalPaper } from '../src/original-paper.js';
import { exportDocx, exportDocxBundle, exportPdf } from '../src/exporters.js';

const standard = templateSchema.parse(JSON.parse(readFileSync(new URL('../templates/police_information_essay_165.json', import.meta.url), 'utf8')));
const template = templateSchema.parse(JSON.parse(readFileSync(new URL('../templates/police_information_essay_165_handwriting.json', import.meta.url), 'utf8')));
const format = { firstLineIndent:0, leftIndent:0, rightIndent:0, alignment:'left' as const, spaceBeforeLines:0, spaceAfterLines:0, tabSize:4, bold:false, italic:false };
const skip = !process.env.ESSAY_MCP_HANDWRITING_FONT;
const variants = [['yozai','Yozai-Regular.ttf'],['xiaolai','Xiaolai-Regular.ttf'],['marker','LXGWMarkerGothic-Regular.ttf']].map(([suffix,file]) => ({
 template:templateSchema.parse(JSON.parse(readFileSync(new URL(`../templates/${template.id}_${suffix}.json`,import.meta.url),'utf8'))), file,
}));
const availableVariants = variants.filter(({file})=>process.env.ESSAY_MCP_HANDWRITING_FONT_DIR && existsSync(join(process.env.ESSAY_MCP_HANDWRITING_FONT_DIR,file)));
const skipNamed = availableVariants.length<2;
const restore = (name: string, value: string | undefined) => { if(value===undefined) delete process.env[name]; else process.env[name]=value; };
async function withoutStandardFont(run: () => void | Promise<void>) {
 const previous=process.env.ESSAY_MCP_PAPER_FONT;
 try { delete process.env.ESSAY_MCP_PAPER_FONT; await run(); }
 finally { restore('ESSAY_MCP_PAPER_FONT',previous); }
}
const report = () => layoutSections(template,createAnswerDocument({templateId:template.id,title:'手寫體測試',sections:[{text:'資訊安全 Zero Trust 165，保留文字。'}]}).sections);

test('165 templates require their own font environment variable', () => {
 const paper=process.env.ESSAY_MCP_PAPER_FONT, handwriting=process.env.ESSAY_MCP_HANDWRITING_FONT;
 try {
  delete process.env.ESSAY_MCP_HANDWRITING_FONT; process.env.ESSAY_MCP_PAPER_FONT='unused-standard.ttf';
  assert.throws(()=>wrapOriginalPaper('測試',format,template),/ESSAY_MCP_HANDWRITING_FONT/);
  delete process.env.ESSAY_MCP_PAPER_FONT; process.env.ESSAY_MCP_HANDWRITING_FONT='unused-handwriting.ttf';
  assert.throws(()=>wrapOriginalPaper('測試',format,standard),/ESSAY_MCP_PAPER_FONT/);
 } finally { restore('ESSAY_MCP_PAPER_FONT',paper); restore('ESSAY_MCP_HANDWRITING_FONT',handwriting); }
});

test('handwriting templates load without fonts but are hidden and require their own font configuration', async () => {
 const paper=process.env.ESSAY_MCP_PAPER_FONT, handwriting=process.env.ESSAY_MCP_HANDWRITING_FONT, directory=process.env.ESSAY_MCP_HANDWRITING_FONT_DIR;
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-store-'));
 try {
  delete process.env.ESSAY_MCP_PAPER_FONT; delete process.env.ESSAY_MCP_HANDWRITING_FONT; delete process.env.ESSAY_MCP_HANDWRITING_FONT_DIR;
  const store=new FileStore({answerDir:join(dir,'answers'),exportDir:join(dir,'exports')});
  const loaded=await store.getTemplate(template.id), original=await store.getTemplate(standard.id);
  assert.equal(loaded.paperProfile,'original_166'); assert.equal(loaded.paperFont,'handwriting');
  assert.equal(loaded.fontFamily,'Handwriting');
  assert.ok((await store.listTemplates()).every(t=>t.paperFont!=='handwriting'));
  for(const field of ['paperSize','pages','linesPerPage','columns','fontSizePt','lineHeightPt','marginsMm','overflowPolicy','paragraphDefaults','headingDefaults'] as const) assert.deepEqual(loaded[field],original[field],field);
  for(const {template:variant,file} of variants) {
   assert.deepEqual(await store.getTemplate(variant.id),variant);
   const missing={message:`165 原稿紙（手寫體）須設定 ESSAY_MCP_HANDWRITING_FONT_DIR，並放入 ${file}。`};
   assert.throws(()=>wrapOriginalPaper('測試',format,variant),missing);
   process.env.ESSAY_MCP_HANDWRITING_FONT='unused-handwriting.ttf';
   assert.throws(()=>wrapOriginalPaper('測試',format,variant),missing);
   delete process.env.ESSAY_MCP_HANDWRITING_FONT;
  }
  const empty=join(dir,'empty-fonts'); await fs.mkdir(empty);
  process.env.ESSAY_MCP_HANDWRITING_FONT_DIR=empty;
  for(const {template:variant} of variants) assert.throws(()=>wrapOriginalPaper('測試',format,variant),{message:'165 原稿紙（手寫體）字型無法載入。'});
  assert.throws(()=>wrapOriginalPaper('測試',format,template),{message:'165 原稿紙（手寫體）須設定 ESSAY_MCP_HANDWRITING_FONT，指向手寫字型檔。'});
 } finally { restore('ESSAY_MCP_PAPER_FONT',paper); restore('ESSAY_MCP_HANDWRITING_FONT',handwriting); restore('ESSAY_MCP_HANDWRITING_FONT_DIR',directory); await fs.rm(dir,{recursive:true,force:true}); }
});

test('named handwriting templates preserve geometry and accept only plain font file names', () => {
 for(const {template:variant,file} of variants) {
  assert.equal(variant.paperFontFile,file); assert.equal(variant.fontFamily,'Handwriting');
  for(const field of ['paperSize','pages','linesPerPage','columns','fontSizePt','lineHeightPt','marginsMm','overflowPolicy','paragraphDefaults','headingDefaults','paperProfile','paperFont'] as const) assert.deepEqual(variant[field],template[field],field);
 }
 for(const paperFontFile of ['../x.ttf','a/b.ttf','a\\b.ttf','']) assert.equal(templateSchema.safeParse({...template,paperFontFile}).success,false);
});

test('file and cloud lists check current handwriting file existence without opening fonts', async () => {
 const handwriting=process.env.ESSAY_MCP_HANDWRITING_FONT, directory=process.env.ESSAY_MCP_HANDWRITING_FONT_DIR;
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-availability-'));
 try {
  const stores=[new FileStore({answerDir:join(dir,'answers'),exportDir:join(dir,'exports')}),new CloudStore({
   firestore:new MemoryFirestore().client(),storage:new MemoryStorage().client(),environment:'staging',ownerKey:'a'.repeat(64),artifactBucket:'synthetic-artifacts',templateDir:join(process.cwd(),'templates'),
  })];
  delete process.env.ESSAY_MCP_HANDWRITING_FONT; delete process.env.ESSAY_MCP_HANDWRITING_FONT_DIR;
  for(const store of stores) {
   assert.ok((await store.listTemplates()).every(t=>t.paperFont!=='handwriting'));
   for(const variant of [template,...variants.map(v=>v.template)]) assert.equal((await store.getTemplate(variant.id)).id,variant.id);
  }
  const file=join(dir,'Yozai-Regular.ttf'); await fs.writeFile(file,'not a font');
  process.env.ESSAY_MCP_HANDWRITING_FONT_DIR=dir;
  for(const configured of [undefined,join(dir,'missing.ttf'),file]) {
   restore('ESSAY_MCP_HANDWRITING_FONT',configured);
   for(const store of stores) {
    const listed=await store.listTemplates();
    assert.deepEqual(listed.filter(t=>t.paperFont==='handwriting').map(t=>t.id),configured===file?[template.id,variants[0].template.id]:[variants[0].template.id]);
    assert.ok(listed.some(t=>t.id===standard.id));
   }
  }
  assert.throws(()=>wrapOriginalPaper('測試',format,variants[0].template),{message:'165 原稿紙（手寫體）字型無法載入。'});
  await fs.unlink(file);
  for(const store of stores) assert.ok((await store.listTemplates()).every(t=>t.paperFont!=='handwriting'));
 } finally { restore('ESSAY_MCP_HANDWRITING_FONT',handwriting); restore('ESSAY_MCP_HANDWRITING_FONT_DIR',directory); await fs.rm(dir,{recursive:true,force:true}); }
});

test('standard SHA lock survives a handwriting path and invalid handwriting files fail clearly', async () => {
 const paper=process.env.ESSAY_MCP_PAPER_FONT, handwriting=process.env.ESSAY_MCP_HANDWRITING_FONT;
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-invalid-'));
 try {
  const invalid=join(dir,'invalid.ttf'); await fs.writeFile(invalid,'not a font');
  process.env.ESSAY_MCP_PAPER_FONT=invalid; process.env.ESSAY_MCP_HANDWRITING_FONT=join(dir,'handwriting.ttf');
  assert.throws(()=>wrapOriginalPaper('測試',format,standard),/SHA-256 mismatch/);
  process.env.ESSAY_MCP_HANDWRITING_FONT=invalid;
  assert.throws(()=>wrapOriginalPaper('測試',format,template),{message:'165 原稿紙（手寫體）字型無法載入。'});
  // A font collection (.ttc) opens without error but has no layout(); it must fail as clearly as an invalid file.
  const collection=join(dir,'collection.ttc'), header=Buffer.alloc(12); header.write('ttcf',0,'latin1'); header.writeUInt32BE(0x00010000,4);
  await fs.writeFile(collection,header); process.env.ESSAY_MCP_HANDWRITING_FONT=collection;
  assert.throws(()=>wrapOriginalPaper('測試',format,template),{message:'165 原稿紙（手寫體）字型無法載入。'});
 } finally { restore('ESSAY_MCP_PAPER_FONT',paper); restore('ESSAY_MCP_HANDWRITING_FONT',handwriting); await fs.rm(dir,{recursive:true,force:true}); }
});

test('handwriting preserves mixed text and rejects missing glyphs and invalid layout', {skip}, () => withoutStandardFont(() => {
 const text='資訊安全 Zero Trust 165，保留文字、數字與標點。'.repeat(4);
 const lines=wrapOriginalPaper(text,format,template,{wholeLatinWords:true});
 assert.equal(lines.join(''),text); assert.ok(lines.length>1);
 assert.throws(()=>wrapOriginalPaper(String.fromCodePoint(0x10FFFD),format,template),/稿紙字型缺字/);
 for(const invalid of [{bold:true},{italic:true},{alignment:'right' as const}]) assert.throws(()=>wrapOriginalPaper('測試',{...format,...invalid},template),/請關閉/);
 for(const invalid of [{pages:3},{linesPerPage:23},{fontSizePt:18},{lineHeightPt:23},{marginsMm:{...template.marginsMm,left:0}}]) assert.throws(()=>wrapOriginalPaper('測試',format,{...template,...invalid}),/維持標準設定/);
}));

test('handwriting cache does not bypass the standard SHA lock and invalidates changed files', {skip}, () => withoutStandardFont(async () => {
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-cache-'));
 const handwriting=process.env.ESSAY_MCP_HANDWRITING_FONT;
 try {
  const file=join(dir,'font.ttf'); await fs.copyFile(handwriting!,file);
  await fs.appendFile(file,' '); // never the approved hash, even when the handwriting variable points at the standard font
  process.env.ESSAY_MCP_HANDWRITING_FONT=file;
  const face=originalPaperFont(template); assert.equal(originalPaperFont(template),face);
  assert.throws(()=>originalPaperFont(standard,file),/SHA-256 mismatch/);
  await fs.writeFile(file,'invalid font');
  assert.throws(()=>originalPaperFont(template),/字型無法載入/);
 } finally { restore('ESSAY_MCP_HANDWRITING_FONT',handwriting); await fs.rm(dir,{recursive:true,force:true}); }
}));

test('handwriting PDF exports two pages without the standard font', {skip}, () => withoutStandardFont(async () => {
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-pdf-'));
 try {
  const file=join(dir,'answer.pdf'); const result=await exportPdf(report(),template,file);
  assert.equal(result.pages,2); assert.equal(result.font,process.env.ESSAY_MCP_HANDWRITING_FONT);
  const data=await fs.readFile(file); assert.equal(data.subarray(0,5).toString(),'%PDF-');
  assert.equal((data.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,2);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
}));

test('handwriting SVG uses outlines and placements without the standard font', {skip}, () => withoutStandardFont(() => {
 const pages=originalPaperPreview(template,report());
 assert.equal(pages.length,2); assert.match(pages[0],/<path /); assert.match(pages[0],/<use /); assert.ok(!pages[0].includes('<text'));
}));

test('handwriting DOCX embeds and uses the real family without MOE names', {skip}, () => withoutStandardFont(async () => {
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-docx-'));
 try {
  const file=join(dir,'answer.docx'); const layout=report();
  assert.equal((await exportDocx(layout,template,file)).pages,2);
  const family=fontkit.openSync(process.env.ESSAY_MCP_HANDWRITING_FONT!).familyName;
  const zip=await JSZip.loadAsync(await fs.readFile(file));
  const table=await zip.file('word/fontTable.xml')!.async('string');
  const key=table.match(/w:fontKey="\{([0-9A-F-]+)\}"/)![1];
  const data=Buffer.from(await zip.file('word/fonts/font1.odttf')!.async('uint8array'));
  const bytes=key.replace(/-/g,'').match(/../g)!.reverse().map(hex=>parseInt(hex,16));
  for(let i=0;i<32;i++) data[i]^=bytes[i%16];
  const face=(fontkit as unknown as {create(data:Buffer):{familyName:string;hasGlyphForCodePoint(code:number):boolean}}).create(data);
  assert.equal(face.familyName,family);
  for(const character of Array.from(layout.lines.map(line=>line.text).join(''))) assert.ok(face.hasGlyphForCodePoint(character.codePointAt(0)!),character);
  const xml=(value:string)=>value.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));
  assert.ok(table.includes(`w:name="${xml(family)}"`)); assert.ok(!table.includes('w:altName'));
  const document=await zip.file('word/document.xml')!.async('string');
  for(const attribute of ['ascii','hAnsi','eastAsia']) assert.ok(document.includes(`w:${attribute}="${xml(family)}"`));
  for(const entry of Object.values(zip.files).filter(entry=>entry.name.endsWith('.xml'))) assert.doesNotMatch(await entry.async('string'),/TW-MOE-Std-Kai|教育部標準楷書|Handwriting/);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
}));

test('mixed paper DOCX bundle embeds and uses each paper font', {skip:skip||!process.env.ESSAY_MCP_PAPER_FONT}, async () => {
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-bundle-'));
 try {
  const entries=[standard,template].map(template=>({template,report:layoutSections(template,createAnswerDocument({templateId:template.id,title:'合輯',sections:[{text:'資訊安全 ABC 165。'}]}).sections)}));
  const file=join(dir,'bundle.docx'); assert.equal((await exportDocxBundle(entries,file)).pages,4);
  const zip=await JSZip.loadAsync(await fs.readFile(file));
  const table=await zip.file('word/fontTable.xml')!.async('string'), document=await zip.file('word/document.xml')!.async('string');
  const names=[...table.matchAll(/<w:font w:name="([^"]+)">/g)].map(match=>match[1]);
  assert.equal(names.length,2);
  for(const [index,name] of names.entries()) {
   assert.ok(document.includes(`w:eastAsia="${name}"`)); assert.ok(zip.file(`word/fonts/font${index+1}.odttf`));
   assert.ok(table.includes(`r:id="rId${index+1}"`));
  }
  assert.equal((table.match(/w:altName/g)||[]).length,1);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('named handwriting fonts wrap, export and remain distinct in bundles and the cache', {skip:skipNamed}, async () => {
 const paper=process.env.ESSAY_MCP_PAPER_FONT, handwriting=process.env.ESSAY_MCP_HANDWRITING_FONT;
 const dir=await fs.mkdtemp(join(tmpdir(),'paper-handwriting-named-'));
 try {
  delete process.env.ESSAY_MCP_PAPER_FONT; delete process.env.ESSAY_MCP_HANDWRITING_FONT;
  const selected=availableVariants.slice(0,2), text='資訊安全 Zero Trust 165，保留原字。';
  const faces=selected.map(({file})=>fontkit.openSync(join(process.env.ESSAY_MCP_HANDWRITING_FONT_DIR!,file)));
  const cached=selected.map(({template})=>originalPaperFont(template));
  for(let repeat=0;repeat<3;repeat++) for(const [index,{template}] of selected.entries()) {
   const face=originalPaperFont(template); assert.equal(face.familyName,faces[index].familyName); assert.equal(face,cached[index]);
  }
  const entries=selected.map(({template})=>{
   assert.equal(wrapOriginalPaper(text,format,template).join(''),text);
   return {template,report:layoutSections(template,createAnswerDocument({templateId:template.id,title:'具名字型合併',sections:[{text}]}).sections)};
  });
  const pdf=join(dir,'answer.pdf'), result=await exportPdf(entries[0].report,entries[0].template,pdf);
  assert.equal(result.pages,2); assert.equal(result.font,join(process.env.ESSAY_MCP_HANDWRITING_FONT_DIR!,selected[0].file));
  const data=await fs.readFile(pdf); assert.equal(data.subarray(0,5).toString(),'%PDF-');
  assert.equal((data.toString('latin1').match(/\/Type \/Page\b/g)||[]).length,2);
  const docx=join(dir,'bundle.docx'); assert.equal((await exportDocxBundle(entries,docx)).pages,4);
  const zip=await JSZip.loadAsync(await fs.readFile(docx));
  assert.equal(Object.values(zip.files).filter(entry=>/^word\/fonts\/[^/]+\.odttf$/.test(entry.name)).length,2);
  const table=await zip.file('word/fontTable.xml')!.async('string'), document=await zip.file('word/document.xml')!.async('string');
  const fontEntries=[...table.matchAll(/<w:font w:name="([^"]+)">([\s\S]*?)<\/w:font>/g)];
  assert.equal(fontEntries.length,2); assert.doesNotMatch(table,/教育部標準楷書|TW-MOE-Std-Kai|w:altName/);
  const sections=document.split('</w:sectPr>'); assert.equal(sections.length,3);
  const xml=(value:string)=>value.replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]!));
  for(const [index,face] of faces.entries()) {
   const family=xml(face.familyName);
   assert.equal(fontEntries[index][1],family); assert.ok(fontEntries[index][2].includes(`r:id="rId${index+1}"`));
   assert.ok(zip.file(`word/fonts/font${index+1}.odttf`));
   const runs=[...sections[index].matchAll(/<w:rFonts\b[^>]*>/g)]; assert.ok(runs.length>0);
   for(const [run] of runs) for(const attribute of ['ascii','hAnsi','eastAsia']) assert.ok(run.includes(`w:${attribute}="${family}"`),run);
  }
 } finally { restore('ESSAY_MCP_PAPER_FONT',paper); restore('ESSAY_MCP_HANDWRITING_FONT',handwriting); await fs.rm(dir,{recursive:true,force:true}); }
});
