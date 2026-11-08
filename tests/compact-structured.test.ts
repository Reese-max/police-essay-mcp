import assert from 'node:assert/strict';import {test} from 'node:test';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {FileStore} from '../src/storage.js';import {createEssayMcpServer} from '../src/server.js';import {layoutSections} from '../src/layout.js';import {createAnswerDocument,answerDocumentSchema,paragraphFormatSchema} from '../src/domain.js';import {encodeAnswer,decodeAnswer} from '../src/answer-codec.js';import {z} from 'zod';import {originalPaperMeasure,originalPaperAvailableWidth} from '../src/original-paper.js';
test('structured paper create compacts heading and blanks, while general, explicit opt-out and old answers keep their layout',{skip:!process.env.ESSAY_MCP_PAPER_FONT},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'compact-structured-'));const store=new FileStore({templateDir:path.resolve('templates'),answerDir:path.join(root,'answers'),exportDir:path.join(root,'exports')});
 const s=createEssayMcpServer(store),c=new Client({name:'compact-input',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await s.connect(a);await c.connect(b);
 const call=async(n:string,args:any)=>{const r=await c.callTool({name:n,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r.content));return r.structuredContent as any;};
 const sections=[{id:'intro',heading:'壹、前言',text:'\n依職務需求配置權限。\n'}];
 try{
  for(const templateId of ['police_information_essay_165','police_information_essay_166']){
   const made=await call('create_answer',{templateId,title:'synthetic structured',sections,responseDetail:'full'});assert.equal(made.layout.totalLines,1);assert.equal(made.answer.layoutOptions?.compactPaper,true);
   const full=await call('read_answer',{answerId:made.answer.id});assert.equal(full.layout.lines[0].text,'壹、前言：依職務需求配置權限。');assert.equal(full.answer.sections[0].heading,'壹、前言');assert.equal(full.answer.sections[0].text,sections[0].text,'persist source unmodified');
   assert.equal(full.layout.lines[0].paragraphIndex,2,'keep original body position after filtering blank paragraph');
   const off=await call('create_answer',{templateId,title:'explicit standalone',sections,layoutOptions:{compactPaper:false}});assert.equal(off.layout.totalLines,4);
  }
  const general=await call('create_answer',{templateId:'police_information_essay',title:'general unchanged',sections});assert.equal(general.layout.totalLines,4);
  const old=createAnswerDocument({templateId:'police_information_essay_165',title:'legacy',sections});await store.saveAnswer(old);assert.equal((await call('read_answer',{answerId:old.id})).layout.totalLines,4);
  const plan=await call('start_exam',{title:'batch synthetic',questions:[{questionNo:1}]});await call('create_answers',{examId:plan.examId,answers:[{questionNo:1,title:'batch heading',sections}]});
  const progress=await call('get_exam_progress',{examId:plan.examId});assert.equal((await call('read_answer',{answerId:progress.questions[0].answerId})).layout.totalLines,1);
  const flagEdit=await call('create_answer',{title:'toggle',sections});await call('update_answer_info',{answerId:flagEdit.answer.id,expectedVersion:1,layoutOptions:{compactPaper:false}});assert.equal((await call('read_answer',{answerId:flagEdit.answer.id})).layout.totalLines,4);
 }finally{await c.close();await s.close();await fs.rm(root,{recursive:true,force:true});}
});
test('compact rendering preserves explicit formats, empty bodies, long headings and section boundaries',{skip:!process.env.ESSAY_MCP_PAPER_FONT},async()=>{
 const template=await new FileStore().getTemplate('police_information_essay_165');
 const run=(sections:any[],opts:any={compactPaper:true})=>{const answer=createAnswerDocument({templateId:template.id,title:'boundaries',sections});const before=structuredClone(answer);const result=layoutSections(template,answer.sections,opts);assert.deepEqual(answer,before);return result;};
 for(const section of [
  {heading:'前言',text:'\n正文\n',paragraphFormat:{spaceAfterLines:1}},
  {heading:'前言',paragraphs:[{text:'正文',format:{firstLineIndent:2}}]},
  {heading:'前言',text:'正文',headingStyle:{spaceAfterLines:1}},
 ])assert.ok(run([{id:'s',...section}]).lines.some(l=>l.isHeading));
 assert.equal(run([{id:'empty',heading:'結論',text:''}]).totalLines,2,'empty body not hidden');
 assert.equal(run([{id:'defaults',heading:'前言',text:'\n正文\n',paragraphFormat:{firstLineIndent:0,spaceAfterLines:0},headingStyle:{bold:false}}]).totalLines,1,'explicit default values are not special spacing intent');
 assert.ok(run([{id:'long',heading:'非常長的標題'.repeat(6),text:'正文'}]).lines.some(l=>l.isHeading));
 assert.ok(run([{id:'edge',heading:'標'.repeat(18),text:'正文'}]).lines.some(l=>l.isHeading),'heading must leave measured space for body');
 const latin='W'.repeat(36);const measured=originalPaperMeasure(template)(latin+'：正');const available=originalPaperAvailableWidth(paragraphFormatSchema.parse(template.paragraphDefaults),template,0);
 assert.ok(measured>available,`fixture must exceed measured width: ${measured} > ${available}`);
 assert.ok(run([{id:'wide',heading:latin,text:'正文'}]).lines.some(l=>l.isHeading),'Latin heading uses actual font width');
 assert.ok(!run([{id:'fits',heading:'W'.repeat(32),text:'正文'}]).lines.some(l=>l.isHeading),'32 W actually fit; do not reject using a guessed glyph width');
 assert.equal(run([{id:'mixed',heading:'API 比較',text:'正文'}]).lines[0].text,'API 比較：正文');
 const multi=run([{id:'a',heading:'（一）前言：',paragraphs:[{text:'\r\n第一段\r\n\r\n第二段\n'}]},{id:'b',heading:'二、結論',text:'第三段'}]);
 assert.equal(multi.totalLines,3);assert.deepEqual(multi.lines.map(l=>l.sectionId),['a','a','b']);assert.equal(multi.lines[0].text,'（一）前言：第一段');
 assert.ok(multi.lines.every(l=>l.text.trim()&&!l.isSpacer&&!l.isHeading));
 const page=run([{id:'lead',text:Array.from({length:21},()=> '前置正文').join('\n')},{id:'end',heading:'結論',text:'結論正文'}]);assert.equal(page.totalLines,22);assert.equal(page.lines.at(-1)?.page,1);
 const general=await new FileStore().getTemplate('police_information_essay');const source=createAnswerDocument({templateId:general.id,title:'general',sections:[{id:'s',heading:'前言',text:'\n正文\n'}]});assert.equal(layoutSections(general,source.sections,{compactPaper:true} as any).totalLines,4);
});
test('compact option is stored outside strict nested legacy schema and conflicts fail closed',()=>{
 const answer:any={...createAnswerDocument({templateId:'police_information_essay_165',title:'codec'}),layoutOptions:{compactPaper:true}};
 const legacy=answerDocumentSchema.extend({layoutOptions:z.strictObject({wholeLatinWords:z.boolean().optional(),keepHeadingWithNext:z.boolean().optional()}).optional()});
 const raw=encodeAnswer(answer);assert.equal((raw.layoutOptions as any).compactPaper,undefined);assert.equal(raw.layoutExtensions?.compactPaper,true);assert.ok(legacy.parse(raw));assert.deepEqual(decodeAnswer(raw),answer);
 assert.throws(()=>decodeAnswer({...raw,layoutOptions:{compactPaper:false}}),/Conflicting/);
 const prior={...raw,layoutExtensions:{...raw.layoutExtensions,future:7},futureMetadata:{retain:true}};assert.deepEqual(encodeAnswer(decodeAnswer(prior),prior),prior);
 for(const flag of [true,false,undefined]){const sample={...answer,layoutOptions:flag===undefined?{}:{compactPaper:flag}};assert.deepEqual(decodeAnswer(encodeAnswer(sample)),sample);}
 assert.equal(encodeAnswer({...answer,layoutOptions:{}},raw).layoutExtensions?.compactPaper,undefined);
 assert.throws(()=>decodeAnswer({...raw,layoutExtensions:{compactPaper:'true'}}));
});
