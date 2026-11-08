import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {FileStore} from '../src/storage.js';
import {createEssayMcpServer} from '../src/server.js';
import {layoutSections} from '../src/layout.js';
import {createAnswerDocument} from '../src/domain.js';
import {ESSAY_TEACHING_CASES,TASK_BOUNDARY_INSTRUCTION,APPLICABILITY_INSTRUCTION,MATERIAL_BOUNDARY_INSTRUCTION,REVIEW_REASONING_INSTRUCTION} from '../src/essay-instructions.js';
import {readFile} from 'node:fs/promises';

test('real MCP prompts/get, initialization and workflow expose reasoning and revision instructions',async()=>{
 const server=createEssayMcpServer(new FileStore()),client=new Client({name:'essay-prompt-regression',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const listed=(await client.listPrompts()).prompts;assert.deepEqual(listed.map(p=>p.name).sort(),['compress_answer','draft_answer']);
  for(const item of ESSAY_TEACHING_CASES){
   const r=await client.getPrompt({name:'draft_answer',arguments:{question:item.question}});const text=r.messages.map(m=>m.content.type==='text'?m.content.text:'').join('\n');
   assert.ok(text.includes(item.question));for(const fragment of ['指令動詞','沒有配分','主張','機制','比較維度','執行主體','涵攝','不自稱90分','44行','semantic/sourceVerification=not_checked'])assert.ok(text.includes(fragment),fragment);
  }
  const r=await client.getPrompt({name:'compress_answer',arguments:{answerId:'ans_prompt-case',overflowLines:'3'}});const text=r.messages.map(m=>m.content.type==='text'?m.content.text:'').join('\n');
  for(const fragment of ['ans_prompt-case','3','套話','否定','每次修改','stale','freshness=current','語義','not_checked'])assert.ok(text.includes(fragment),fragment);
  assert.ok(text.indexOf('先補漏答')<text.indexOf('依序刪除'));
  assert.ok(client.getInstructions()?.includes('不能以關鍵字出現代替語義核對'));
  const resource=await client.readResource({uri:'essay://instructions/workflow'});const workflow=resource.contents.map(c=>'text'in c?c.text:'').join('\n');
  for(const item of ESSAY_TEACHING_CASES)assert.ok(workflow.includes(item.teachingExample));assert.ok(workflow.includes('非官方高分範文'));
 }finally{await client.close();await server.close();}
});

test('actual draft/compress and initialization preserve failure-derived constraints without claiming a semantic grader',async()=>{
 const fixture=JSON.parse(await readFile(new URL(import.meta.url.includes('/dist/')?'../../tests/fixtures/essay-boundary-cases.json':'./fixtures/essay-boundary-cases.json',import.meta.url),'utf8'));
 const server=createEssayMcpServer(new FileStore()),client=new Client({name:'essay-boundary-regression',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  for(const item of fixture.cases){
   const input=`${item.question}\n材料：${item.material}`;
   const response=await client.getPrompt({name:'draft_answer',arguments:{question:input}});
   const text=response.messages.map(m=>m.content.type==='text'?m.content.text:'').join('\n');
   assert.ok(text.includes(input),'original question and constraints retained');assert.ok(text.includes(TASK_BOUNDARY_INSTRUCTION));
  }
  const response=await client.getPrompt({name:'compress_answer',arguments:{answerId:'ans_boundary-case'}});
  assert.ok(response.messages.some(m=>m.content.type==='text'&&m.content.text.includes(TASK_BOUNDARY_INSTRUCTION)));
  assert.ok(client.getInstructions()?.includes(TASK_BOUNDARY_INSTRUCTION));
  assert.equal(fixture.cases[0].independentActionsInBad.length,3);assert.equal(fixture.cases[0].limits.maxIndependentActions,2);
 }finally{await client.close();await server.close();}
});

test('prompt changes retain actual 165/166 geometry and 44/45-line overflow behavior',{skip:!process.env.ESSAY_MCP_PAPER_FONT},async()=>{
 const store=new FileStore();const reports=[];
 for(const id of ['police_information_essay_165','police_information_essay_166']){
  const t=await store.getTemplate(id);assert.equal(t.pages*t.linesPerPage,44);
  const make=(count:number)=>createAnswerDocument({templateId:id,title:'isolated prompt regression',sections:[{id:'body',text:Array(count).fill('甲').join('\n')}]}).sections;
  const exact=layoutSections(t,make(44));assert.equal(exact.fits,true);assert.equal(exact.totalLines,44);
  const overflow=layoutSections(t,make(45));assert.equal(overflow.fits,false);assert.equal(overflow.overflowLines,1);reports.push(exact);
 }
 assert.deepEqual(reports[1],{...reports[0],templateId:'police_information_essay_166'});
});

test('real prompts carry source applicability and material boundaries once, preserving supplied facts',async()=>{
 const file=import.meta.url.includes('/dist/')?'../../tests/fixtures/source-scope-cases.json':'./fixtures/source-scope-cases.json';
 const fixture=JSON.parse(await readFile(new URL(file,import.meta.url),'utf8'));
 const server=createEssayMcpServer(new FileStore()),client=new Client({name:'source-scope-regression',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  for(const item of fixture.cases){
   const input=`${item.question}\n材料：${item.material}`;const r=await client.getPrompt({name:'draft_answer',arguments:{question:input}});
   const text=r.messages.map(m=>m.content.type==='text'?m.content.text:'').join('\n');assert.ok(text.includes(input));
   assert.equal(text.split(APPLICABILITY_INSTRUCTION).length-1,1);assert.equal(text.split(MATERIAL_BOUNDARY_INSTRUCTION).length-1,1);
   assert.ok(text.endsWith(REVIEW_REASONING_INSTRUCTION));
  }
  const r=await client.getPrompt({name:'compress_answer',arguments:{answerId:'ans_source-scope'}});
  assert.ok(r.messages.some(m=>m.content.type==='text'&&m.content.text.includes(MATERIAL_BOUNDARY_INSTRUCTION)));
 }finally{await client.close();await server.close();}
});
