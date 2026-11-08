import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {FileStore} from '../src/storage.js';
import {createEssayMcpServer} from '../src/server.js';
import {writingGuide} from '../src/writing-guide.js';
import {layoutSections} from '../src/layout.js';
import {answerSectionSchema} from '../src/domain.js';

test('compact paper instruction is reachable through native guide and actual prompts/get',async()=>{
 const guide=writingGuide() as any;
 assert.ok(guide.paperLayout?.instruction.includes('sections[].heading'));
 assert.ok(guide.paperLayout?.instruction.includes('壹、前言：'));
 const server=createEssayMcpServer(new FileStore()),client=new Client({name:'compact-contract',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const loaded:any=(await client.callTool({name:'load_exam_paper',arguments:{}})).structuredContent;
  assert.deepEqual(loaded.writingGuide,guide);
  for(const name of ['draft_answer','compress_answer']){
   const prompt=await client.getPrompt({name,arguments:name==='draft_answer'?{question:'合成題，解釋控制的作用。'}:{answerId:'ans_synthetic'}});
   const body=JSON.stringify(prompt.messages);assert.ok(body.includes('sections[].heading'));assert.ok(body.includes('空白'));assert.ok(body.includes('既有'));
  }
 }finally{await client.close();await server.close();}
});

test('standalone headings and explicit blanks consume rows; inline input removes only that overhead',{skip:!process.env.ESSAY_MCP_PAPER_FONT},async()=>{
 const template=await new FileStore().getTemplate('police_information_essay_165');
 const before=['壹、前言','貳、本文','參、結論'].map((heading,i)=>answerSectionSchema.parse({id:'s'+i,order:i,heading,text:'\n依職務需求配置權限。\n'}));
 const after=before.map(s=>answerSectionSchema.parse({...s,heading:undefined,text:s.heading+'：'+s.text.trim()}));
 const snapshot=JSON.stringify(before);const old=layoutSections(template,before),compact=layoutSections(template,after);
 assert.equal(old.totalLines,12);assert.equal(compact.totalLines,3);assert.ok(compact.lines.every(l=>l.text.trim()&&!l.isHeading&&!l.isSpacer));
 assert.equal(JSON.stringify(before),snapshot,'calculation must not modify original inputs');
 const general=await new FileStore().getTemplate('police_information_essay');
 assert.equal(layoutSections(general,before).totalLines,12,'explicit spacing/heading preference remains');
});
