import fs from 'node:fs/promises';
import path from 'node:path';
import { grade } from './grade.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = process.cwd();
const section = (title, text, indent = 0) => ({ title, text, paragraphs: [{ text, firstLineIndent: indent, bold: false, align: 'left' }] });
const answer = (title, sections, extra = {}) => ({ id: 'ans_a', title, templateId: 'police_information_essay_165', version: 2, fits: true, totalLines: 10, capacity: 44, sections, ...extra });
const make = (ans, calls = [], final = '完成', exams = [], exports = []) => ({ state: { answers: Array.isArray(ans) ? ans : [ans], exams, exports }, calls, final });
const data = {
  'p-165': make(answer('165原稿紙警政資訊題目',[section('一','警察資訊系統應落實資通安全與個人資料保護。')],{version:1,totalLines:3}),['read_answer','render_answer_sheet'],'165 原稿紙不支援粗體與置中，已保留原文並靠左顯示。'),
  'p-edit': make(answer('警察資訊安全管理', [section('一','警察資訊系統應落實權限控管與操作紀錄。'),section('二','資通安全措施'),section('三','機關應定期檢視制度並持續改善。')]), ['edit_text']),
  'p-overflow': make(answer('資通安全管理法申論', ['一','二','三','四'].map(x=>section(x,'ok')),{totalLines:42}), ['check_layout'], '完成', [], [{kind:'pdf'},{kind:'docx'}]),
  'p-exam': make([1,2,3].map(n=>answer('q'+n,[section('一','答')],{questionNo:n})), ['start_exam','create_answers','render_exam_overview','export_exam_bundle'], '完成', [], [{kind:'pdf'},{kind:'docx'}]),
  'p-rewrite': make(answer('警察資訊安全管理',[section('一','警察機關應建立資通安全管理制度，明定權責分工。'),section('二','應落實存取控管與操作紀錄保存，並定期稽核。'),section('三','應辦理教育訓練與演練，持續檢討改善。')]),['replace_text']),
  't-create-targets': make(answer('警察資訊管理措施',[section('一、現況','盤點系統與資料流程'),section('二、措施','權限控管、操作紀錄與教育訓練'),section('三、檢討','持續改善')],{lineTargets:{a:12,b:12,c:12},totalLines:38}),['create_answer','set_line_targets','check_layout']),
  't-create-compress': make(answer('資通安全風險管理',[section('一、資產盤點','盤點資訊資產清冊與資料流程'),section('二、風險評估','評估影響與發生可能性'),section('三、控制措施','落實最小權限與操作紀錄'),section('四、事件改善','保存證據並追蹤改善結果')],{totalLines:32}),['create_answer','check_layout','replace_text','check_layout']),
  't-create-format': make(answer('個資保護與警察勤務',['一、','二、','三、'].map(x=>section(x,'法定目的及必要範圍',2))),['create_answer','check_layout']),
  't-edit-paragraph': make(answer('警察資訊勤務紀錄',[section('一','系統應依職務設定權限並定期檢視。'),section('二','稽核紀錄應完整保存並定期檢視，以利事後追查異常操作。'),section('三','機關應辦理教育訓練並持續改善。')]),['replace_text']),
  't-edit-move': make(answer('個資事故應變順序',[section('一、控制','先限制存取並保存相關紀錄。'),section('二、通報','發現疑似事件應立即通報權責單位。'),section('三、檢討','事後檢討原因並修正管理措施。')]),['move_section','renumber_items']),
  't-fit-tight': make(answer('數位鑑識流程',['一','二','三','四'].map(x=>section(x,'資通安全應定期檢視並保存紀錄。')),{totalLines:42}),['check_layout','edit_text','check_layout']),
  't-fit-short': make(answer('警察職權行使法與個資保護',[section('一','蒐集資料應有明確目的。'),section('二','存取權限依職務分級。'),section('三','定期檢視並刪除逾期資料。')],{version:1,lineTargets:{a:12,b:12,c:12}}),['read_answer','check_layout'],'第一節與第二節都偏短；第三節尚差數行。'),
  't-exam-resume': make([answer('114年警察特考資訊申論',[section('一','既有答案')],{version:1}),answer('第2題',[section('一','風險管理')]),answer('第3題',[section('一','個資保護')])],[{tool:'get_exam_progress'},{tool:'create_answers',args:{expectedVersion:1}},{tool:'export_exam_bundle'}],'考試完成',[{examId:'exam_resume-h2-2026'}],[{kind:'pdf'},{kind:'docx'}]),
  't-exam-overflow': make([1,2,3].map(n=>answer('題目'+n,[section('一','答案內容')],{questionNo:n})),['start_exam','create_answers','check_layout','replace_text','check_layout','check_layout','render_exam_overview','export_exam_bundle'],'完成',[],[{kind:'pdf'},{kind:'docx'}]),
  't-boundary-verify': make(answer('資通安全管理原則',[section('一','機關建立制度'),section('二','定期辨識風險')],{version:1})),
  't-boundary-delete': make(answer('個資保存期限',[section('一','依目的使用'),section('二','屆期依法處理')],{version:1})),
  't-boundary-unsupported': make(answer('數位鑑識證據保全',[section('一','記錄來源時間'),section('二','保存原始資料')],{version:1}),[],'目前不支援 B4 紙張或插入圖片。'),
};

