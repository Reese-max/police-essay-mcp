import assert from 'node:assert/strict';import {test} from 'node:test';import fs from 'node:fs/promises';import {existsSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import {inflateSync} from 'node:zlib';
import JSZip from 'jszip';import {FileStore} from '../src/storage.js';import {createAnswerDocument} from '../src/domain.js';import {layoutSections} from '../src/layout.js';import {exportPdf,exportDocx} from '../src/exporters.js';
const font=['C:/Windows/Fonts/NotoSansTC-VF.ttf','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'].find(existsSync);
const streams=(b:Buffer)=>[...b.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)].map(m=>{try{return inflateSync(Buffer.from(m[1],'latin1')).toString('latin1');}catch{return '';}}).join('\n');
test('synthetic italic is opt-in, explicit, PDF-only and reports aligned ink risk',{skip:!font},async()=>{
 const keys=['ESSAY_MCP_PDF_FONT','ESSAY_MCP_PDF_ITALIC_FONT','ESSAY_MCP_PDF_SYNTHETIC_ITALIC'] as const,old=keys.map(k=>process.env[k]),dir=await fs.mkdtemp(path.join(os.tmpdir(),'synthetic-italic-'));
 try{process.env.ESSAY_MCP_PDF_FONT=font;delete process.env.ESSAY_MCP_PDF_ITALIC_FONT;delete process.env.ESSAY_MCP_PDF_SYNTHETIC_ITALIC;
 const t=await new FileStore().getTemplate('police_information_essay'),a=createAnswerDocument({title:'test',templateId:t.id,sections:[{id:'p',text:'繁體中文 ASCII 混排。',paragraphFormat:{italic:true,alignment:'right'}}]}),l=layoutSections(t,a.sections),saved=JSON.stringify(l);
 const off=await exportPdf(l,t,path.join(dir,'off.pdf')),doc1=await exportDocx(l,t,path.join(dir,'off.docx'));assert.match(off.fontWarning??'',/斜體/);assert.ok(!streams(await fs.readFile(off.path)).includes('1 0 -0.212557 1'));
 process.env.ESSAY_MCP_PDF_SYNTHETIC_ITALIC='true';const on=await exportPdf(l,t,path.join(dir,'on.pdf')),doc2=await exportDocx(l,t,path.join(dir,'on.docx'));assert.equal(on.pages,off.pages);assert.match(on.fontWarning??'',/合成斜體/);assert.match(on.fontWarning??'',/12 度/);assert.match(on.fontWarning??'',/超出/);assert.ok(streams(await fs.readFile(on.path)).includes('1 0 -0.212557 1'));assert.equal(JSON.stringify(l),saved);
 const xml=async(p:string)=>(await JSZip.loadAsync(await fs.readFile(p))).file('word/document.xml')!.async('string');assert.equal(await xml(doc1.path),await xml(doc2.path));
 }finally{keys.forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]);await fs.rm(dir,{recursive:true,force:true});}
});
test('Latin-only configured italic font cannot silently replace Chinese with missing glyphs',{skip:!font||!existsSync('C:/Windows/Fonts/NotoSans-Italic.ttf')},async()=>{
 const keys=['ESSAY_MCP_PDF_FONT','ESSAY_MCP_PDF_ITALIC_FONT','ESSAY_MCP_PDF_SYNTHETIC_ITALIC'] as const,old=keys.map(k=>process.env[k]),dir=await fs.mkdtemp(path.join(os.tmpdir(),'italic-coverage-'));
 try{process.env.ESSAY_MCP_PDF_FONT=font;process.env.ESSAY_MCP_PDF_ITALIC_FONT='C:/Windows/Fonts/NotoSans-Italic.ttf';delete process.env.ESSAY_MCP_PDF_SYNTHETIC_ITALIC;
 const t=await new FileStore().getTemplate('police_information_essay'),a=createAnswerDocument({templateId:t.id,title:'test',sections:[{id:'p',text:'繁體中文不可缺字',paragraphFormat:{italic:true}}]});const r=await exportPdf(layoutSections(t,a.sections),t,path.join(dir,'out.pdf'));assert.match(r.fontWarning??'',/斜體/);
 }finally{keys.forEach((k,i)=>old[i]===undefined?delete process.env[k]:process.env[k]=old[i]);await fs.rm(dir,{recursive:true,force:true});}
});
