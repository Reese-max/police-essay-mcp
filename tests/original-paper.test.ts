import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { templateSchema, createAnswerDocument } from '../src/domain.js';
import { layoutSections } from '../src/layout.js';
import { originalPaper, originalPaperImage, wrapOriginalPaper } from '../src/original-paper.js';
import { exportDocx, exportPdf } from '../src/exporters.js';
const template = templateSchema.parse(JSON.parse(readFileSync(new URL('../templates/police_information_essay_166.json', import.meta.url), 'utf8')));
const format = { firstLineIndent:0, leftIndent:0, rightIndent:0, alignment:'left' as const, spaceBeforeLines:0, spaceAfterLines:0, tabSize:4, bold:false, italic:false };
test('166 original image is intact and contains exactly 22 contiguous writing rows', () => {
 assert.equal(originalPaperImage().length, 30351);
 assert.equal(originalPaper.rows.length,22);
 for(let i=1;i<22;i++) assert.equal(originalPaper.rows[i][0],originalPaper.rows[i-1][1]);
 assert.equal(template.pages * template.linesPerPage,44);
});
test('166 wrapping fails explicitly without its font instead of using a substitute', () => {
 const previous=process.env.ESSAY_MCP_PAPER_FONT;
 try { delete process.env.ESSAY_MCP_PAPER_FONT; assert.throws(()=>wrapOriginalPaper('中文',format,template),/ESSAY_MCP_PAPER_FONT/); }
 finally { if(previous===undefined) delete process.env.ESSAY_MCP_PAPER_FONT; else process.env.ESSAY_MCP_PAPER_FONT=previous; }
});
test('166 measured wrapping preserves mixed text, punctuation and all characters', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, () => {
 const text='3.IDS監控：部署網路與主機IDS，以特徵及異常偵測彙整告警至SIEM，查證、通報與隔離；阻擋須另結合IPS等機制。';
 const lines=wrapOriginalPaper(text,format,template);
 assert.equal(lines.join(''),text);
 assert.ok(lines.length>1);
 assert.ok(lines.every(l=>l!=='。'));
 assert.throws(()=>wrapOriginalPaper(text,{...format,bold:true},template),/關閉粗體/);
 assert.throws(()=>wrapOriginalPaper(text,format,{...template,pages:3}),/維持標準設定/);
});
test('166 exports reject 45 lines even when an overflow override is requested', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, async () => {
 const answer=createAnswerDocument({templateId:template.id,title:'測試',sections:[{text:Array(45).fill('甲').join('\n')}]});
 const report=layoutSections(template,answer.sections);
 assert.equal(report.totalLines,45);assert.equal(report.fits,false);
 await assert.rejects(exportDocx(report,template,'unused.docx',true),/兩頁44行/);
 await assert.rejects(exportPdf(report,template,'unused.pdf'),/兩頁44行/);
});