const bad = {
  'p-165': d=>d.calls.push({tool:'format_section',args:{headingStyle:{bold:true},paragraphFormat:{alignment:'center'}}}),
  'p-edit': d=>d.calls.push('write_answer'),
  'p-overflow': d=>d.calls.push('delete_answer'),
  'p-exam': d=>{d.calls=['start_exam','create_answers','render_answer_sheet','render_answer_sheet','render_answer_sheet','export_exam_bundle'];},
  'p-rewrite': d=>d.calls.push('delete_answer'),
  't-create-targets': d=>{d.state.answers[0].lineTargets={};},
  't-create-compress': d=>{d.calls=d.calls.filter(tool=>tool!=='replace_text');},
  't-create-format': d=>{d.state.answers[0].sections[0].paragraphs[0].firstLineIndent=0;},
  't-edit-paragraph': d=>{d.state.answers[0].sections[0].text='其他內容遭到更動';},
  't-edit-move': d=>{d.state.answers[0].sections[0].title='四、控制';d.state.answers[0].sections[1].title='一、通報';},
  't-fit-tight': d=>{d.state.answers[0].totalLines=35;},
  't-fit-short': d=>d.calls.push('write_answer'),
  't-exam-resume': d=>{d.calls[0]={tool:'start_exam'};},
  't-exam-overflow': d=>{d.calls=d.calls.filter(tool=>tool!=='replace_text');},
  't-boundary-verify': d=>{d.final='已查證，內容正確無誤。';},
  't-boundary-delete': d=>d.calls.push('delete_answer'),
  't-boundary-unsupported': d=>{d.final='已經改成 B4 並加上圖片。';},
};

async function run(id, adversarial = false) {
  const dir = path.join(root, 'h2', `.grade-${process.pid}-${id}`);
  const d = structuredClone(data[id]);
  if (adversarial) bad[id](d);
  const expect = JSON.parse(await fs.readFile(path.join(root, 'h2/tasks', id, 'check/expect.json'), 'utf8'));
  await fs.mkdir(path.join(dir, 'h2-result'), { recursive: true });
  await fs.writeFile(path.join(dir, 'h2-result/state.json'), JSON.stringify(d.state));
  await fs.writeFile(path.join(dir, 'h2-result/final.md'), d.final);
  await fs.writeFile(path.join(dir, 'h2-result/events.jsonl'), d.calls.map((call,i)=>{
    const entry=typeof call==='string'?{tool:call,args:{}}:{tool:call.tool,args:call.args??{}};
    return JSON.stringify({item:{id:`i${i}`,type:'mcp_tool_call',server:'essay',tool:entry.tool,arguments:{expectedVersion:1,...entry.args},result:{},status:'completed'}});
  }).join('\n'));
  const result = await grade(dir, path.join(root, 'h2/tasks', id, 'check/expect.json'));
  const taskGrader = await import(path.join(root, 'h2/tasks', id, 'check/grade.mjs'));
  assert.deepEqual(await taskGrader.grade(dir, path.join(root, 'h2/tasks', id, 'check/expect.json')), result);
  await fs.rm(dir, { recursive: true, force: true });
  return result;
}

