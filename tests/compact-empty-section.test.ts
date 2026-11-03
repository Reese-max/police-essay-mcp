import assert from 'node:assert/strict';import {test} from 'node:test';import {promises as fs} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';import {FileStore} from '../src/storage.js';import {createEssayMcpServer} from '../src/server.js';import {createAnswerDocument} from '../src/domain.js';import {layoutSections} from '../src/layout.js';
test('compact empty sections consume zero rows; explicit blanks and legacy layouts remain intact',{skip:!process.env.ESSAY_MCP_PAPER_FONT},async()=>{
 const store=new FileStore();const template=await store.getTemplate('police_information_essay_165');
 for(const empty of [{text:''},{text:' \r\n　\n'},{paragraphs:[{text:''},{text:'  '}]},{heading:'  ',text:''}]){
  const source=createAnswerDocument({templateId:template.id,title:'synthetic',sections:[{id:'a',heading:'前言',text:'正文'},{id:'gap',...empty},{id:'b',heading:'結論',text:'末句'}]});const saved=structuredClone(source);
  const compact=layoutSections(template,source.sections,{compactPaper:true});assert.equal(compact.totalLines,2);assert.ok(compact.lines.every(l=>l.text.trim()&&l.sectionId!=='gap'));assert.equal(compact.lines.filter(l=>l.sectionId==='gap').length,0);assert.deepEqual(source,saved);
  assert.ok(layoutSections(template,source.sections).totalLines>2);assert.ok(layoutSections(template,source.sections,{compactPaper:false}).lines.some(l=>l.sectionId==='gap'));
 }
 const explicit=createAnswerDocument({templateId:template.id,title:'explicit',sections:[{id:'gap',text:'',paragraphFormat:{spaceAfterLines:1}}]});assert.equal(layoutSections(template,explicit.sections,{compactPaper:true}).totalLines,2);
 const tab=createAnswerDocument({templateId:template.id,title:'blank tab',sections:[{id:'gap',text:'\t'}]});assert.equal(layoutSections(template,tab.sections,{compactPaper:true}).totalLines,0);assert.throws(()=>layoutSections(template,tab.sections),/165/,'legacy tab restriction remains');
 const allBlank=createAnswerDocument({templateId:template.id,title:'all blank',sections:[{id:'gap',text:''}]});assert.equal(layoutSections(template,allBlank.sections,{compactPaper:true}).totalLines,0);assert.equal(allBlank.sections.length,1);
 const general=await store.getTemplate('police_information_essay');assert.equal(layoutSections(general,allBlank.sections,{compactPaper:true}).totalLines,1);
 const page=createAnswerDocument({templateId:template.id,title:'boundary',sections:[{id:'lead',text:Array.from({length:21},()=> '前置正文').join('\n')},{id:'gap',text:''},{id:'end',heading:'結論',text:'正文'}]});assert.equal(layoutSections(template,page.sections,{compactPaper:true,keepHeadingWithNext:true}).totalLines,22);
 const incomplete=createAnswerDocument({templateId:template.id,title:'incomplete',sections:[{id:'p',heading:'前言',text:''}]});assert.equal(layoutSections(template,incomplete.sections,{compactPaper:true}).totalLines,2,'nonblank heading with missing body remains visible');
});
test('MCP check_layout and canvas agree on zero-row source sections without modifying their content',{skip:!process.env.ESSAY_MCP_PAPER_FONT},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'empty-section-'));const store=new FileStore({templateDir:path.resolve('templates'),answerDir:path.join(root,'answers'),exportDir:path.join(root,'exports')});const s=createEssayMcpServer(store),c=new Client({name:'empty-source-section',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await s.connect(a);await c.connect(b);
 const call=async(n:string,args:any)=>{const r=await c.callTool({name:n,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r.content));return r as any;};
 try{for(const templateId of ['police_information_essay_165','police_information_essay_166']){
  const made=(await call('create_answer',{templateId,title:'synthetic',sections:[{id:'a',heading:'前言',text:'正文'},{id:'gap',text:''},{id:'b',heading:'結論',text:'末句'}]})).structuredContent;const id=made.answer.id;
  const before=await store.getAnswer(id);assert.equal(before.sections[1].text,'');
  const check=(await call('check_layout',{answerId:id})).structuredContent;assert.equal(check.layout.totalLines,2);
  const read=(await call('read_answer',{answerId:id})).structuredContent;assert.equal(read.layout.totalLines,2);assert.ok(read.layout.lines.every((l:any)=>l.text.trim()));
  const canvas=await call('render_answer_sheet',{answerId:id,responseDetail:'full'});assert.equal(canvas.structuredContent.layout.totalLines,2);assert.ok(canvas.structuredContent.layout.lines.every((l:any)=>l.text.trim()));assert.deepEqual(await store.getAnswer(id),before);
 }}finally{await c.close();await s.close();await fs.rm(root,{recursive:true,force:true});}
});
