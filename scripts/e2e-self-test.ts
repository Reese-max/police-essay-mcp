// Opt-in, real loopback HTTP acceptance of the CLI harnesses, including persisted-write failures.
// No credentials, external service, model, or production data. Requires approved paper font + pdftotext.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHttpHandler } from '../src/index.js';
import { FileStore } from '../src/storage.js';
assert.ok(process.env.ESSAY_MCP_PAPER_FONT, 'explicit approved ESSAY_MCP_PAPER_FONT required');
const root = path.resolve(process.env.E2E_SELF_TEST_DIR ?? `tmp/e2e-self-test-${randomUUID()}`);
await fs.mkdir(root, { recursive: true });
const receipts: any[] = [];
for (const mode of ['resource', 'http'] as const) {
    const store = new FileStore({ templateDir: path.resolve('templates'), answerDir: path.join(root, mode, 'answers'), exportDir: path.join(root, mode, 'exports') });
    await store.ensureDirectories();
    let fault = 'none';
    const originalExport = store.createExportHandle.bind(store);
    store.createExportHandle = async (file, details) => { if (fault === 'partial-export' && details.format === 'pdf')
        throw Error('injected PDF handle failure'); return originalExport(file, details); };
    const originalSave = store.saveAnswer.bind(store);
    let saves = 0;
    store.saveAnswer = async (answer, options) => {
        if (fault === 'partial-create' && ++saves === 2)
            throw Error('injected second save failure');
        await originalSave(answer, options);
        if (fault === 'persisted-create' && ++saves === 1)
            throw Error('injected response failure after durable save');
    };
    const originalDelete = store.deleteAnswer.bind(store);
    store.deleteAnswer = async (id, options) => { if (fault === 'cleanup')
        throw Error('injected cleanup failure'); return originalDelete(id, options); };
    // Obtain an ephemeral port without starting any externally accessible listener.
    const server = createServer();
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const env = { HOST: '127.0.0.1', PORT: String(address.port), AUTH_MODE: 'bearer', MCP_ALLOW_ANONYMOUS_LOOPBACK: 'true', ...(mode === 'http' ? { ESSAY_PUBLIC_BASE_URL: base } : {}) };
    server.on('request', createHttpHandler(store, env));
    async function run(kind: 'single' | 'exam', scenario: string, shouldPass: boolean, runId = randomUUID(), cleanup = false) {
        const out = path.join(root, mode, `${kind}-${scenario}`);
        await fs.mkdir(out, { recursive: true });
        const script = kind === 'single' ? 'scripts/http-e2e.ts' : 'scripts/http-exam-e2e.ts';
        const args = ['--import', 'tsx', script, base, ...(kind === 'exam' ? [out] : [])];
        const code = await new Promise<number>((resolve, reject) => {
            const child = spawn(process.execPath, args, { env: { ...process.env, E2E_OWNER_TOKEN: '', E2E_RECEIPT_DIR: out, E2E_RUN_ID: runId, E2E_CLEANUP_ONLY: cleanup ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
            const chunks: Buffer[] = [];
            child.stdout.on('data', b => chunks.push(b));
            child.stderr.on('data', b => chunks.push(b));
            const timer = setTimeout(() => { child.kill(); reject(Error(`timeout: ${kind} ${scenario}; journal retained at ${out}`)); }, 120000);
            child.on('error', e => { clearTimeout(timer); reject(e); });
            child.on('exit', async (code) => { clearTimeout(timer); await fs.writeFile(path.join(out, cleanup ? 'recovery.log' : 'cli.log'), Buffer.concat(chunks)); resolve(code ?? -1); });
        });
        const receipt = JSON.parse(await fs.readFile(path.join(out, `receipt-${kind}-${runId}.json`), 'utf8'));
        receipts.push({ mode, kind, scenario, code, receipt });
        await fs.writeFile(path.join(root, 'results.json'), JSON.stringify(receipts, null, 2));
        if (shouldPass)
            assert.equal(code, 0, `${kind} ${scenario}: see ${out}`);
        else
            assert.notEqual(code, 0, `${kind} ${scenario} incorrectly passed`);
        if (shouldPass && !cleanup) {
            assert.equal(receipt.cleanup, 'passed');
            assert.equal(receipt.success, true);
            const files = kind === 'single' ? receipt.exports.flat() : receipt.exports;
            assert.ok(files.every((f: any) => f.mode === mode));
            assert.ok(['pdf', 'docx', 'txt'].every(f => files.some((e: any) => e.format === f)));
        }
        if (!shouldPass) {
            assert.equal(receipt.success, false);
            if (scenario === 'cleanup') {
                assert.equal(receipt.cleanup, 'failed');
                assert.equal(receipt.failure, undefined, 'cleanup injection must not hide a body failure');
            }
            else {
                assert.equal(receipt.cleanup, 'passed');
                assert.match(receipt.failure, scenario === 'partial-export' ? /partial export failed/ : /create_answers/);
            }
        }
        return runId;
    }
    try {
        await run('single', 'positive', true);
        await run('exam', 'positive', true);
        if (mode === 'resource') {
            fault = 'partial-export';
            await run('single', 'partial-export', false);
            fault = 'none';
            assert.equal((await store.listAnswers()).length, 0);
            saves = 0;
            fault = 'persisted-create';
            await run('exam', 'persisted-create', true);
            fault = 'none';
            saves = 0;
            fault = 'partial-create';
            await run('exam', 'partial-create', false);
            fault = 'none';
            assert.equal((await store.listAnswers()).length, 0);
            assert.equal((await store.listExams()).length, 0);
            fault = 'cleanup';
            const id = await run('exam', 'cleanup', false);
            fault = 'none';
            assert.ok((await store.listAnswers()).length > 0, 'fault must leave recoverable own records');
            await run('exam', 'cleanup', true, id, true);
        }
        assert.equal((await store.listAnswers()).length, 0);
        assert.equal((await store.listExams()).length, 0);
    }
    finally {
        server.closeAllConnections();
        await new Promise<void>(r => server.close(() => r()));
    }
}
console.log('E2E_SELF_TEST_OK', root);
