import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { templateSchema, createAnswerDocument } from '../src/domain.js';
import { layoutSections } from '../src/layout.js';
import { exportDocx, exportPdf } from '../src/exporters.js';
const template = templateSchema.parse(JSON.parse(readFileSync('templates/police_information_essay_165.json', 'utf8')));
const blocks = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {text: string; kind: string}[];
const answer = createAnswerDocument({templateId: template.id, title: '驗證', sections: blocks.map((b, i) => ({id: `block_${i}`, text: b.text}))});
const report = layoutSections(template, answer.sections);
console.log(JSON.stringify({lines:report.totalLines, fits:report.fits}));
mkdirSync('exports/paper165-qa', {recursive:true});
writeFileSync('exports/paper165-qa/layout.json', JSON.stringify(report));
if (report.fits) {
 await exportDocx(report, template, 'exports/paper165-qa/answer.docx');
 await exportPdf(report, template, 'exports/paper165-qa/answer.pdf');
}
