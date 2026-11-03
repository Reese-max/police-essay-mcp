import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const cwd = process.cwd();
const domain = await import(pathToFileURL(path.join(cwd, 'dist/src/domain.js')));
const { FileStore } = await import(pathToFileURL(path.join(cwd, 'dist/src/storage.js')));
const { layoutSections } = await import(pathToFileURL(path.join(cwd, 'dist/src/layout.js')));
const { DEFAULT_TEMPLATE_ID } = await import(pathToFileURL(path.join(cwd, 'dist/src/server.js')));
assert.equal(DEFAULT_TEMPLATE_ID, 'police_information_essay_165');
const fmt = { alignment: 'left', bold: false, italic: false };
const layoutOptions = { wholeLatinWords: true, keepHeadingWithNext: true, avoidPunctuationOnlyLines: true };
const timestamp = '2026-11-03T00:00:00.000Z';
const body = '警察機關應落實資通安全管理，明確分工並保存必要操作紀錄。';
const templateStore = new FileStore({ templateDir: path.join(cwd, 'templates') });
const template = await templateStore.getTemplate(DEFAULT_TEMPLATE_ID);
const capacity = template.pages * template.linesPerPage;

function document(name, title, sections, extras = {}) {
  const created = domain.createAnswerDocument({ templateId: DEFAULT_TEMPLATE_ID, title,
    sections: sections.map((section, index) => ({ id: `sec-h2-${name}-${index + 1}`,
      heading: section.heading, text: section.text, paragraphFormat: section.format ?? fmt,
      headingStyle: fmt })) });
  return domain.answerDocumentSchema.parse({ ...created, id: `ans_h2-${name}`, createdAt: timestamp,
    updatedAt: timestamp, layoutOptions, ...extras });
}

function measuredSections(name, targetLines) {
  for (let repetitions = 1; repetitions <= 200; repetitions++) {
    const sections = ['一', '二', '三', '四'].map((heading, index) => ({ heading,
      text: body.repeat(Math.floor(repetitions / 4) + (index < repetitions % 4 ? 1 : 0)) || body }));
    const doc = document(name, '版面校準', sections);
    const report = layoutSections(template, doc.sections, doc.layoutOptions);
    if (report.totalLines >= targetLines) return sections;
  }
  throw new Error(`cannot calibrate ${name}`);
}

async function answer(name, title, sections, extras = {}) {
  const root = path.join(cwd, 'h2/seeds', name, 'store');
  await fs.rm(root, { recursive: true, force: true });
  const store = new FileStore({ templateDir: path.join(cwd, 'templates'),
    answerDir: path.join(root, 'answer-records'), exportDir: path.join(root, 'export-records') });
  const doc = document(name, title, sections, extras);
  if (name === 't-fit-short') doc.lineTargets = Object.fromEntries(doc.sections.map(section => [section.id, 12]));
  const report = layoutSections(template, doc.sections, doc.layoutOptions);
  if (name === 't-fit-tight') assert.ok(report.totalLines >= capacity + 1 && report.totalLines <= capacity + 3);
  else if (name === 'overflow') assert.ok(report.totalLines >= capacity * 2);
  else assert.equal(report.fits, true, `${name} should fit`);
  if (name === 't-fit-short') assert.ok(report.totalLines < 18);
  await store.saveAnswer(doc);
  console.log(`${name}: template=${doc.templateId} fits=${report.fits} totalLines=${report.totalLines} capacity=${report.capacity}`);
  return { store, doc, root };
}

