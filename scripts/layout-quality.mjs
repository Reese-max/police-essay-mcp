import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function parseValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseArgs(args) {
  const [answerDir, ...rest] = args;
  if (!answerDir || answerDir.startsWith('--')) {
    throw new Error('usage: node scripts/layout-quality.mjs <answerDir> [--option key=value ...] [--json out.json]');
  }
  const options = {};
  let jsonPath;
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--option') {
      const assignment = rest[++index];
      const separator = assignment?.indexOf('=');
      if (!assignment || separator < 1) throw new Error('--option requires key=value.');
      options[assignment.slice(0, separator)] = parseValue(assignment.slice(separator + 1));
    } else if (rest[index] === '--json') {
      jsonPath = rest[++index];
      if (!jsonPath) throw new Error('--json requires an output path.');
    } else {
      throw new Error(`unknown argument: ${rest[index]}`);
    }
  }
  return { answerDir: path.resolve(answerDir), options, jsonPath };
}

function formatCount(value) {
  return typeof value === 'boolean' ? (value ? 'yes' : 'no') : String(value);
}

function metricTotal(results, metric) {
  return results.reduce((sum, result) => sum + (Number(result.quality[metric]) || 0), 0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { answerDir, options, jsonPath } = parseArgs(process.argv.slice(2));
const [{ layoutSections }, { scoreLayout }, { templateSchema }, { decodeAnswer }] = await Promise.all([
  import(pathToFileURL(path.join(root, 'dist/src/layout.js'))),
  import(pathToFileURL(path.join(root, 'dist/src/layout-quality.js'))),
  import(pathToFileURL(path.join(root, 'dist/src/domain.js'))),
  import(pathToFileURL(path.join(root, 'dist/src/answer-codec.js'))),
]);

const templateCache = new Map();
async function loadTemplate(templateId) {
  if (!templateCache.has(templateId)) {
    if (typeof templateId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(templateId)) {
      throw new Error(`invalid template id: ${String(templateId)}`);
    }
    const file = path.join(root, 'templates', `${templateId}.json`);
    const template = templateSchema.parse(JSON.parse(await fs.readFile(file, 'utf8')));
    templateCache.set(templateId, template);
  }
  return templateCache.get(templateId);
}

const results = [];
for (const filename of (await fs.readdir(answerDir)).filter(name => name.toLowerCase().endsWith('.json')).sort()) {
  const file = path.join(answerDir, filename);
  try {
    const answer = decodeAnswer(JSON.parse(await fs.readFile(file, 'utf8')));
    const template = await loadTemplate(answer.templateId);
    const layoutOptions = { ...(answer.layoutOptions ?? {}), ...options };
    const report = layoutSections(template, answer.sections, layoutOptions);
    const quality = scoreLayout(template, answer, report);
    results.push({
      file: filename,
      id: answer.id,
      title: answer.title,
      templateId: answer.templateId,
      totalLines: report.totalLines,
      capacity: report.capacity,
      quality,
    });
  } catch (error) {
    results.push({
      file: filename,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const completed = results.filter(result => result.quality);
const failed = results.filter(result => result.error);
const totalLines = completed.reduce((sum, result) => sum + result.totalLines, 0);
const totalCapacity = completed.reduce((sum, result) => sum + result.capacity, 0);
const metricNames = [
  'flattenedStructure',
  'embeddedHeadingParagraphs',
  'misalignedContinuations',
  'hierarchyIssues',
  'indentInconsistency',
  'shortTailLines',
  'punctuationOnlyLines',
];
const totals = {
  answers: results.length,
  completed: completed.length,
  failed: failed.length,
  totalLines,
  capacity: totalCapacity,
  fill: totalCapacity ? Math.round((totalLines / totalCapacity) * 100) / 100 : 0,
  metrics: Object.fromEntries(metricNames.map(metric => [metric, {
    total: metricTotal(completed, metric),
    affected: completed.filter(result => result.quality[metric] === true || result.quality[metric] > 0).length,
  }])),
};

const headers = ['File', 'Lines', 'Fill', 'Flat', 'Embedded', 'Misaligned', 'Hierarchy', 'Indent', 'Tail', 'Punct'];
const rows = results.map(result => result.quality
  ? [
      result.file,
      `${result.totalLines}/${result.capacity}`,
      result.quality.fill.toFixed(2),
      formatCount(result.quality.flattenedStructure),
      result.quality.embeddedHeadingParagraphs,
      result.quality.misalignedContinuations,
      result.quality.hierarchyIssues,
      result.quality.indentInconsistency,
      result.quality.shortTailLines,
      result.quality.punctuationOnlyLines,
    ]
  : [result.file, `ERROR: ${result.error}`]);
const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => String(row[column] ?? '').length)));
const rowText = row => row.map((value, column) => String(value ?? '').padEnd(widths[column])).join(' | ').trimEnd();
console.log(rowText(headers));
console.log(widths.map(width => '-'.repeat(width)).join('-+-'));
for (const row of rows) console.log(rowText(row));

console.log(`\nTotals: answers=${totals.answers} completed=${totals.completed} failed=${totals.failed} lines=${totalLines}/${totalCapacity} fill=${totals.fill.toFixed(2)}`);
for (const metric of metricNames) {
  const summary = totals.metrics[metric];
  console.log(`  ${metric}: total=${summary.total} affected=${summary.affected}`);
}

if (jsonPath) {
  const output = path.resolve(jsonPath);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, `${JSON.stringify({ options, totals, results }, null, 2)}\n`);
  console.log(`JSON: ${output}`);
}

if (failed.length) process.exitCode = 1;
