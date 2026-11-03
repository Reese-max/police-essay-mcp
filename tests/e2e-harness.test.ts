import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { Scope, verifyExports, type Rpc } from '../scripts/e2e-support.js';
const uri = 'essay://exports/test';
const mime = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
const expected = ['合成驗收內容 Zero Trust'];
const good = (structuredContent: any) => ({ structuredContent });
const missing = (kind: string, id: string) => ({ isError: true, content: [{ type: 'text', text: kind === 'answer' ? `找不到答案 ${id}。` : '找不到考試計畫。' }] });
const failure = () => ({ isError: true, content: [{ type: 'text', text: 'permission denied' }] });
const file = (format: string) => ({ format, exportUri: uri });
function resource(format: keyof typeof mime, bytes: Buffer = Buffer.from(expected[0])) {
    return { base: 'http://localhost', headers: {}, readResource: async () => ({ contents: [{ uri, mimeType: mime[format], blob: bytes.toString('base64') }] }) };
}
test('E2E exports reject partial, missing, duplicate and unexpected formats', async (t) => {
    for (const [label, sc] of Object.entries({ partial: { files: [file('txt')], failed: [{ format: 'pdf', error: 'injected' }] }, empty: { files: [] }, missing: { files: [file('pdf'), file('txt')] }, duplicate: { files: [file('pdf'), file('pdf'), file('txt')] }, unexpected: { files: [file('pdf'), file('docx'), file('txt'), file('svg')] }, malformed: { files: [], failed: 'not an array' } })) {
        await t.test(label, () => assert.rejects(verifyExports(sc, ['pdf', 'docx', 'txt'], expected, resource('txt'))));
    }
});
test('E2E resource mode decodes actual TXT and DOCX bytes without downloadUrl', async () => {
    const txt = await verifyExports({ files: [file('txt')] }, ['txt'], expected, resource('txt'));
    assert.equal(txt[0].mode, 'resource');
    assert.equal(txt[0].bytes, Buffer.byteLength(expected[0]));
    const zip = new JSZip();
    zip.file('word/document.xml', `<w:document xmlns:w="urn:test"><w:body><w:p><w:r><w:t>${expected[0]}</w:t></w:r></w:p></w:body></w:document>`);
    const docx = await verifyExports({ files: [file('docx')] }, ['docx'], expected, resource('docx', await zip.generateAsync({ type: 'nodebuffer' })));
    assert.equal(docx[0].mode, 'resource');
    assert.match(docx[0].sha256, /^[a-f0-9]{64}$/);
});
test('E2E rejects invalid resource envelopes and bytes', async (t) => {
    for (const [label, contents] of Object.entries({ textOnly: [{ uri, text: 'not binary' }], twoBlobs: [{ uri, blob: 'YQ==' }, { uri, blob: 'YQ==' }], wrongUri: [{ uri: 'essay://exports/other', mimeType: mime.txt, blob: 'YQ==' }], wrongMime: [{ uri, mimeType: mime.pdf, blob: 'YQ==' }], badBase64: [{ uri, mimeType: mime.txt, blob: '!!YQ==' }], empty: [{ uri, mimeType: mime.txt, blob: '' }] })) {
        await t.test(label, () => assert.rejects(verifyExports({ files: [file('txt')] }, ['txt'], expected, { ...resource('txt'), readResource: async () => ({ contents }) })));
    }
    await assert.rejects(verifyExports({ files: [file('txt')] }, ['txt'], expected, resource('txt', Buffer.from([255]))));
    await assert.rejects(verifyExports({ files: [file('txt')] }, ['txt'], expected, resource('txt', Buffer.from('unrelated content'))));
    await assert.rejects(verifyExports({ files: [file('docx')] }, ['docx'], expected, resource('docx')));
    const zip = new JSZip();
    zip.file('other.xml', 'anything');
    await assert.rejects(verifyExports({ files: [file('docx')] }, ['docx'], expected, resource('docx', await zip.generateAsync({ type: 'nodebuffer' }))), /missing DOCX/);
    // The PDF extractor injection tests the verification boundary; real Poppler runs are separate HTTP E2E evidence.
    await assert.rejects(verifyExports({ files: [file('pdf')] }, ['pdf'], expected, { ...resource('pdf'), pdfText: () => expected[0] }), /invalid PDF/);
    await assert.rejects(verifyExports({ files: [file('pdf')] }, ['pdf'], expected, { ...resource('pdf', Buffer.from('%PDF-1.7')), pdfText: () => '' }), /missing expected content/);
});
test('E2E HTTP mode validates status, MIME and content without leaking token to another origin', async () => {
    const f = { ...file('txt'), downloadUrl: 'http://localhost/exports/test' };
    let called = false;
    const io = { ...resource('txt'), headers: { Authorization: 'Bearer synthetic' }, fetch: (async (_url: any, options: any) => {
            called = true;
            assert.equal(options.headers.Authorization, 'Bearer synthetic');
            assert.equal(options.redirect, 'error');
            return new Response(expected[0], { headers: { 'content-type': 'text/plain; charset=utf-8' } });
        }) as typeof fetch };
    assert.equal((await verifyExports({ files: [f] }, ['txt'], expected, io))[0].mode, 'http');
    assert.equal(called, true);
    for (const response of [new Response('no', { status: 403 }), new Response(expected[0], { headers: { 'content-type': 'application/json' } }), new Response('incorrect', { headers: { 'content-type': 'text/plain' } })]) {
        await assert.rejects(verifyExports({ files: [f] }, ['txt'], expected, { ...io, fetch: (async () => response) as typeof fetch }));
    }
    called = false;
    await assert.rejects(verifyExports({ files: [{ ...f, downloadUrl: 'https://foreign.invalid/file' }] }, ['txt'], expected, io), /foreign download origin/);
    assert.equal(called, false);
});
async function fixture(mode: 'single' | 'exam' = 'exam') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'essay-harness-'));
    const scope = new Scope(mode, 'http://localhost', dir, 'fixture-run-1234');
    const answers = new Map<string, any>();
    let exam: any;
    const deleted: string[] = [];
    let fault: ((name: string, args: any) => any) | undefined;
    const rpc: Rpc = async (name, args) => {
        const f = fault?.(name, args);
        if (f !== undefined)
            return f;
        const id = String(args.answerId);
        if (name === 'read_answer')
            return answers.has(id) ? good({ answer: answers.get(id) }) : missing('answer', id);
        if (name === 'delete_answer') {
            assert.equal(args.expectedVersion, answers.get(id)?.version);
            deleted.push(id);
            answers.delete(id);
            return good({ deleted: true });
        }
        if (name === 'get_exam_progress')
            return exam ? good(exam) : missing('exam', String(args.examId));
        if (name === 'delete_exam') {
            assert.equal(args.examId, scope.identity.examId);
            assert.equal(args.expectedVersion, exam.version);
            deleted.push(exam.examId);
            exam = undefined;
            return good({ deleted: true });
        }
        throw Error(`unexpected RPC ${name}`);
    };
    const seed = (index: number) => { const a = scope.identity.answers[index]; answers.set(a.id, { id: a.id, title: a.title, version: 2 }); };
    const seedExam = (ids: string[] = []) => { exam = { examId: scope.identity.examId, title: scope.identity.marker, version: 3, questions: ids.map(answerId => ({ answerId })) }; };
    return { scope, rpc, answers, deleted, seed, seedExam, setFault: (f: typeof fault) => { fault = f; }, dispose: () => rm(dir, { recursive: true, force: true }) };
}
test('E2E partial batch and unlinked answer cleanup uses pre-journalled identities only', async () => {
    const f = await fixture();
    try {
        f.answers.set('existing-user-answer', { id: 'existing-user-answer', title: 'User', version: 99 });
        await assert.rejects(f.scope.run(f.rpc, async () => {
            const receipt = JSON.parse(await readFile(f.scope.file, 'utf8'));
            assert.equal(receipt.armed, true);
            assert.equal(receipt.answers.length, 2);
            f.seedExam();
            f.seed(1); // Commit succeeds but linking/response fails; no IDs returned to the harness.
            throw Error('injected batch response/link failure');
        }), /E2E failed/);
        assert.deepEqual(f.deleted, [f.scope.identity.answers[1].id, f.scope.identity.examId]);
        assert.equal(f.answers.size, 1);
        assert.ok(f.answers.has('existing-user-answer'));
        const receipt = JSON.parse(await readFile(f.scope.file, 'utf8'));
        assert.equal(receipt.cleanup, 'passed');
        assert.equal(receipt.success, false);
    }
    finally {
        await f.dispose();
    }
});
test('E2E ambiguous single create response is cleaned without a response ID', async () => {
    const f = await fixture('single');
    try {
        await assert.rejects(f.scope.run(f.rpc, async () => { f.seed(0); throw Error('connection lost after create'); }));
        assert.deepEqual(f.deleted, [f.scope.identity.answers[0].id]);
    }
    finally {
        await f.dispose();
    }
});
test('E2E cleanup failure propagates and preserves the original body failure', async (t) => {
    for (const kind of ['permission', 'delete-conflict', 'still-present'])
        await t.test(kind, async () => {
            const f = await fixture();
            try {
                await assert.rejects(f.scope.run(f.rpc, async () => {
                    f.seed(0);
                    f.seedExam();
                    f.setFault((name) => kind === 'permission' && name === 'read_answer' ? failure() : name === 'delete_answer' ? (kind === 'delete-conflict' ? failure() : kind === 'still-present' ? good({ deleted: true }) : undefined) : undefined);
                    throw Error('original export failure');
                }), (error: any) => { assert.equal(error.errors.length, 2); assert.match(String(error.errors[0]), /original export failure/); return true; });
                const receipt = JSON.parse(await readFile(f.scope.file, 'utf8'));
                assert.equal(receipt.cleanup, 'failed');
                assert.equal(receipt.success, false);
                assert.ok(!f.deleted.includes(f.scope.identity.examId));
            }
            finally {
                await f.dispose();
            }
        });
});
test('E2E preflight collision, foreign title and foreign exam links refuse deletion', async () => {
    const collision = await fixture();
    try {
        collision.seed(0);
        await assert.rejects(collision.scope.run(collision.rpc, async () => assert.fail('body must not run')));
        assert.deepEqual(collision.deleted, []);
        assert.equal(collision.scope.armed, false);
    }
    finally {
        await collision.dispose();
    }
    const foreign = await fixture();
    try {
        await assert.rejects(foreign.scope.run(foreign.rpc, async () => { foreign.seed(0); foreign.answers.get(foreign.scope.identity.answers[0].id).title = 'another owner'; }));
        assert.deepEqual(foreign.deleted, []);
    }
    finally {
        await foreign.dispose();
    }
    const links = await fixture();
    try {
        await assert.rejects(links.scope.run(links.rpc, async () => links.seedExam(['existing-user-answer'])));
        assert.deepEqual(links.deleted, []);
    }
    finally {
        await links.dispose();
    }
});
test('E2E preflight accepts only the actual CloudStore not-found contract', async () => {
    const f = await fixture();
    try {
        f.setFault(name => name === 'get_exam_progress' ? { isError: true, content: [{type:'text',text:'Exam not found.'}] } : undefined);
        await f.scope.run(f.rpc, async () => {});
        assert.equal(f.scope.receipt.success, true);
        assert.deepEqual(f.deleted, []);
    } finally { await f.dispose(); }
    for (const message of ['permission denied', 'Exam not found. permission denied']) {
        const denied = await fixture();
        try {
            denied.setFault(name => name === 'get_exam_progress' ? { isError: true, content: [{type:'text',text:message}] } : undefined);
            await assert.rejects(denied.scope.run(denied.rpc, async () => assert.fail('body must not run')), /scope not armed/);
            assert.equal(denied.scope.armed, false);
            assert.deepEqual(denied.deleted, []);
        } finally { await denied.dispose(); }
    }
});

