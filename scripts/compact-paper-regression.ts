import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {FileStore} from '../src/storage.js';
import {createEssayMcpServer} from '../src/server.js';
import {ESSAY_TEACHING_CASES} from '../src/essay-instructions.js';
import JSZip from 'jszip';
const output=path.resolve('output/pdf/compact-paper');await fs.mkdir(output,{recursive:true});
const store=new FileStore({templateDir:path.resolve('templates'),answerDir:path.resolve('tmp/compact-paper/answers'),exportDir:path.resolve('tmp/compact-paper/exports')});
const server=createEssayMcpServer(store),client=new Client({name:'compact-real-export',version:'1'});
const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);
const call=async(name:string,args:Record<string,unknown>)=>{const r=await client.callTool({name,arguments:args});assert.notEqual(r.isError,true,JSON.stringify(r.content));return r.structuredContent as any;};
const cases=ESSAY_TEACHING_CASES.filter(c=>c.id!=='dual_compression');
const manifest:any={synthetic:true,notOfficialAnswer:true,automaticRewrite:false,cases:[],exports:[]};
try{
 for(const c of cases){
  const before=await call('create_answer',{title:'合成舊式-'+c.id,layoutOptions:{compactPaper:false},sections:[{id:c.id,heading:c.type,text:'\n'+c.teachingExample+'\n'}]});
  const after=await call('create_answer',{title:'合成緊湊-'+c.id,sections:[{id:c.id,text:c.type+'：'+c.teachingExample}]});
  const answer=(await call('read_answer',{answerId:after.answer.id})).answer;
  manifest.cases.push({id:c.id,before:before.layout.totalLines,after:after.layout.totalLines,text:answer.sections[0].text});
  assert.ok(after.layout.totalLines<before.layout.totalLines);
 }
 const beforeSections=cases.map((c,i)=>({id:c.id,heading:['壹','貳','參','肆','伍'][i]+'、'+c.type,text:c.teachingExample+'\n'}));
 const afterSections=beforeSections.map(s=>({id:s.id,text:s.heading+'：'+s.text.trim()}));
 for(const [label,sections] of [['before',beforeSections],['after',afterSections]] as const){
  const created=await call('create_answer',{title:'五題型合成排版-'+label,sections,layoutOptions:{compactPaper:false}});assert.equal(created.layout.fits,true);
  const full=await call('read_answer',{answerId:created.answer.id});
  if(label==='after')assert.ok(full.layout.lines.every((l:any)=>l.text.trim()&&!l.isSpacer&&!l.isHeading&&!l.isPadding));
  const ex=await call('export_answer',{answerId:created.answer.id,expectedVersion:1,formats:['pdf','docx']});assert.equal(ex.failed.length,0);
  for(const f of ex.files){const art=await store.readExport(f.exportUri.split('/').at(-1));await fs.writeFile(path.join(output,label+'.'+f.format),art.data);assert.equal(f.pages,2);
   if(f.format==='docx'){const zip=await JSZip.loadAsync(art.data);const xml=await zip.file('word/document.xml')!.async('string');const rows=(xml.match(/<w:tr>/g)??[]).length;assert.equal(rows,44);manifest.exports.push({label,format:'docx',rows,pages:f.pages});}
  }
  manifest[label]={lines:created.layout.totalLines,layout:full.layout};
 }
 await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({cases:manifest.cases.map(({id,before,after}:any)=>({id,before,after})),before:manifest.before.lines,after:manifest.after.lines,exports:manifest.exports,output}));
}finally{await client.close();await server.close();}