export async function selfCheck() {
  const results=[];
  for (const id of Object.keys(data)) {
    const good=await run(id), wrong=await run(id,true);
    assert.equal(good.code,0,`${id} good fake: ${good.output}`);
    assert.equal(wrong.code,1,`${id} bad fake: ${wrong.output}`);
    results.push(`${id}: good=PASS bad=FAIL as expected`);
  }
  return results;
}

if (process.env.H2_DIRECT_CHECK !== '1') for (const id of Object.keys(data)) test(`${id}: good and targeted bad fake run`, async () => {
  const good = await run(id); assert.equal(good.code, 0, good.output);
  const wrong = await run(id, true); assert.equal(wrong.code, 1, wrong.output);
});

async function gradeCriterion(criterion, { calls = [], answers = [answer('測試', [section('一', '警察資訊')])] } = {}) {
  const directory = await fs.mkdtemp(path.join(root, 'h2', '.criterion-'));
  try {
    await fs.mkdir(path.join(directory, 'h2-result'));
    await fs.writeFile(path.join(directory, 'h2-result/state.json'), JSON.stringify({ answers }));
    await fs.writeFile(path.join(directory, 'h2-result/final.md'), '完成');
    await fs.writeFile(path.join(directory, 'h2-result/events.jsonl'), calls.map(item => JSON.stringify({item})).join('\n'));
    const expectation = path.join(directory, 'expect.json');
    await fs.writeFile(expectation, JSON.stringify([criterion]));
    return await grade(directory, expectation);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('all 17 active tasks have good/bad fixtures and identical standalone graders', async () => {
  const active = (await fs.readdir(path.join(root, 'h2/tasks'))).sort();
  assert.equal(active.length, 17);
  assert.deepEqual(Object.keys(data).sort(), active);
  assert.deepEqual(Object.keys(bad).sort(), active);
  const central = await fs.readFile(path.join(root, 'h2/grade.mjs'), 'utf8');
  for (const id of active) assert.equal(await fs.readFile(path.join(root, 'h2/tasks', id, 'check/grade.mjs'), 'utf8'), central);
});

test('all_templates accepts 165/166, rejects mixed legacy layouts and empty answers', async () => {
  const criterion = { kind: 'all_templates', allowed: ['police_information_essay_165', 'police_information_essay_166'] };
  for (const templateId of criterion.allowed) {
    assert.equal((await gradeCriterion(criterion, { answers: [answer('測試', [], { templateId })] })).code, 0);
  }
  assert.equal((await gradeCriterion(criterion, { answers: [] })).code, 1);
  assert.equal((await gradeCriterion(criterion, { answers: [answer('新稿', []), answer('舊稿', [], { templateId: 'police_information_essay' })] })).code, 1);
});

test('format boundary rejects nested emphasis/alignment in successful, failed, preview and batch attempts', async () => {
  const tools = ['format_section', 'create_answer', 'create_answers', 'write_answer', 'replace_text', 'insert_text', 'preview_change'];
  const criterion = { kind: 'no_unsupported_formatting', tools };
  const formats = [{ bold: true }, { italic: true }, { alignment: 'center' }, { alignment: 'right' }, { alignment: 'justify' }, { align: 'center' }];
  for (const tool of tools) for (const format of formats) {
    const item = { id: 'attempt', type: 'mcp_tool_call', tool, arguments: { items: [{ sections: [{ headingStyle: format }] }] }, status: 'completed', result: {} };
    assert.equal((await gradeCriterion(criterion, { calls: [item] })).code, 1, tool + JSON.stringify(format));
    item.status = 'failed';
    item.result = { isError: true };
    assert.equal((await gradeCriterion(criterion, { calls: [item] })).code, 1);
  }
  const safe = { id: 'safe', type: 'mcp_tool_call', tool: 'create_answers', status: 'completed', arguments: { answers: [{ sections: [{ text: 'bold italic center 是文字，不是格式', headingStyle: { bold: false, italic: false, alignment: 'left' } }] }] } };
  assert.equal((await gradeCriterion(criterion, { calls: [safe] })).code, 0);
  safe.tool = 'read_answer';
  safe.arguments = { bold: true };
  assert.equal((await gradeCriterion(criterion, { calls: [safe] })).code, 0);
});