test('E2E interrupted-run recovery re-derives bounded IDs and refuses tampered receipts', async () => {
    const original = process.env.E2E_RUN_ID;
    process.env.E2E_RUN_ID = 'fixture-run-1234';
    const f = await fixture();
    try {
        await f.scope.init(f.rpc);
        f.seed(0);
        f.seedExam([f.scope.identity.answers[0].id]);
        const saved = await readFile(f.scope.file, 'utf8');
        const tampered = JSON.parse(saved);
        tampered.answers[0].id = 'existing-user-answer';
        await writeFile(f.scope.file, JSON.stringify(tampered));
        const resumed = new Scope('exam', 'http://localhost', f.scope.directory);
        await assert.rejects(resumed.recover(f.rpc), /receipt identity mismatch/);
        assert.deepEqual(f.deleted, []);
        await writeFile(f.scope.file, saved);
        await assert.rejects(new Scope('exam', 'http://another-server', f.scope.directory).recover(f.rpc), /receipt server mismatch/);
        await resumed.recover(f.rpc);
        assert.deepEqual(f.deleted, [f.scope.identity.answers[0].id, f.scope.identity.examId]);
        assert.equal(JSON.parse(await readFile(f.scope.file, 'utf8')).recovery, 'passed');
    }
    finally {
        if (original === undefined)
            delete process.env.E2E_RUN_ID;
        else
            process.env.E2E_RUN_ID = original;
        await f.dispose();
    }
});
