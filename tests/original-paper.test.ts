import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { templateSchema, createAnswerDocument } from '../src/domain.js';
import { layoutSections } from '../src/layout.js';
import { originalPaper, originalPaperImage, wrapOriginalPaper, originalPaperMeasure, originalPaperAvailableWidth } from '../src/original-paper.js';
import { layoutWarnings } from '../src/planning.js';
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

test('166 whole Latin words use measured next-line width and preserve punctuation carry', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, () => {
 let foundWord = false, foundPunctuation = false, foundSpace = false;
 for (let count = 0; count < 50; count++) {
  const text = '前'.repeat(count) + ' Zero Trust Redundancy，完成。';
  const off = wrapOriginalPaper(text,format,template);
  const on = wrapOriginalPaper(text,format,template,{wholeLatinWords:true});
  assert.equal(off.join(''),text); assert.equal(on.join(''),text);
  if (!off.some(line=>line.includes('Redundancy'))) {
   foundWord = true; assert.ok(on.some(line=>line.includes('Redundancy')));
  }
  const punct = '前'.repeat(count) + 'Redundancy。';
  const punctOff = wrapOriginalPaper(punct,format,template);
  const punctOn = wrapOriginalPaper(punct,format,template,{wholeLatinWords:true});
  assert.equal(punctOn.join(''),punct); assert.ok(punctOn.every(line=>line!=='。'));
  if (punctOff.some((line,index)=>/[A-Za-z]$/.test(line) && /^[A-Za-z]/.test(punctOff[index+1]??''))) {
   foundPunctuation = true; assert.ok(punctOn.some(line=>line.includes('Redundancy')));
  }
  const spaced = 'W'.repeat(count) + ' Hello';
  const spacedOff = wrapOriginalPaper(spaced,format,template);
  if (spacedOff.length===2 && (spacedOff[0].endsWith(' ') || spacedOff[1].startsWith(' '))) {
   foundSpace = true; assert.deepEqual(wrapOriginalPaper(spaced,format,template,{wholeLatinWords:true}),spacedOff);
  }
 }
 assert.ok(foundWord); assert.ok(foundPunctuation); assert.ok(foundSpace);
 const long = 'W'.repeat(200);
 const off = wrapOriginalPaper(long,format,template), on = wrapOriginalPaper(long,format,template,{wholeLatinWords:true});
 assert.ok(on.length>1); assert.equal(on.join(''),long); assert.deepEqual(on,off);
});
test('166 exports reject 45 lines even when an overflow override is requested', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, async () => {
 const answer=createAnswerDocument({templateId:template.id,title:'測試',sections:[{text:Array(45).fill('甲').join('\n')}]});
 const report=layoutSections(template,answer.sections);
 assert.equal(report.totalLines,45);assert.equal(report.fits,false);
 await assert.rejects(exportDocx(report,template,'unused.docx',true),/兩頁44行/);
 await assert.rejects(exportPdf(report,template,'unused.pdf'),/兩頁44行/);
});

test('166 full-run lookahead avoids oversized and whitespace-only moves, including punctuation carry', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, () => {
 const measure=originalPaperMeasure(template), available=originalPaperAvailableWidth(format,template);
 let count=1;
 while(measure('W'.repeat(count+1))<=available) count++;
 const word='W'.repeat(count);
 for(const text of ['ab '+'W'.repeat(count+5),'  '+word,'ab '+word+'。']) {
  const off=wrapOriginalPaper(text,format,template), on=wrapOriginalPaper(text,format,template,{wholeLatinWords:true});
  assert.deepEqual(on,off,text); assert.equal(on.join(''),text);
  assert.ok(on.every((line,index)=>measure(line)<=originalPaperAvailableWidth(format,template,index)));
 }
 assert.deepEqual(wrapOriginalPaper('ab '+word,format,template,{wholeLatinWords:true}),['ab ',word]);
 let punctCount=count;
 while(measure('W'.repeat(punctCount)+'。')>available) punctCount--;
 const punctWord='W'.repeat(punctCount);
 const following='前前 '+punctWord+'。'+'Z'.repeat(count+5);
 const followingLines=wrapOriginalPaper(following,format,template,{wholeLatinWords:true});
 assert.equal(followingLines.join(''),following);
 assert.ok(followingLines.some(line=>line.includes(punctWord+'。')),'the next word after punctuation is a separate run');
 // Width checks must honor the next line's left/right indents as well.
 const indented={...format,leftIndent:4,rightIndent:3,firstLineIndent:2};
 const long='ab '+'W'.repeat(count);
 assert.deepEqual(wrapOriginalPaper(long,indented,template,{wholeLatinWords:true}),wrapOriginalPaper(long,indented,template));
});

test('166 split warnings use full-run font widths and non-first-line available width', {skip:!process.env.ESSAY_MCP_PAPER_FONT}, () => {
 const measure=originalPaperMeasure(template);
 for(const character of ['W','i','1']) {
  const indented={...format,leftIndent:2,rightIndent:3,firstLineIndent:4};
  const available=originalPaperAvailableWidth(indented,template);
  let count=1;
  while(measure(character.repeat(count+1))<=available) count++;
  for(const [length,expected] of [[count,/wholeLatinWords=true/],[count*3,/長於一行/]] as const) {
   const text='前 '+character.repeat(length);
   const answer=createAnswerDocument({templateId:template.id,title:'量測',sections:[{text,paragraphFormat:indented}]});
   const report=layoutSections(template,answer.sections);
   assert.equal(report.lines.map(line=>line.text).join(''),text);
   const warnings=layoutWarnings(report,template);
   assert.ok(warnings.length>0);
   assert.ok(warnings.every(warning=>expected.test(warning.message)),`${character} x ${length}`);
   assert.ok(warnings.every(warning=>/不阻擋匯出/.test(warning.message)));
  }
 }
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
