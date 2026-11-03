// Synthetic HTTP exam acceptance. Predicted IDs are journalled before mutation.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Scope, success, verifyExports, type Rpc } from './e2e-support.js';
if (!process.argv[2] || !process.argv[3])
    throw Error('Usage: tsx scripts/http-exam-e2e.ts <baseUrl> <outDir> [ownerToken]');
const base = process.argv[2].replace(/\/+$/, '');
const directory = process.argv[3];
const token = process.env.E2E_OWNER_TOKEN || process.argv[4];
const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
const client = new Client({ name: 'cleanup-bounded-exam-e2e', version: '2' });
await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers } }));
const scope = new Scope('exam', base, directory);
const rpc: Rpc = async (name, args) => { scope.receipt.events.push({ name, args }); await scope.save(); return client.callTool({ name, arguments: args }); };
const call = async (name: string, args: Record<string, unknown>) => success(await rpc(name, args), name);
try {
    if (process.env.E2E_CLEANUP_ONLY === '1')
        await scope.recover(rpc);
    else
        await scope.run(rpc, async () => {
            const identity = scope.identity;
            const formats = ['pdf', 'docx'];
            const exam = await call('start_exam', { title: identity.marker, idempotencyKey: identity.examKey, formats, questions: [{ questionNo: 1 }, { questionNo: 2 }] });
            assert.equal(exam.examId, identity.examId);
            const expected = identity.answers.map(a => `第${a.slot}題合成內容：資訊安全治理與 Zero Trust 架構。`.repeat(4));
            const created = await call('create_answers', { examId: identity.examId, answers: identity.answers.map((a, i) => ({ title: a.title, questionNo: Number(a.slot), idempotencyKey: a.key, sections: [{ id: 'a', text: expected[i] }] })) });
            assert.deepEqual(created.answers.map((a: any) => a.answerId), identity.answers.map(a => a.id));
            assert.ok(created.answers.every((a: any) => !a.linkPending), 'answer link incomplete');
            scope.receipt.exports = [];
            for (const [index, own] of identity.answers.entries()) {
                const answer = (await call('read_answer', { answerId: own.id })).answer;
                assert.equal(answer.templateId, 'police_information_essay_165');
                // Bundles support only PDF/DOCX; TXT is verified through the supported single-answer API.
                const txt = await call('export_answer', { answerId: own.id, expectedVersion: answer.version, formats: ['txt'] });
                scope.receipt.exports.push(...await verifyExports(txt, ['txt'], [expected[index]], { base, headers, readResource: a => client.readResource(a), save: async (f, b) => { await fs.writeFile(path.join(directory, `question-${own.slot}-${identity.runId}.${f}`), b); } }));
                await scope.save();
            }
            const progress = await call('get_exam_progress', { examId: identity.examId });
            assert.deepEqual(progress.questions.map((q: any) => q.answerId), identity.answers.map(a => a.id));
            await call('render_exam_overview', { examId: identity.examId });
            const bundle = await call('export_exam_bundle', { examId: identity.examId, formats });
            scope.receipt.exports.push(...await verifyExports(bundle, formats, expected, { base, headers, readResource: a => client.readResource(a), save: async (f, b) => { await fs.writeFile(path.join(directory, `bundle-${identity.runId}.${f}`), b); } }));
            await scope.save();
            const end = await call('get_exam_progress', { examId: identity.examId });
            assert.equal(end.nextStep.action, 'done');
            assert.equal(end.delivery.status, 'awaiting_review');
        });
}
finally {
    await client.close();
}
console.log(process.env.E2E_CLEANUP_ONLY === '1' ? 'HTTP_EXAM_E2E_CLEANUP_OK' : 'HTTP_EXAM_E2E_OK', scope.file);