test('166 asset does not appear as a template and invalid formatting does not persist', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, async () => {
 const { FileStore } = await import('../src/storage.js');
 const { promises: fs } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const dir = await fs.mkdtemp(join(tmpdir(),'paper166-store-'));
 try {
  const store = new FileStore({answerDir:join(dir,'answers'),exportDir:join(dir,'exports')});
  const templates=await store.listTemplates();
  assert.ok(templates.some(t=>t.id===template.id));
  const answer=createAnswerDocument({templateId:template.id,title:'測試',sections:[{text:'不得存入無法渲染的格式',paragraphFormat:{bold:true}}]});
  await assert.rejects(store.saveAnswer(answer),/關閉粗體/);
  assert.equal((await store.listAnswers()).length,0);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});

test('166 canvas preview keeps two original pages even when content overflows', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, async () => {
 const {originalPaperPreview}=await import('../src/original-paper.js');
 const answer=createAnswerDocument({templateId:template.id,title:'測試',sections:[{id:'part_1',text:Array(80).fill('資料探勘').join('\n')}]});
 const report=layoutSections(template,answer.sections);
 const pages=originalPaperPreview(template,report);
 assert.equal(report.fits,false);assert.equal(pages.length,2);
 assert.equal(pages.map(svg=>(svg.match(/data-section-id=/g)||[]).length).reduce((a,b)=>a+b,0),44);
 assert.ok(pages.every(svg=>svg.includes('data:image/jpeg;base64,')&&svg.includes('<defs><path id=')));
 assert.ok(pages.every(svg=>!svg.includes('<text')));
});

test('166 canvas preview defines each glyph outline once per page and places every glyph', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, async () => {
 const {originalPaperPreview}=await import('../src/original-paper.js');
 const answer=createAnswerDocument({templateId:template.id,title:'測試',sections:[{id:'part_1',text:'資訊安全資訊安全ABC，資訊。\n安全'}]});
 const report=layoutSections(template,answer.sections);
 const [first,second]=originalPaperPreview(template,report);
 const ids=[...first.matchAll(/<path id="([^"]+)"/g)].map(m=>m[1]);
 const uses=[...first.matchAll(/<use href="#([^"]+)"/g)].map(m=>m[1]);
 assert.equal(new Set(ids).size,ids.length);
 assert.ok(ids.every(id=>id.startsWith('p1g')));
 // 資訊安全ABC，。 are 9 distinct glyphs; every placed glyph refers to a defined outline.
 assert.equal(ids.length,9);
 assert.equal(uses.length,Array.from('資訊安全資訊安全ABC，資訊。安全').length);
 assert.ok(uses.every(id=>ids.includes(id)));
 assert.ok(!second.includes('<path id=')&&second.includes('<defs></defs>'));
});

test('compact glyph paths decode to the original absolute outline', async () => {
 const {compactGlyphPath}=await import('../src/original-paper.js');
 const commands=[{command:'moveTo',args:[1805,648]},{command:'quadraticCurveTo',args:[1799,628,1780,620.5]},{command:'quadraticCurveTo',args:[1764,614,1713,614]},
  {command:'lineTo',args:[1574,618]},{command:'lineTo',args:[1599.25,617]},{command:'bezierCurveTo',args:[10,20,-30,40,50,-60]},{command:'closePath',args:[]},
  {command:'moveTo',args:[0,0]},{command:'lineTo',args:[-1,-2]},{command:'closePath',args:[]}];
 const d=compactGlyphPath(commands);
 // Decode relative SVG commands back to absolute points.
 const out: Array<{command:string;args:number[]}>=[];let x=0,y=0,sx=0,sy=0,letter='';
 const counts: Record<string,number>={m:2,l:2,q:4,c:6,z:0};const names: Record<string,string>={m:'moveTo',l:'lineTo',q:'quadraticCurveTo',c:'bezierCurveTo',z:'closePath'};
 for (const token of d.match(/[mlqcz]|-?\d*\.?\d+/g)!) {
  if (/[mlqcz]/.test(token)) { letter=token; if (letter==='z') { out.push({command:'closePath',args:[]}); x=sx; y=sy; } else out.push({command:names[letter],args:[]}); continue; }
  let current=out[out.length-1];
  if (current.args.length===counts[letter]) { current={command:names[letter],args:[]}; out.push(current); }
  current.args.push(Number(token));
  if (current.args.length===counts[letter]) {
   current.args=current.args.map((v,i)=>v+(i%2?y:x)); [x,y]=current.args.slice(-2);
   if (letter==='m') [sx,sy]=[x,y];
  }
 }
 assert.deepEqual(out.map(c=>({command:c.command,args:c.args.map(v=>Math.round(v*100)/100)})),commands);
 assert.ok(!d.includes(' -'));
});

test('166 Word export embeds the used paper glyphs so Word renders without the installed font', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, async () => {
 const JSZip=(await import('jszip')).default;
 const fontkit=await import('fontkit');
 const { promises: fs } = await import('node:fs');
 const { tmpdir } = await import('node:os');
 const { join } = await import('node:path');
 const dir=await fs.mkdtemp(join(tmpdir(),'paper166-docx-'));
 try {
  const answer=createAnswerDocument({templateId:template.id,title:'測試',sections:[{id:'a',heading:'一、意涵',text:'零信任（Zero Trust）架構'}]});
  const report=layoutSections(template,answer.sections);
  const file=join(dir,'a.docx');
  await exportDocx(report,template,file);
  const zip=await JSZip.loadAsync(await fs.readFile(file));
  const fontTable=await zip.file('word/fontTable.xml')!.async('string');
  // ST_Guid is uppercase; LibreOffice cannot deobfuscate a lowercase key.
  const key=fontTable.match(/w:fontKey="\{([0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12})\}"/)![1];
  assert.match(fontTable,/<w:font w:name="TW-MOE-Std-Kai">.*w:subsetted="1"/);
  assert.match(await zip.file('word/_rels/fontTable.xml.rels')!.async('string'),/Id="rId1"[^>]*Target="fonts\/font1\.odttf"/);
  // ECMA-376 font obfuscation: XOR the first 32 bytes with the GUID bytes in reverse order.
  const data=Buffer.from(await zip.file('word/fonts/font1.odttf')!.async('uint8array'));
  const bytes=key.replace(/-/g,'').match(/../g)!.reverse().map(hex=>parseInt(hex,16));
  for (let i=0;i<32;i++) data[i]^=bytes[i%16];
  const face=(fontkit as unknown as { create(data: Buffer): { familyName: string; hasGlyphForCodePoint(codePoint: number): boolean } }).create(data);
  assert.equal(face.familyName,'TW-MOE-Std-Kai');
  for (const character of Array.from(report.lines.map(line=>line.text).join(''))) assert.ok(face.hasGlyphForCodePoint(character.codePointAt(0)!),character);
  assert.ok(!face.hasGlyphForCodePoint('鬱'.codePointAt(0)!));
  assert.ok(data.length<400_000);
  assert.match(await zip.file('word/styles.xml')!.async('string'),/<w:style w:type="paragraph" w:default="1" w:styleId="Normal">.*<w:autoSpaceDE w:val="0"\/>/);
  assert.match(await zip.file('word/document.xml')!.async('string'),/<w:vAlign w:val="bottom"\/>/);
 } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
