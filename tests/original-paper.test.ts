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
 assert.ok(pages.every(svg=>svg.includes('data:image/jpeg;base64,')&&svg.includes('<path d=')));
 assert.ok(pages.every(svg=>!svg.includes('<text')));
});
