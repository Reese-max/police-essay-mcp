import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
// Uses an explicitly supplied existing TypeScript runtime read-only, no package install or model calls.
const require=createRequire(import.meta.url),ts=require(path.resolve(process.argv[2]));
const source=await readFile('src/essay-instructions.ts','utf8');
const transpiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ES2022,target:ts.ScriptTarget.ES2022},reportDiagnostics:true});
if(transpiled.diagnostics?.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(transpiled.diagnostics,{getCanonicalFileName:s=>s,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
const current=await import('data:text/javascript;base64,'+Buffer.from(transpiled.outputText).toString('base64'));
const base='96137548f1b15ac2cc4e0774f67ec3cf2f8d2971',old=execFileSync('git',['show',base+':src/server.ts'],{encoding:'utf8'});
const ast=ts.createSourceFile('server.ts',old,ts.ScriptTarget.Latest,true);
let review,planning,compression;
function visit(n){if(ts.isVariableDeclaration(n)&&n.name.getText(ast)==='REVIEW_INSTRUCTION'&&ts.isStringLiteral(n.initializer))review=n.initializer.text;
 if(ts.isStringLiteral(n)&&n.text.includes('compressionHints')&&n.text.includes('write_answer'))planning=n.text;
 if(ts.isTemplateExpression(n)&&n.head.text.startsWith('請讀取答案'))compression=n;
 ts.forEachChild(n,visit);}
visit(ast);if(!review||!planning||!compression)throw new Error('Base prompt extraction changed; inspect before proceeding');
function oldCompress(id,lines){let s=compression.head.text;for(const span of compression.templateSpans){const expr=span.expression.getText(ast);s+=(expr==='answerId'?id:lines)+span.literal.text;}return s;}
const cases=current.ESSAY_TEACHING_CASES.map(item=>{
 const q=`${item.question}\n材料：${item.material}\n篇幅預算：${item.budgetLines}行（同一題新舊提示詞相同）`;
 const scoring=item.id==='dual_compression'?'第一小問3分，第二小問2分；可相加共5分。':undefined;
 return {...item,request:{question:q,...(scoring?{scoringPoints:scoring}:{})},oldDraft:[`請回答申論題：${q}`,scoring?`採點方向：${scoring}`:'',planning,review].filter(Boolean).join('\n'),newDraft:[`請回答申論題：${q}`,scoring?`採點方向：${scoring}`:'',current.DRAFT_INSTRUCTION,review+'\n'+current.REVIEW_REASONING_INSTRUCTION].filter(Boolean).join('\n'),...(item.id==='dual_compression'?{compressionRequest:{answerId:'ans_comparison-case',overflowLines:3},oldCompression:oldCompress('ans_comparison-case',3),newCompression:['answerId=ans_comparison-case; estimatedOverflowLines=3',current.COMPRESS_INSTRUCTION,review+'\n'+current.REVIEW_REASONING_INSTRUCTION].join('\n')}:{})};
});
const dual=cases.find(c=>c.id==='dual_compression');
dual.compressionInput={id:'ans_comparison-case',version:1,templateId:'police_information_essay_165',sections:[
 {id:'purpose',heading:'一、備份保留可恢復副本',text:'隨著資訊日益重要，備份十分重要，不可忽視。備份的用途在於保留可恢復副本，資料損毀後可藉此回復原先狀態。因此應重視備份，不能忽略其重要性。'},
 {id:'test',heading:'二、恢復測試確認副本及程序可用',text:'恢復測試也是十分重要的工作。因備份檔案存在不等於可成功恢復，必須測試副本可用及恢復程序可執行，才可確認恢復準備。此處必須注意，備份與恢復測試不能混為一談。'}],
 note:'Identical current draft supplied to both arms. Redundancy is intentional for the compression exercise. The illustrative overflowLines=3 is not measured; replace it with actual check_layout output in a real run. Per-case target is six lines, template remains 44 lines.'};
const out=path.resolve(process.argv[3]??'../prompt-review-20261101');await mkdir(out,{recursive:true});
await writeFile(path.join(out,'comparison.json'),JSON.stringify({base,modelExecuted:false,scored:false,retrievalValidation:'source-derived construction only; real prompts/get regression prepared but not yet executed',controls:'Same question, materials, per-case line budget. For model A/B also hold model, sampling, source access and revision limits constant; blind-review without claimed score.',cases},null,2));
console.log(JSON.stringify({cases:cases.length,modelExecuted:false,scored:false,output:path.join(out,'comparison.json')}));
