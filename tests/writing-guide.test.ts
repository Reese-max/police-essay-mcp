import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {FileStore} from '../src/storage.js';
import {createEssayMcpServer} from '../src/server.js';
import {writingGuide} from '../src/writing-guide.js';
import {APPLICABILITY_INSTRUCTION,MATERIAL_BOUNDARY_INSTRUCTION} from '../src/essay-instructions.js';

test('static guide exposes three stages and five labeled examples without creating model results',()=>{
 const a=writingGuide();assert.deepEqual(Object.keys(a.stages),['draft','compress','review']);assert.equal(a.examples.length,5);
 assert.equal(a.limits.automaticSemanticVerification,false);assert.equal(a.limits.automaticSourceVerification,false);
 assert.equal(a.limits.paperCapacityLines,44);assert.ok(a.saveInstructions.includes('callerNote'));
 assert.equal(a.version,'essay-guide-20261111.1');assert.equal(a.applicability,APPLICABILITY_INSTRUCTION);assert.equal(a.materialBoundaries,MATERIAL_BOUNDARY_INSTRUCTION);
 a.issueNoteTemplate.sectionIds.push('not-a-real-finding');(a.examples[0] as {teachingExample:string}).teachingExample='altered caller copy';
 assert.equal(writingGuide().issueNoteTemplate.sectionIds.length,1);assert.notEqual(String(writingGuide().examples[0].teachingExample),'altered caller copy');
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
