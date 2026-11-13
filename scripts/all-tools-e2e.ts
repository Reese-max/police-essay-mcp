// Opt-in local-only acceptance. Never connects this mutating suite to an external service.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHttpHandler} from '../src/index.js';
import {FileStore} from '../src/storage.js';
import {success,verifyExports} from './e2e-support.js';

const root=await fs.mkdtemp(path.resolve('tmp-all-tools-'));
console.log('ALL_TOOLS_REPORT',root);
const marker=`ALL-TOOLS-${randomUUID()}`;
const store=new FileStore({templateDir:path.resolve('templates'),answerDir:path.join(root,'answers'),exportDir:path.join(root,'exports')});
await store.ensureDirectories();
const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
server.on('request',createHttpHandler(store,{HOST:'127.0.0.1',PORT:String(address.port),AUTH_MODE:'bearer',MCP_ALLOW_ANONYMOUS_LOOPBACK:'true'}));
const client=new Client({name:'all-tools-local-acceptance',version:'1'});
const log:any={root,marker,base,localOnly:true,cases:[],resources:[],prompts:[],cleanup:'pending',uiVisual:'not_tested',semanticQuality:'not_tested'};
const save=()=>fs.writeFile(path.join(root,'acceptance.json'),JSON.stringify(log,null,2));
const passed=new Set<string>();let failure:unknown;
async function reject(name:string,args:Record<string,unknown>,kind:string){
    let rejected=false;let message='';
    try{const r=await client.callTool({name,arguments:args});rejected=r.isError===true;message=JSON.stringify(r.content);}catch(e){rejected=true;message=String(e);}
    const valid=rejected&&(kind!=='version_conflict'||/Version conflict|VERSION_CONFLICT|版本衝突/.test(message));
    log.cases.push({name,kind,status:valid?'passed':'failed',message});await save();assert.ok(valid,`${name}: ${kind} did not produce the expected rejection`);
}
async function call(name:string,args:Record<string,unknown>={}){
    try{
        const r=await client.callTool({name,arguments:args});const sc=success(r,name);
        passed.add(name);log.cases.push({name,kind:'success',status:'passed'});await save();return sc;
    }catch(error){log.cases.push({name,kind:'success',status:'failed',error:String(error)});await save();throw error;}
}
async function version(id:string){return (await call('read_answer',{answerId:id})).answer.version as number;}
async function change(name:string,id:string,args:Record<string,unknown>){
    const v=await version(id);
    await reject(name,{answerId:id,expectedVersion:v+100,...args},'version_conflict');
    assert.equal(await version(id),v,'rejected operation mutated answer');
    return call(name,{answerId:id,expectedVersion:v,...args});
}
try{
    await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
    log.instructions=client.getInstructions();log.tools=(await client.listTools()).tools;
    await save();
    await call('list_templates');const guide=await call('load_exam_paper');assert.equal(guide.template.id,'police_information_essay_165');assert.ok(guide.writingGuide.version);
    const start={title:marker,idempotencyKey:marker,questions:[{questionNo:1},{questionNo:2}]};
    const plan=await call('start_exam',start);assert.equal((await call('start_exam',start)).examId,plan.examId);
    await reject('start_exam',{...start,title:marker+'-changed'},'idempotency_misuse');
    const sections=[{id:'a',heading:'1. One',text:'Synthetic alpha reference.'},{id:'b',heading:'3. Two',text:'Synthetic beta comparison.'}];
    const create={title:marker+'-1',templateId:'police_information_essay',examId:plan.examId,questionNo:1,idempotencyKey:marker+'-1',sections};
    const one=await call('create_answer',create);const id=one.answer.id;
    assert.equal((await call('create_answer',create)).answer.id,id,'idempotent replay');
    await reject('create_answer',{...create,title:marker+'-changed'},'idempotency_misuse');
    await reject('create_answer',{templateId:'missing-template'},'missing_template');
    const batch={examId:plan.examId,answers:[{title:marker+'-2',templateId:'police_information_essay',questionNo:2,idempotencyKey:marker+'-2',sections}]};
    const created=await call('create_answers',batch);assert.deepEqual((await call('create_answers',batch)).answers.map((a:any)=>a.answerId),created.answers.map((a:any)=>a.answerId));
    await call('list_answers');await call('get_exam_progress',{examId:plan.examId});
    await reject('delete_exam',{examId:plan.examId,expectedVersion:(await call('get_exam_progress',{examId:plan.examId})).version},'nonempty_exam');
    await call('load_exam_paper',{answerId:id});
    await change('write_answer',id,{sections});
    const pv=await version(id);await change('preview_change',id,{operation:'edit_text',edits:[{find:'alpha',replace:'alpha-preview'}]});assert.equal(await version(id),pv);
    await change('edit_text',id,{edits:[{find:'alpha',replace:'alpha-edited'}]});
    await change('replace_text',id,{sectionId:'b',newText:'Synthetic beta replacement.'});
    await change('replace_texts',id,{replacements:[{sectionId:'a',newText:'Synthetic alpha-edited batch.'},{sectionId:'b',newText:'Synthetic beta batch.'}]});
    await change('insert_text',id,{section:{id:'tail',text:'Synthetic temporary tail.'}});
    await change('format_section',id,{sectionId:'tail',paragraphFormat:{firstLineIndent:1}});
    await change('move_section',id,{sectionId:'b',beforeSectionId:'a'});
    await change('renumber_items',id,{});
    await change('delete_text',id,{sectionId:'tail'});
    await change('set_line_targets',id,{targets:[{sectionId:'a',lines:3}]});
    await change('update_answer_info',id,{title:marker+'-renamed'});
    const reviewPlan={requirements:[{id:'r1',prompt:'Explain alpha',sectionIds:['a'],points:2},{id:'r2',prompt:'Compare beta',sectionIds:[],points:3}],scoring:{total:4,mode:'additive'}};
    await change('set_answer_review',id,{plan:reviewPlan});
    let review=await change('review_answer',id,{});assert.equal(review.semantic,'not_checked');assert.ok(review.issues.some((i:any)=>i.code==='REQUIRED_UNCOVERED'));assert.equal(review.scoring.status,'conflict');
    await change('edit_text',id,{edits:[{find:'alpha-edited',replace:'alpha-revised'}]});
    review=await call('review_answer',{answerId:id,expectedVersion:await version(id)});assert.equal(review.freshness,'stale');
    reviewPlan.requirements[1].sectionIds=['b'];reviewPlan.scoring.total=5;
    await change('set_answer_review',id,{plan:reviewPlan});review=await call('review_answer',{answerId:id});assert.equal(review.scoring.status,'consistent');assert.equal(review.semantic,'not_checked');
    await call('check_layout',{answerId:id});await call('render_answer_sheet',{answerId:id});await call('render_exam_overview',{examId:plan.examId});
    await call('list_revisions',{answerId:id});
    await change('restore_revision',id,{version:1});
    const restored=(await call('read_answer',{answerId:id})).answer;
    const targetsRestored=Object.keys(restored.lineTargets??{}).length===0;
    log.cases.push({name:'restore_revision',kind:'restores_original_line_targets',status:targetsRestored?'passed':'failed',expected:{},actual:restored.lineTargets??{},relatedOpenPR:47});
    const copy=await call('duplicate_answer',{answerId:id,title:marker+'-copy'});assert.equal(copy.answer.version,1);assert.notEqual(copy.answer.id,id);
    const answer=(await call('read_answer',{answerId:id})).answer;
    const expected=answer.sections.flatMap((s:any)=>[s.heading,s.text]).filter(Boolean);
    const files=await change('export_answer',id,{formats:['pdf','docx','txt']});
    log.exports=await verifyExports(files,['pdf','docx','txt'],expected,{base,headers:{},readResource:a=>client.readResource(a)});
    await reject('export_exam_bundle',{answers:[{answerId:id,expectedVersion:(await version(id))+100}]},'version_conflict');
    const bundle=await call('export_exam_bundle',{examId:plan.examId});
    log.bundleExports=await verifyExports(bundle,['pdf','docx'],['Synthetic'],{base,headers:{},readResource:a=>client.readResource(a)});
    log.exportUris=[...files.files,...bundle.files].map((f:any)=>f.exportUri);
    const completed=await call('get_exam_progress',{examId:plan.examId});
    assert.equal(completed.nextStep.action,'done');assert.equal(completed.delivery.status,'awaiting_review');
    log.deliveryAfterBundle={nextStep:completed.nextStep,delivery:completed.delivery};
    for(const resource of (await client.listResources()).resources){const r=await client.readResource({uri:resource.uri});assert.ok(r.contents.length);log.resources.push({uri:resource.uri,status:'passed'});}
    for(const p of (await client.listPrompts()).prompts){const args=Object.fromEntries((p.arguments??[]).filter(a=>a.required).map(a=>[a.name,a.name==='answerId'?id:'Synthetic question']));const r=await client.getPrompt({name:p.name,arguments:args});assert.ok(r.messages.length);log.prompts.push({name:p.name,status:'passed',response:r});}
    for(const tool of log.tools){if(tool.inputSchema.required?.length)await reject(tool.name,{},'required_input');else log.cases.push({name:tool.name,kind:'required_input',status:'not_applicable',reason:'no required fields; domain errors recorded separately'});}
    await reject('load_exam_paper',{templateId:'missing-template'},'missing_template');
    for(const missing of ['export_pdf','export_docx','export_text','reflow_answer'])await reject(missing,{answerId:id},'removed_legacy_tool');
    const priorItalic=process.env.ESSAY_MCP_PDF_ITALIC_FONT;
    try{
        delete process.env.ESSAY_MCP_PDF_ITALIC_FONT;
        await change('replace_text',id,{sectionId:'a',newText:'合成中文字斜體測試。'});
        await change('format_section',id,{sectionId:'a',paragraphFormat:{italic:true}});
        const overview=await call('render_exam_overview',{examId:plan.examId});
        const probe=await call('export_answer',{answerId:id,expectedVersion:await version(id),formats:['pdf']});
        assert.ok(probe.files[0].fontWarning,'unavailable italic font must be reported');
        log.fontProbe={italicRequested:true,italicFontConfigured:false,layoutWarningCount:overview.warningCount,fontWarning:probe.files[0].fontWarning,scope:'overview counts layout warnings; PDF exporter reports font fallback separately'};
        await verifyExports(probe,['pdf'],['合成中文字斜體測試。'],{base,headers:{},readResource:a=>client.readResource(a),save:async(f,b)=>{await fs.writeFile(path.join(root,`italic-probe.${f}`),b);}});
        log.exportUris.push(...probe.files.map((f:any)=>f.exportUri));
    }finally{if(priorItalic===undefined)delete process.env.ESSAY_MCP_PDF_ITALIC_FONT;else process.env.ESSAY_MCP_PDF_ITALIC_FONT=priorItalic;}
    await change('delete_answer',copy.answer.id,{userRequest:'請永久刪除這題答案'});
}catch(e){failure=e;log.failure=String(e);}
finally{
    // This store is freshly created by this process and never receives external inputs.
    try{
        for(const a of await store.listAnswers()){assert.ok(a.title.startsWith(marker));await call('delete_answer',{answerId:a.id,expectedVersion:a.version,userRequest:'請永久刪除這題答案'});}
        for(const p of await store.listExams()){assert.equal(p.title,marker);await reject('delete_exam',{examId:p.id,expectedVersion:p.version+100},'version_conflict');await call('delete_exam',{examId:p.id,expectedVersion:p.version});}
        assert.equal((await store.listAnswers()).length,0);assert.equal((await store.listExams()).length,0);log.cleanup='passed';
        log.exportCleanup=[];
        for(const uri of log.exportUris??[]){await assert.rejects(client.readResource({uri}),/Export artifact not found/);log.exportCleanup.push({uri,status:'passed'});}
        assert.equal((await call('list_answers')).answers.length,0,'MCP must remain reachable after resource revocation');
    }catch(e){log.cleanup='failed';log.cleanupError=String(e);failure??=e;}
    log.matrix=(log.tools??[]).map((t:any)=>({name:t.name,success:passed.has(t.name)?'passed':log.cases.some((c:any)=>c.name===t.name&&c.kind==='success'&&c.status==='failed')?'failed':'not_tested',negative:log.cases.filter((c:any)=>c.name===t.name&&c.kind!=='success')}));
    if(log.matrix.some((r:any)=>r.success!=='passed'))failure??=Error('not all advertised tools have positive acceptance evidence');
    if(log.cases.some((c:any)=>c.status==='failed'))failure??=Error('behavioral acceptance failed; see matrix');
    log.success=!failure;await save();await client.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
}
if(failure)throw failure;
console.log(JSON.stringify({tools:log.matrix.length,successPaths:passed.size,cases:log.cases.length,resources:log.resources.length,prompts:log.prompts.length,revokedExports:log.exportCleanup.length,cleanup:log.cleanup}));
console.log('ALL_TOOLS_E2E_OK',root);
