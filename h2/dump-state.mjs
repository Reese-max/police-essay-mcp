import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [buildDir, answerDir, exportDir, outFile] = process.argv.slice(2);
if (!buildDir || !answerDir || !exportDir || !outFile) {
  throw new Error('usage: node h2/dump-state.mjs <buildDir> <answerDir> <exportDir> <outFile>');
}
const root = path.resolve(buildDir);
const { FileStore } = await import(pathToFileURL(path.join(root, 'dist/src/storage.js')));
const { layoutSections } = await import(pathToFileURL(path.join(root, 'dist/src/layout.js')));
const { scoreLayout } = await import(pathToFileURL(path.join(root, 'dist/src/layout-quality.js')));
const { examProgress } = await import(pathToFileURL(path.join(root, 'dist/src/exam-progress.js')));
const store = new FileStore({ templateDir: path.join(root, 'templates'),
  answerDir: path.resolve(answerDir), exportDir: path.resolve(exportDir) });
const answers = [];
for (const answer of await store.listAnswers()) {
  const template = await store.getTemplate(answer.templateId);
  const report = layoutSections(template, answer.sections, answer.layoutOptions);
  const quality = scoreLayout(template, answer, report);
  answers.push({ id: answer.id, ...(answer.exam ? { exam: answer.exam } : {}),
    ...(answer.examId ? { examId: answer.examId } : {}),
    ...(answer.questionNo ? { questionNo: answer.questionNo } : {}),
    title: answer.title, templateId: answer.templateId, version: answer.version,
    fits: report.fits, totalLines: report.totalLines, capacity: report.capacity, quality,
    sections: answer.sections.map(section => ({ id: section.id, title: section.heading ?? '', text: section.text,
      headingStyle: { ...template.headingDefaults, ...section.headingStyle },
      paragraphs: (section.paragraphs ?? [{ text: section.text }]).map(paragraph => ({
        text: paragraph.text, ...template.paragraphDefaults, ...section.paragraphFormat, ...paragraph.format,
      })),
    })), ...(answer.lineTargets ? { lineTargets: answer.lineTargets } : {}),
  });
}
const exams = await store.listExams();
const exports = [];
for (const relative of await fs.readdir(path.resolve(exportDir), { recursive: true }).catch(() => [])) {
  const file = path.join(path.resolve(exportDir), relative);
  const stat = await fs.stat(file);
  if (!stat.isFile()) continue;
  const extension = path.extname(relative).slice(1).toLowerCase();
  if (extension === 'json') continue;
  exports.push({ file: relative, bytes: stat.size, kind: ['pdf', 'docx', 'txt'].includes(extension) ? extension : 'other' });
}
const examDump = await Promise.all(exams.map(async exam => ({ examId: exam.id,
  questionIds: exam.questions.map(question => question.answerId).filter(Boolean),
  plannedQuestions: exam.questions, progress: await examProgress(store, exam.id),
})));
await fs.mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
await fs.writeFile(outFile, JSON.stringify({ answers, exams: examDump, exports }, null, 2) + '\n');
