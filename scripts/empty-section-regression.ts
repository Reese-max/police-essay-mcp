import assert from 'node:assert/strict';import {promises as fs} from 'node:fs';import path from 'node:path';import JSZip from 'jszip';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';import {FileStore} from '../src/storage.js';import {createEssayMcpServer} from '../src/server.js';import {ESSAY_TEACHING_CASES} from '../src/essay-instructions.js';
const output=path.resolve('output/pdf/empty-section');await fs.mkdir(output,{recursive:true});
const store=new FileStore({templateDir:path.resolve('templates'),answerDir:path.resolve('tmp/empty-sections/answers'),exportDir:path.resolve('tmp/empty-sections/exports')});const s=createEssayMcpServer(store),c=new Client({name:'structured-paper-export',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await s.connect(a);await c.connect(b);
const call=async(name:string,args:any)=>{const r=await c.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r.content));return r.structuredContent as any;};const out:any={synthetic:true,cases:[]};
try{
 const baseSections=ESSAY_TEACHING_CASES.filter(x=>x.id!=='dual_compression').map((x,i)=>({id:x.id,heading:['壹','貳','參','肆','伍'][i]+'、'+x.type,text:x.teachingExample+'\n'}));
 const sections=baseSections.flatMap<{id:string;heading?:string;text:string}>((section,i)=>[section,{id:'gap'+i,text:''}]);
 for(const [label,opts] of [['before',{compactPaper:false}],['after',undefined]] as const){
  const made=await call('create_answer',{title:'structured synthetic '+label,sections,...(opts?{layoutOptions:opts}:{})});assert.equal(made.layout.fits,true);
  const full=await call('read_answer',{answerId:made.answer.id});
  if(label==='after'){assert.equal(full.layout.totalLines,26);assert.equal(full.answer.sections.filter((s:any)=>s.id.startsWith('gap')).length,5);assert.ok(!full.layout.lines.some((l:any)=>l.sectionId.startsWith('gap')));assert.ok(full.layout.lines.every((l:any)=>l.text.trim()&&!l.isSpacer&&!l.isHeading&&!l.isPadding));assert.equal(full.answer.sections[0].heading,sections[0].heading);assert.equal(full.answer.sections[0].text,sections[0].text);}
  const exported=await call('export_answer',{answerId:made.answer.id,expectedVersion:1,formats:['pdf','docx']});assert.equal(exported.failed.length,0);
  for(const f of exported.files){const art=await store.readExport(f.exportUri.split('/').at(-1));assert.equal(f.pages,2);await fs.writeFile(path.join(output,label+'.'+f.format),art.data);if(f.format==='docx'){const z=await JSZip.loadAsync(art.data);const xml=await z.file('word/document.xml')!.async('string');assert.equal((xml.match(/<w:tr>/g)??[]).length,44);}}
  out[label]={lines:full.layout.totalLines,layout:full.layout};
 }
 for(const section of sections){const off=await call('create_answer',{title:'old-'+section.id,sections:[section],layoutOptions:{compactPaper:false}});const on=await call('create_answer',{title:'new-'+section.id,sections:[section]});assert.ok(on.layout.totalLines<off.layout.totalLines);out.cases.push({id:section.id,before:off.layout.totalLines,after:on.layout.totalLines});}
 await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(out,null,2));console.log(JSON.stringify({before:out.before.lines,after:out.after.lines,cases:out.cases,output}));
}finally{await c.close();await s.close();}
