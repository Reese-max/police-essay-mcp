import assert from 'node:assert/strict';
import {test} from 'node:test';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createEssayMcpServer} from '../src/server.js';
import {FileStore} from '../src/storage.js';

test('overview scopes warning counts for explicit and planned exams without changing compatibility fields or answers',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'overview-warning-scope-'));
    const store=new FileStore({templateDir:path.resolve('templates'),answerDir:path.join(root,'answers'),exportDir:path.join(root,'exports')});
    const server=createEssayMcpServer(store);const client=new Client({name:'warning-scope-fixture',version:'1'});
    const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);await client.listTools();
    const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r.content));return r;};
    try{
        const plan:any=(await call('start_exam',{title:'Synthetic scope fixture',questions:[{questionNo:1}]})).structuredContent;
        const created:any=(await call('create_answer',{title:'Synthetic italic fixture',examId:plan.examId,questionNo:1,templateId:'police_information_essay',sections:[{id:'body',text:'Synthetic text.',paragraphFormat:{italic:true}}]})).structuredContent;
        const id=created.answer.id;const before=await store.getAnswer(id);
        for(const args of [{answerIds:[id]},{examId:plan.examId}])for(const detail of [{},{responseDetail:'full'}]){
            const result=await call('render_exam_overview',{...args,...detail});const sc:any=result.structuredContent;
            assert.equal(sc.warningCount,0);assert.equal(sc.examAnswers[0].warnings,0);
            const text=(result.content as Array<{text?:string}>).map(c=>c.text??'').join('\n');
            assert.match(text,/warningCount/);assert.match(text,/examAnswers\[\]\.warnings/);assert.match(text,/files\[\]\.fontWarning/);
            assert.deepEqual(await store.getAnswer(id),before,'read-only explanation must not rewrite answer or format');
        }
    }finally{await client.close();await server.close();await fs.rm(root,{recursive:true,force:true});}
});
