import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {FileStore} from '../src/storage.js';
import {createEssayMcpServer} from '../src/server.js';
import {writingGuide} from '../src/writing-guide.js';
import {WRITING_RULES_INSTRUCTION} from '../src/essay-instructions.js';

test('static guide exposes three stages without caller-only boundary or teaching-example fields',()=>{
 const a=writingGuide() as any;assert.deepEqual(Object.keys(a.stages),['draft','compress','review']);
 assert.equal(a.limits.automaticSemanticVerification,false);assert.equal(a.limits.automaticSourceVerification,false);
 assert.equal(a.limits.paperCapacityLines,44);assert.ok(a.saveInstructions.includes('callerNote'));
 assert.equal(a.version,'essay-guide-20261119.1');assert.equal(a.writingRules,WRITING_RULES_INSTRUCTION);assert.ok(a.stages.draft.startsWith('依 writingRules 起草'));
 for(const key of ['applicability','materialBoundaries','taskBoundaries','examples','examplesLabel'])assert.ok(!(key in a),key);
 a.issueNoteTemplate.sectionIds.push('not-a-real-finding');
 assert.equal(writingGuide().issueNoteTemplate.sectionIds.length,1);
});

test('existing read-only load tool serves guidance without prompts/resources or added inputs',async()=>{
 const store=new FileStore();const save=store.saveAnswer;store.saveAnswer=async()=>{throw new Error('guide must not write')};
 const server=createEssayMcpServer(store,{readOnly:true}),client=new Client({name:'native-guide-regression',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  const tool=(await client.listTools()).tools.find(t=>t.name==='load_exam_paper')!;
  assert.deepEqual(Object.keys(tool.inputSchema.properties??{}).sort(),['answerId','templateId']);
  assert.equal(tool.annotations?.readOnlyHint,true);
  const r=CallToolResultSchema.parse(await client.callTool({name:'load_exam_paper',arguments:{templateId:'police_information_essay'}}));
  assert.equal(r.isError,undefined);assert.deepEqual(r.structuredContent?.writingGuide,writingGuide());
  assert.ok(r.content.some(c=>c.type==='text'&&c.text.includes('writingGuide')));
  const bad=CallToolResultSchema.parse(await client.callTool({name:'load_exam_paper',arguments:{templateId:'does-not-exist'}}));
  assert.equal(bad.isError,true);assert.equal(bad.structuredContent?.writingGuide,undefined);
 }finally{store.saveAnswer=save;await client.close();await server.close();}
});

test('create tools return actionable format notes, including idempotent replays',async()=>{
 const server=createEssayMcpServer(new FileStore()),client=new Client({name:'create-guidance-regression',version:'1'});
 const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
 try{
  await client.listTools();
  const bad={templateId:'police_information_essay',title:'bad headings',idempotencyKey:'bad-headings-test',sections:[
   {id:'intro',heading:'壹、前言',text:'內容。'},
   {id:'body',heading:'貳、本文',text:'內容。'},
   {id:'end',heading:'參、結論',text:'內容。'},
  ]};
  const created=CallToolResultSchema.parse(await client.callTool({name:'create_answer',arguments:bad}));
  assert.equal(created.isError,undefined);
  const notes=created.structuredContent?.qualityNotes as string[];
  assert.ok(notes.some(note=>note.includes('功能標籤')));
  assert.ok(notes.some(note=>note.includes('不用「壹、」')));
  assert.ok(notes.every(note=>/^(格式提醒|結構提醒)/u.test(note)));
  const text=created.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  assert.ok(text.endsWith(notes.join('\n')));
  const replay=CallToolResultSchema.parse(await client.callTool({name:'create_answer',arguments:bad}));
  assert.equal(replay.structuredContent?.replayed,true);
  assert.deepEqual(replay.structuredContent?.qualityNotes,notes);
  const clean=CallToolResultSchema.parse(await client.callTool({name:'create_answer',arguments:{templateId:'police_information_essay',title:'clean headings',sections:[
   {id:'intro',text:'甲'.repeat(30)},
   {id:'body',heading:'(一)題目要點：',text:'乙'.repeat(30)},
   {id:'end',text:'丙'.repeat(30)},
  ]}}));
  assert.equal(clean.isError,undefined);
  assert.ok(!('qualityNotes' in (clean.structuredContent??{})));
  const batch=CallToolResultSchema.parse(await client.callTool({name:'create_answers',arguments:{answers:[{...bad,idempotencyKey:'batch-bad-headings-test'}]}}));
  assert.equal(batch.isError,undefined);
  const batchNotes=(batch.structuredContent?.answers as any[])[0].qualityNotes as string[];
  assert.ok(batchNotes.some(note=>note.includes('功能標籤')));
  assert.ok(batchNotes.some(note=>note.includes('不用「壹、」')));
  const batchText=batch.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  assert.ok(batchText.includes(batchNotes.join('\n')));
  const batchReplay=CallToolResultSchema.parse(await client.callTool({name:'create_answers',arguments:{answers:[{...bad,idempotencyKey:'batch-bad-headings-test'}]}}));
  assert.deepEqual((batchReplay.structuredContent?.answers as any[])[0].qualityNotes,batchNotes);
 }finally{await client.close();await server.close();}
});