const generators = {
  empty: async () => {
    const root = path.join(cwd, 'h2/seeds/empty');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, 'store/answer-records'), { recursive: true });
    await fs.writeFile(path.join(root, '.keep'), '');
    console.log(`empty: no answers; default=${DEFAULT_TEMPLATE_ID} capacity=${capacity}`);
  },
  edit: () => answer('edit', '警察資訊安全管理', [
    { heading: '一', text: '警察資訊系統應落實權限控管與操作紀錄。' },
    { heading: '二', text: '資訊安全是維護勤務資料與服務穩定的基礎。' },
    { heading: '三', text: '機關應定期檢視制度並持續改善。' },
  ]),
  overflow: () => answer('overflow', '資通安全管理法申論', measuredSections('overflow', capacity * 2)),
  paper165: () => answer('paper165', '165原稿紙警政資訊題目', [
    { heading: '一', text: '警察資訊系統應落實資通安全與個人資料保護。' },
  ]),
  't-edit-paragraph': () => answer('t-edit-paragraph', '警察資訊勤務紀錄', [
    { heading: '一', text: '系統應依職務設定權限並定期檢視。' },
    { heading: '二', text: '操作紀錄應妥善保存，以供稽核追蹤。' },
    { heading: '三', text: '機關應辦理教育訓練並持續改善。' },
  ]),
  't-edit-move': () => answer('t-edit-move', '個資事故應變順序', [
    { heading: '一、通報', text: '發現疑似事件應立即通報權責單位。' },
    { heading: '三、檢討', text: '事後檢討原因並修正管理措施。' },
    { heading: '四、控制', text: '先限制存取並保存相關紀錄。' },
  ]),
  't-fit-tight': () => answer('t-fit-tight', '數位鑑識流程', measuredSections('t-fit-tight', capacity + 2)),
  't-fit-short': () => answer('t-fit-short', '警察職權行使法與個資保護', [
    { heading: '一', text: '依警察職權行使法，蒐集資料應有明確目的。' },
    { heading: '二', text: '存取權限應依職務分級。' },
    { heading: '三', text: '定期檢視並刪除逾期資料。' },
  ]),
  't-resume-exam': async () => {
    const { store, doc, root } = await answer('t-resume-exam', '114年警察特考資訊申論', [
      { heading: '一', text: '警察資訊系統依職務控管權限，並保存操作紀錄。' },
    ], { exam: '114年警察特考資訊申論', questionNo: 1 });
    const plan = domain.validateExamPlan({ id: 'exam_resume-h2-2026', title: '114年警察特考資訊申論',
      questions: [{ questionNo: 1, question: '警察資訊系統如何管理？', answerId: doc.id },
        { questionNo: 2, question: '資通安全風險如何管理？' }, { questionNo: 3, question: '如何保護個人資料？' }],
      formats: ['pdf', 'docx'], version: 1, createdAt: timestamp, updatedAt: timestamp });
    await store.saveExam(plan);
    const examDir = path.join(root, 'exam-records');
    await fs.mkdir(examDir, { recursive: true });
    await fs.rename(path.join(`${store.answerDir}-exams`, `${plan.id}.json`), path.join(examDir, `${plan.id}.json`));
    await fs.rmdir(`${store.answerDir}-exams`);
  },
  't-boundary-verify': () => answer('t-boundary-verify', '資通安全管理原則', [
    { heading: '一', text: '機關應建立資通安全管理制度並界定權責。' },
    { heading: '二', text: '定期辨識風險並依程序保存紀錄。' },
  ]),
  't-boundary-delete': () => answer('t-boundary-delete', '個資保存期限', [
    { heading: '一', text: '個人資料應依蒐集目的限制使用。' },
    { heading: '二', text: '保存期限屆滿後依規定安全刪除。' },
  ]),
  't-boundary-unsupported': () => answer('t-boundary-unsupported', '數位鑑識證據保全', [
    { heading: '一', text: '採證時應記錄來源、時間及處理人員。' },
    { heading: '二', text: '原始資料應妥善保存並維持完整性。' },
  ]),
};

const requested = process.argv.slice(2);
const names = requested.length ? requested : Object.keys(generators);
for (const name of names) if (!Object.hasOwn(generators, name)) throw new Error(`unknown seed: ${name}`);
if (!requested.length) await fs.rm(path.join(cwd, 'h2/seeds/paper166'), { recursive: true, force: true });
for (const name of names) await generators[name]();
console.log(`generated ${names.length} seeds via compiled creation/storage/layout APIs`);
