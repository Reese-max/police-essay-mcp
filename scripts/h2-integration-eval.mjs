// Offline deterministic MCP trajectories; not model-generated answers or an effectiveness A/B.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { FileStore } from '../dist/src/storage.js';
import { createEssayMcpServer } from '../dist/src/server.js';
import { layoutSections } from '../dist/src/layout.js';
import { grade } from '../h2/grade.mjs';
import JSZip from 'jszip';
if(process.argv.includes('--help')){console.log('Run after npm run build with ESSAY_MCP_PAPER_FONT set; entirely local deterministic MCP scenarios.');process.exit(0);}
const root=process.cwd(), out=await fs.mkdtemp(path.join(root,'tmp-h2-eval-'));
const cases=[];
const seedAudit=[];
for(const expected of JSON.parse(await fs.readFile('h2/seed-layouts.json','utf8'))){
 const dir=path.join(out,'seeds',expected.seed),answerDir=path.join(dir,'answers');await fs.mkdir(answerDir,{recursive:true});
 const source=path.join(root,'h2/seeds',expected.seed,'store/answer-records');if(await fs.stat(source).catch(()=>false))await fs.cp(source,answerDir,{recursive:true});
 const store=new FileStore({templateDir:path.join(root,'templates'),answerDir,exportDir:path.join(dir,'exports')});const answers=await store.listAnswers();assert.equal(answers.length,expected.answers);
 if(answers.length){const a=answers[0],t=await store.getTemplate(a.templateId),l=layoutSections(t,a.sections,a.layoutOptions);assert.equal(a.templateId,expected.templateId);assert.equal(l.fits,expected.fits);assert.equal(l.totalLines,expected.totalLines);assert.equal(l.capacity,expected.capacity);}
 seedAudit.push({seed:expected.seed,passed:true});
}
async function scenario(name,task,seed,expected,body){
 const dir=path.join(out,name),answers=path.join(dir,'answers'),exports=path.join(dir,'exports');
 await fs.mkdir(answers,{recursive:true});await fs.mkdir(exports,{recursive:true});
 if(seed){await fs.cp(path.join(root,'h2/seeds',seed,'store/answer-records'),answers,{recursive:true});
  const exams=path.join(root,'h2/seeds',seed,'store/exam-records');if(await fs.stat(exams).catch(()=>false))await fs.cp(exams,answers+'-exams',{recursive:true});}
 const store=new FileStore({templateDir:path.join(root,'templates'),answerDir:answers,exportDir:exports});
 const s=createEssayMcpServer(store),c=new Client({name:'offline-h2-integration',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await s.connect(a);await c.connect(b);const events=[];
 const call=async(tool,args={},allowError=false)=>{const result=await c.callTool({name:tool,arguments:args});events.push({item:{id:String(events.length),type:'mcp_tool_call',tool,arguments:args,status:'completed',result}});if(!allowError)assert.notEqual(result.isError,true,JSON.stringify(result.content));return result;};
 try{await body(call,store,c);
  await fs.mkdir(path.join(dir,'h2-result'),{recursive:true});
  await promisify(execFile)(process.execPath,['h2/dump-state.mjs',root,answers,exports,path.join(dir,'h2-result/state.json')],{cwd:root,env:process.env});
  await fs.writeFile(path.join(dir,'h2-result/events.jsonl'),events.map(e=>JSON.stringify(e)).join('\n'));
  await fs.writeFile(path.join(dir,'h2-result/final.md'),'版面與檔案已檢查；內容、語義與來源尚未核實。');
  const r=await grade(dir,path.join(root,'h2/tasks',task,'check/expect.json'));assert.equal(r.code,expected,r.output);
  cases.push({name,expected,actual:r.code,grade:r.output,events:events.length});
 }finally{await c.close();await s.close();}
}
await scenario('review-only','t-boundary-verify','t-boundary-verify',0,async call=>{
 const id='ans_h2-t-boundary-verify';const before=(await call('read_answer',{answerId:id})).structuredContent;
 await call('set_answer_review',{answerId:id,expectedVersion:before.answer.version,plan:{requirements:before.answer.sections.map((s,i)=>({id:'r'+i,prompt:'Caller has not verified this synthetic source',sectionIds:[s.id]}))}});
 const after=(await call('read_answer',{answerId:id})).structuredContent;
 assert.equal(after.answer.version,2);assert.deepEqual(after.answer.sections,before.answer.sections);
 const review=(await call('review_answer',{answerId:id})).structuredContent;
 assert.equal(review.freshness,'current');assert.equal(review.semantic,'not_checked');assert.equal(review.sourceVerification,'not_checked');
});
for(const indent of [2,4])await scenario('indent-'+indent,'t-create-format',null,indent===4?0:1,async call=>{
 const task=await fs.readFile('h2/tasks/t-create-format/task.md','utf8');
 const made=(await call('create_answer',{title:'個資保護與警察勤務',sections:['一、','二、','三、'].map((heading,i)=>({id:'p'+i,heading,text:task.split(/\r?\n/).find(l=>l.startsWith(heading)).slice(heading.length),paragraphFormat:{firstLineIndent:indent}}))})).structuredContent;
 await call('check_layout',{answerId:made.answer.id});
});
for(const linked of [false,true])await scenario(linked?'resume-complete':'resume-unlinked','t-exam-resume','t-resume-exam',linked?0:1,async(call,store)=>{
 const examId='exam_resume-h2-2026';await call('get_exam_progress',{});
 await call('create_answers',{...(linked?{examId}:{}),answers:[2,3].map(n=>({questionNo:n,title:'第'+n+'題',sections:[{id:'p',heading:'一、',text:'隔離測試用的合成答案，不是官方範文。'}]}))});
 const result=await call('export_exam_bundle',{examId},!linked);
 if(!linked){assert.equal(result.isError,true);return;}
 const files=result.structuredContent.files;assert.deepEqual(files.map(f=>f.format).sort(),['docx','pdf']);
 const expected=(await store.listAnswers()).flatMap(a=>a.sections.map(s=>s.text)).map(s=>s.replace(/\s/g,''));
 for(const f of files){const artifact=await store.readExport(f.exportUri.split('/').at(-1));assert.ok(artifact.data.length>0);assert.ok(f.format==='pdf'?artifact.data.subarray(0,5).toString()==='%PDF-':artifact.data[0]===0x50&&artifact.data[1]===0x4b);
  let text;
  if(f.format==='docx'){const zip=await JSZip.loadAsync(artifact.data),xml=await zip.file('word/document.xml').async('string');text=Array.from(xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/gs),m=>m[1]).join('');}
  else{const file=path.join(out,'checked-bundle.pdf');await fs.writeFile(file,artifact.data);text=(await promisify(execFile)('pdftotext',['-enc','UTF-8',file,'-'])).stdout;}
  for(const s of expected)assert.ok(text.replace(/\s/g,'').includes(s),'export lost source text: '+f.format);
 }
});
await fs.writeFile(path.join(out,'summary.json'),JSON.stringify({kind:'deterministic actual in-memory MCP; no model calls',seedAudit,cases},null,2));
console.log(JSON.stringify({out,seedAudit,cases}));
