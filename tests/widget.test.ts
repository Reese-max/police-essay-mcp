import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole, type DOMWindow } from 'jsdom';
import { POLICE_ESSAY_WIDGET_HTML } from '../src/widget.js';
import { createAnswerDocument, type AnswerTemplate, type HeadingStyleInput } from '../src/domain.js';
import { layoutSections } from '../src/layout.js';

const template = JSON.parse(readFileSync(new URL('../templates/police_information_essay.json', import.meta.url), 'utf8')) as AnswerTemplate;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
type Args = { answerId: string; operation?: string; sectionId?: string; expectedVersion?: number; newText?: string; paragraphs?: Array<{text: string; format?: unknown}> };
async function host(options: {readOnly?: boolean; legacy?: boolean; headingStyle?: HeadingStyleInput; italic?: boolean} = {}) {
  let answer = createAnswerDocument({templateId:template.id,title:'測試答案',sections:[{id:'a',heading:'（一）',headingStyle:options.headingStyle,paragraphs:[{text:'第一段',format:{firstLineIndent:2,italic:options.italic}},{text:'第二段',format:{leftIndent:2}}]}]});
  const calls: Array<{name: string; args: Args}> = [];
  const protocol: string[] = [];
  let held: (()=>void) | undefined;
  let hold = false;
  const errors: Error[] = [];
  let window: DOMWindow;
  const snapshot = () => ({answer,layout:layoutSections(template,answer.sections)});
  const result = () => ({structuredContent:snapshot(),_meta:{readOnly:Boolean(options.readOnly)}});
  const tools = async (name: string, args: Args) => {
    calls.push({name,args});
    if (name === 'preview_change') {
      assert.equal(args.operation,'replace_text');
      if (hold) await new Promise<void>(resolve => {held=resolve;});
      return {structuredContent:{summary:['預覽完成'],after:snapshot()}};
    }
    if (name === 'replace_text') {
      assert.equal(args.expectedVersion,answer.version);
      answer = {...answer,version:answer.version+1,sections:answer.sections.map(s=>({...s,text:args.newText??args.paragraphs!.map(p=>p.text).join('\n')}))};
    }
    if (name === 'check_layout') {
      // Simulate an independent client committing between render and check.
      answer = {...answer,version:answer.version+1};
      return {structuredContent:{answerId:answer.id,version:answer.version,layout:snapshot().layout}};
    }
    return result();
  };
  const parent = {postMessage(message: {id?: number; method: string; params: {name: string; arguments: Args}}, _origin: string) {
    protocol.push(message.method);
    queueMicrotask(async () => {
      if (message.method === 'ui/notifications/initialized') {send();return;}
      if (message.method === 'ui/initialize') {
        window.dispatchEvent(new window.MessageEvent('message',{source:parent as unknown as Window,origin:'https://host.test',data:{jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2026-01-26',hostCapabilities:{serverTools:{}}}}}));
      } else if (message.method === 'tools/call') {
        const value = await tools(message.params.name,message.params.arguments);
        window.dispatchEvent(new window.MessageEvent('message',{source:parent as unknown as Window,origin:'https://host.test',data:{jsonrpc:'2.0',id:message.id,result:value}}));
      }
    });
  }};
  function send() {
    window.dispatchEvent(new window.MessageEvent('message',{source:parent as unknown as Window,origin:'https://host.test',data:{jsonrpc:'2.0',method:'ui/notifications/tool-result',params:result()}}));
  }
  const console = new VirtualConsole();console.on('jsdomError', error=>errors.push(error));
  const dom = new JSDOM(POLICE_ESSAY_WIDGET_HTML,{runScripts:'dangerously',url:'https://view.test',virtualConsole:console,beforeParse(w) {
    window=w;
    Object.defineProperty(w,'parent',{value:parent});
    if (options.legacy) Object.defineProperty(w,'openai',{value:{toolOutput:snapshot(),toolResponseMetadata:result()._meta,callTool:tools}});
  }});
  await tick();await tick();assert.deepEqual(errors,[]);
  const element = <T extends HTMLElement = HTMLElement>(id:string) => dom.window.document.getElementById(id) as T;
  const input = (value: string) => {element<HTMLTextAreaElement>('text').value=value;element('text').dispatchEvent(new dom.window.Event('input'));};
  const click = async (id: string) => {element(id).click();await tick();await tick();};
  return {dom,calls,protocol,element,input,click,send,setHold:()=>{hold=true;},release:async()=>{hold=false;held?.();await tick();await tick();},get answer(){return answer;}};
}

test('widget initializes with the host and preserves paragraph formats when applying edits',async()=>{
 const h=await host();try {
  assert.deepEqual(h.protocol.slice(0,2),['ui/initialize','ui/notifications/initialized']);
  h.input('新版第一段\n第二段');await h.click('preview-edit');
  assert.equal(h.element<HTMLButtonElement>('apply-edit').disabled,false);await h.click('apply-edit');
  const edit=h.calls.find(x=>x.name==='replace_text')!;
  assert.equal(edit.args.expectedVersion,1);assert.equal(JSON.stringify(edit.args.paragraphs?.map(p=>p.format)),JSON.stringify(h.answer.sections[0].paragraphs?.map(p=>p.format)));
  assert.equal(h.answer.version,2);assert.equal(h.element<HTMLTextAreaElement>('text').value,'新版第一段\n第二段');
 }finally{h.dom.window.close();}
});
test('widget rejects a late preview after the draft changes',async()=>{
 const h=await host();try {
  h.setHold();h.input('預覽版本\n第二段');await h.click('preview-edit');h.input('繼續修改\n第二段');await h.release();
  assert.equal(h.element<HTMLButtonElement>('apply-edit').disabled,true);await h.click('apply-edit');assert.equal(h.calls.filter(x=>x.name==='replace_text').length,0);
 }finally{h.dom.window.close();}
});
test('widget keeps paragraph formats when lines are added, rewritten or removed',async()=>{
 // Each draft line lists which stored paragraph (0: firstLineIndent 2, 1: leftIndent 2) lends its format.
 for (const [draft,sources] of [
  ['第一段\n新增的一段\n第二段',[0,0,1]],
  ['改寫第一段\n第二段\n第三段',[0,1,1]],
  ['開頭\n第一段\n第二段',[0,0,1]],
  ['第二段',[1]],
 ] as const) {
  const h=await host();try {
   const stored=h.answer.sections[0].paragraphs!.map(p=>p.format);
   assert.equal(stored[0]!.firstLineIndent,2);assert.equal(stored[1]!.leftIndent,2);
   h.input(draft);await h.click('preview-edit');
   assert.equal(h.element<HTMLButtonElement>('apply-edit').disabled,false,h.element('preview').textContent!);
   const preview=h.calls.find(x=>x.name==='preview_change')!;
   assert.deepEqual(JSON.parse(JSON.stringify(preview.args.paragraphs)),
    JSON.parse(JSON.stringify(draft.split('\n').map((text,i)=>({text,format:stored[sources[i]]})))));
   assert.equal(preview.args.newText,undefined);
  }finally{h.dom.window.close();}
 }
});
test('widget layout check refreshes the current version before the next edit',async()=>{
 const h=await host();try {
  await h.click('check');assert.match(h.element('version').textContent!,/2/);
  h.input('新版第一段\n第二段');await h.click('preview-edit');await h.click('apply-edit');assert.equal(h.calls.find(x=>x.name==='replace_text')!.args.expectedVersion,2);
 }finally{h.dom.window.close();}
});
test('read-only widget disables editing and legacy host tool calls work without a second handshake',async()=>{
 const read=await host({readOnly:true});try {
  assert.equal(read.element<HTMLTextAreaElement>('text').disabled,true);assert.equal(read.element<HTMLButtonElement>('preview-edit').disabled,true);await read.click('preview-edit');assert.equal(read.calls.length,0);
 }finally{read.dom.window.close();}
 const legacy=await host({legacy:true});try {
  assert.equal(legacy.protocol.length,0);legacy.input('修改第一段\n第二段');await legacy.click('preview-edit');await legacy.click('apply-edit');assert.equal(legacy.answer.version,2);
 }finally{legacy.dom.window.close();}
});
test('widget grid shows bold and italic only where the line format sets them',async()=>{
 const weight=(h: Awaited<ReturnType<typeof host>>,text: string)=>{
  const cell=[...h.dom.window.document.querySelectorAll('.line-text')].find(x=>x.textContent===text)!;
  const style=h.dom.window.getComputedStyle(cell);return [style.fontWeight,style.fontStyle];
 };
 const plain=await host({headingStyle:{bold:false}});try {
  // jsdom reports '' when no stylesheet rule sets the property.
  assert.deepEqual(weight(plain,'（一）'),['','']);assert.deepEqual(weight(plain,'第二段'),['','']);
 }finally{plain.dom.window.close();}
 const styled=await host({italic:true});try {
  assert.deepEqual(weight(styled,'（一）'),['800','']);assert.deepEqual(weight(styled,'第二段'),['','']);
  assert.deepEqual(weight(styled,'第一段'),['','italic']);
 }finally{styled.dom.window.close();}
});
