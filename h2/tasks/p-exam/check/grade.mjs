import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
export async function grade(root, arg){ let n=0,total=0;const lines=[];

try {
 if(!arg) throw 0; const expect=JSON.parse(await fs.readFile(arg,'utf8')); if(!Array.isArray(expect))throw 0;
 const state=JSON.parse(await fs.readFile(root+'/h2-result/state.json','utf8')); const final=await fs.readFile(root+'/h2-result/final.md','utf8');
 const calls=[],byId=new Map(); for(const line of (await fs.readFile(root+'/h2-result/events.jsonl','utf8').catch(()=>'' )).split(/\r?\n/)){try{const it=JSON.parse(line).item;if(it?.type!=='mcp_tool_call'||!it.tool)continue;const id=it.id??JSON.stringify([it.server,it.tool,it.arguments]),entry={tool:it.tool,args:it.arguments??{},failed:it.status==='failed'||!!it.error||(it.result?.isError===true||it.result?.is_error===true),ok:it.status==='completed'&&!it.error&&it.result?.isError!==true&&it.result?.is_error!==true};if(byId.has(id))Object.assign(calls[byId.get(id)],entry);else{byId.set(id,calls.length);calls.push(entry);}}catch{}}
 const answers=state.answers??[],exports=state.exports??[],exams=state.exams??[];
 for(const c of expect){let p=false,d='';switch(c.kind){
 case'all_templates':p=answers.length>0&&answers.every(answer=>c.allowed.includes(answer.templateId));d='templates='+answers.map(answer=>answer.templateId).join(',');break;
 case'no_unsupported_formatting':{const unsupported=value=>Array.isArray(value)?value.some(unsupported):value!==null&&typeof value==='object'&&Object.entries(value).some(([key,nested])=>((key==='bold'||key==='italic')&&nested===true)||((key==='alignment'||key==='align')&&['center','right','justify'].includes(nested))||unsupported(nested));const attempts=calls.filter(call=>c.tools.includes(call.tool)&&unsupported(call.args));p=attempts.length===0;d='unsupported attempts='+attempts.length;break;}
 case'answers_count':p=(c.eq===undefined||answers.length===c.eq)&&(c.min===undefined||answers.length>=c.min)&&(c.max===undefined||answers.length<=c.max);d='answers='+answers.length;break;
 case'exams_count':p=(c.eq===undefined||exams.length===c.eq)&&(c.min===undefined||exams.length>=c.min)&&(c.max===undefined||exams.length<=c.max);d='exams='+exams.length;break;
 case'all_fit':p=answers.every(a=>a.fits===true);d='fits='+answers.filter(a=>a.fits===true).length+'/'+answers.length;break;
 case'answer_where':{const xs=answers.filter(a=>Object.entries(c.match??{}).every(([k,v])=>a[k]===v));p=xs.length>0;for(const a of xs){const q=c.checks??{},ss=(x)=>x.sectionTitle!==undefined?a.sections?.find(s=>s.title===x.sectionTitle):a.sections?.[x.sectionIndex];if(q.fits!==undefined)p&&=a.fits===q.fits;if(q.version_eq!==undefined)p&&=a.version===q.version_eq;if(q.version_min!==undefined)p&&=a.version>=q.version_min;if(q.total_lines_min!==undefined)p&&=a.totalLines>=q.total_lines_min;if(q.total_lines_max!==undefined)p&&=a.totalLines<=q.total_lines_max;if(q.section_count_eq!==undefined)p&&=a.sections?.length===q.section_count_eq;if(q.section_titles_eq)p&&=JSON.stringify(a.sections?.map(s=>s.title))===JSON.stringify(q.section_titles_eq);if(q.first_line_indent_min!==undefined)p&&=(a.sections??[]).every(s=>(s.paragraphs??[]).every(x=>(x.firstLineIndent??x.firstlineindent??0)>=q.first_line_indent_min));if(q.line_targets_sum_min!==undefined)p&&=Object.values(a.lineTargets??{}).reduce((n,x)=>n+x,0)>=q.line_targets_sum_min;if(q.line_targets_sum_max!==undefined)p&&=Object.values(a.lineTargets??{}).reduce((n,x)=>n+x,0)<=q.line_targets_sum_max;for(const [key,val] of Object.entries(q))if(key.startsWith('section_text_contains')){const s=ss(val);p&&=!!s&&s.text.includes(val.text);}for(const [key,val] of Object.entries(q))if(key.startsWith('section_text_not_contains')){const s=ss(val);p&&=!!s&&!s.text.includes(val.text);}for(const [key,val] of Object.entries(q))if(key.startsWith('section_text_unchanged')){const s=ss(val);p&&=!!s&&s.text===val.text;}if(q.any_paragraph_bold!==undefined)p&&=(a.sections??[]).some(s=>(s.paragraphs??[]).some(x=>x.bold===true))===q.any_paragraph_bold;if(q.all_align!==undefined)p&&=(a.sections??[]).every(s=>(s.paragraphs??[]).every(x=>(x.align??x.alignment??'left')===q.all_align));}d='matched='+xs.length;break;}
 case'exports_kinds':p=Object.entries(c).filter(([k])=>k!=='kind'&&k!=='label').every(([k,v])=>exports.filter(x=>x.kind===k).length>=v);d='exports='+exports.map(x=>x.kind).join(',');break;
 case'tool_called':{const z=calls.filter(x=>x.tool===c.tool).length;p=z>=(c.min??0)&&(c.max===undefined||z<=c.max);d=c.tool+'='+z;break;}
 case'tool_called_any':{const z=calls.filter(x=>c.tools.includes(x.tool)).length;p=z>=(c.min??1)&&(c.max===undefined||z<=c.max);d=c.tools.join('|')+'='+z;break;}
 case'tool_not_called':p=!calls.some(x=>x.tool===c.tool);d=c.tool+' calls='+calls.filter(x=>x.tool===c.tool).length;break;
 case'first_tool':p=calls[0]?.tool===c.tool;d='first='+calls[0]?.tool;break;
 case'tool_order':{const i=calls.findIndex(x=>c.first_of.includes(x.tool)),j=calls.findIndex(x=>c.before.includes(x.tool));p=i>=0&&(j<0||i<j);d='first='+calls[i]?.tool;break;}
 case'total_calls_max':p=calls.length<=c.n;d='calls='+calls.length;break;
 case'failed_calls_max':{const z=calls.filter(x=>x.failed).length;p=z<=c.n;d='failed='+z;break;}
 case'every_call_has_arg':{const xs=calls.filter(x=>c.tools.includes(x.tool)&&(c.choose==='all'||x.ok));p=xs.every(x=>x.args?.[c.arg]!==undefined);d='checked='+xs.length;break;}
 case'final_message_matches':p=new RegExp(c.regex).test(final);d='regex evaluated';break;
 case'final_message_not_matches':p=!new RegExp(c.regex).test(final);d='regex evaluated';break;default:d='unknown criterion';}
 total++;if(p)n++;lines.push((p?'PASS ':'FAIL ')+(c.label??c.kind)+': '+d);
 }
} catch {return {code:2,output:JSON.stringify({n_passed:0,n_criteria:0})}}
return {code:n===total?0:1,output:[...lines,JSON.stringify({n_passed:n,n_criteria:total})].join('\n')};
}
if(process.argv[1] && path.resolve(fileURLToPath(import.meta.url))===path.resolve(process.argv[1])){const r=await grade(process.cwd(),process.argv[2]);console.log(r.output);process.exitCode=r.code;}
