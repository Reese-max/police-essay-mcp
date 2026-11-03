import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

test('all-tools runner distinguishes a failed call from untested tools and still cleans up',async()=>{
    const storage=pathToFileURL(path.resolve('src/storage.ts')).href;
    const script=pathToFileURL(path.resolve('scripts/all-tools-e2e.ts')).href;
    const program=`import {FileStore} from ${JSON.stringify(storage)};FileStore.prototype.getTemplate=async()=>{throw Error('injected template read failure')};await import(${JSON.stringify(script)});`;
    const result=await new Promise<{code:number|null;output:string}>((resolve,reject)=>{
        const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',program],{env:{...process.env,GOMAXPROCS:'2'},stdio:['ignore','pipe','pipe']});let output='';
        const timer=setTimeout(()=>{child.kill();reject(Error('runner fault test timeout'));},60000);
        child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
        child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);resolve({code,output})});
    });
    assert.notEqual(result.code,0);const match=/ALL_TOOLS_REPORT ([^\r\n]+)/.exec(result.output);assert.ok(match,result.output);
    const report=JSON.parse(await readFile(path.join(match[1],'acceptance.json'),'utf8'));
    assert.equal(report.success,false);assert.equal(report.cleanup,'passed');
    assert.equal(report.matrix.find((r:any)=>r.name==='list_templates').success,'passed');
    assert.equal(report.matrix.find((r:any)=>r.name==='load_exam_paper').success,'failed');
    assert.equal(report.matrix.find((r:any)=>r.name==='write_answer').success,'not_tested');
    assert.match(report.failure,/injected template read failure/);
});
