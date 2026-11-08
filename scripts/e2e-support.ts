import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { JSDOM } from 'jsdom';
import {renameReplacing} from '../src/storage.js';
export type Rpc = (name: string, args: Record<string, unknown>) => Promise<any>;
const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 40);
const text = (r: any) => (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text ?? '').join('\n');
export function success(r: any, name: string) { assert.notEqual(r.isError, true, `${name}: ${text(r)}`); assert.ok(r.structuredContent, `${name}: missing structuredContent`); return r.structuredContent; }
const compact = (s: string) => s.replace(/\s/gu, '');
export async function verifyExports(sc: any, formats: string[], expected: string[], io: {
    base: string;
    headers: Record<string, string>;
    readResource: (args: {
        uri: string;
    }) => Promise<any>;
    fetch?: typeof fetch;
    pdfText?: (b: Buffer) => string;
    save?: (format: string, b: Buffer) => Promise<void>;
}) {
    assert.ok(formats.length && new Set(formats).size === formats.length && formats.every(f => ['pdf', 'docx', 'txt'].includes(f)), 'invalid required formats');
    assert.ok(expected.length && expected.every(s => typeof s === 'string' && compact(s).length), 'expected content required');
    assert.ok(sc && Array.isArray(sc.files), 'missing files');
    assert.ok(sc.failed === undefined || Array.isArray(sc.failed), 'invalid failed');
    assert.equal(sc.failed?.length ?? 0, 0, 'partial export failed');
    assert.deepEqual(sc.files.map((f: any) => f.format).sort(), [...formats].sort(), 'missing, duplicate or unexpected format');
    const receipts = [];
    for (const f of sc.files) {
        const mime: Record<string, string> = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
        assert.ok(typeof f.exportUri === 'string' && /^essay:\/\/exports\/[^/]+$/.test(f.exportUri), 'invalid export URI');
        if (f.mimeType)
            assert.equal(f.mimeType, mime[f.format], 'file MIME mismatch');
        let bytes: Buffer, mode: string;
        if (f.downloadUrl) {
            assert.equal(new URL(f.downloadUrl).origin, new URL(io.base).origin, 'foreign download origin');
            const r = await (io.fetch ?? fetch)(f.downloadUrl, { headers: io.headers, redirect: 'error' });
            assert.equal(r.status, 200, 'download status');
            const type = r.headers.get('content-type');
            if (type)
                assert.equal(type.split(';')[0], mime[f.format], 'HTTP MIME mismatch');
            bytes = Buffer.from(await r.arrayBuffer());
            mode = 'http';
        }
        else {
            const r = await io.readResource({ uri: f.exportUri });
            const blobs = r.contents?.filter((c: any) => typeof c.blob === 'string') ?? [];
            assert.equal(blobs.length, 1, 'one resource blob required');
            const b = blobs[0];
            assert.equal(b.uri, f.exportUri, 'resource URI mismatch');
            assert.equal(b.mimeType, mime[f.format], 'resource MIME mismatch');
            bytes = Buffer.from(b.blob, 'base64');
            assert.equal(bytes.toString('base64'), b.blob, 'invalid base64');
            mode = 'resource';
        }
        assert.ok(bytes.length, 'empty bytes');
        let content: string;
        if (f.format === 'pdf') {
            assert.ok(bytes.subarray(0, 5).equals(Buffer.from('%PDF-')), 'invalid PDF');
            content = io.pdfText ? io.pdfText(bytes) : execFileSync(process.env.PDFTOTEXT ?? 'pdftotext', ['-layout', '-', '-'], { input: bytes, encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
        }
        else if (f.format === 'docx') {
            const zip = await JSZip.loadAsync(bytes);
            const member = zip.file('word/document.xml');
            assert.ok(member, 'missing DOCX document');
            const dom = new JSDOM(await member.async('string'), { contentType: 'text/xml' });
            content = dom.window.document.documentElement.textContent ?? '';
            dom.window.close();
        }
        else
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        for (const part of expected)
            assert.ok(compact(content).includes(compact(part)), `${f.format}: missing expected content`);
        await io.save?.(f.format, bytes);
        receipts.push({ format: f.format, mode, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    return receipts;
}
export function identities(mode: 'single' | 'exam', runId: string) {
    assert.match(runId, /^[A-Za-z0-9_-]{8,64}$/);
    const marker = `E2E-${runId}`;
    const examKey = `e2e_${runId}_exam`;
    const examId = `exam_idem-${hash(examKey)}`;
    return { mode, runId, marker, examKey, examId, answers: (mode === 'exam' ? ['1', '2'] : ['165', 'general']).map(slot => ({ slot, key: `e2e_${runId}_${slot}`, title: `${marker}-${slot}`, id: mode === 'exam' ? `ans_exam-${hash(`${examId}:${slot}`)}` : `ans_idem-${hash(`e2e_${runId}_${slot}`)}` })) };
}
function absent(r: any, kind: 'answer' | 'exam', id: string) {
    // FileStore and CloudStore currently expose different, explicit not-found messages.
    // Never treat an arbitrary isError/permission/network failure as absence.
    return r.isError === true && (kind === 'answer' ? text(r).startsWith(`找不到答案 ${id}`) : text(r).startsWith('找不到考試計畫') || text(r) === 'Exam not found.');
}
export class Scope {
    readonly identity;
    armed = false;
    readonly file: string;
    readonly receipt: any;
    constructor(mode: 'single' | 'exam', readonly base: string, readonly directory: string, runId = process.env.E2E_RUN_ID ?? randomUUID()) {
        this.identity = identities(mode, runId);
        this.file = path.join(directory, `receipt-${mode}-${runId}.json`);
        this.receipt = { ...this.identity, base, armed: false, events: [], cleanup: 'not_started' };
    }
    async save() {
        const temporary = `${this.file}.tmp-${randomUUID()}`;
        let collision = false;
        try {
            try { await fs.writeFile(temporary, JSON.stringify(this.receipt, null, 2), {flag:'wx'}); }
            catch (error) { collision = (error as NodeJS.ErrnoException).code === 'EEXIST'; throw error; }
            const handle = await fs.open(temporary, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
            // Same-directory replacement preserves the last-good receipt until publication.
            // Reuse the existing bounded Windows lock retries; never unlink the destination.
            await renameReplacing(temporary, this.file);
        } finally {
            if (!collision) await fs.rm(temporary, {force:true});
        }
    }
    async recover(rpc: Rpc) {
        assert.ok(process.env.E2E_RUN_ID, 'cleanup-only requires explicit E2E_RUN_ID');
        const saved = JSON.parse(await fs.readFile(this.file, 'utf8'));
        // Re-derive every deletable ID; never accept deletion targets from a journal.
        for (const [key, value] of Object.entries(this.identity))
            assert.deepEqual(saved[key], value, `receipt identity mismatch: ${key}`);
        assert.equal(saved.base, this.base, 'receipt server mismatch');
        assert.equal(saved.armed, true, 'receipt not armed');
        Object.assign(this.receipt, saved);
        this.armed = true;
        try {
            await this.cleanup(rpc);
            this.receipt.recovery = 'passed';
        }
        catch (e) {
            this.receipt.recovery = 'failed';
            await this.save();
            throw e;
        }
        await this.save();
    }
    async init(rpc: Rpc) {
        await fs.mkdir(this.directory, { recursive: true });
        await fs.writeFile(this.file, JSON.stringify(this.receipt, null, 2), { flag: 'wx' });
        for (const a of this.identity.answers) {
            const r = await rpc('read_answer', { answerId: a.id });
            assert.ok(absent(r, 'answer', a.id), `preexisting or unconfirmed answer; scope not armed: ${text(r)}`);
        }
        if (this.identity.mode === 'exam') {
            const r = await rpc('get_exam_progress', { examId: this.identity.examId });
            assert.ok(absent(r, 'exam', this.identity.examId), `preexisting or unconfirmed exam; scope not armed: ${text(r)}`);
        }
        this.armed = true;
        this.receipt.armed = true;
        await this.save();
    }
    async cleanup(rpc: Rpc) {
        if (!this.armed)
            return;
        const errors: unknown[] = [];
        for (const a of this.identity.answers)
            try {
                const r = await rpc('read_answer', { answerId: a.id });
                if (absent(r, 'answer', a.id))
                    continue;
                const answer = success(r, 'cleanup read').answer;
                assert.equal(answer.id, a.id);
                assert.ok(answer.title === a.title || answer.title === a.title + '-renamed', 'cleanup ownership mismatch');
                assert.ok(Number.isInteger(answer.version) && answer.version > 0);
                success(await rpc('delete_answer', { answerId: a.id, expectedVersion: answer.version }), 'cleanup delete');
                assert.ok(absent(await rpc('read_answer', { answerId: a.id }), 'answer', a.id), 'answer still exists after cleanup');
            }
            catch (e) {
                errors.push(e);
            }
        if (this.identity.mode === 'exam' && !errors.length)
            try {
                const r = await rpc('get_exam_progress', { examId: this.identity.examId });
                if (!absent(r, 'exam', this.identity.examId)) {
                    const p = success(r, 'cleanup progress');
                    assert.equal(p.title, this.identity.marker);
                    assert.ok(p.questions.every((q: any) => !q.answerId || this.identity.answers.some(a => a.id === q.answerId)), 'foreign linked answer; refusing exam delete');
                    success(await rpc('delete_exam', { examId: this.identity.examId, expectedVersion: p.version }), 'cleanup exam');
                    assert.ok(absent(await rpc('get_exam_progress', { examId: this.identity.examId }), 'exam', this.identity.examId), 'exam still exists');
                }
            }
            catch (e) {
                errors.push(e);
            }
        this.receipt.cleanup = errors.length ? 'failed' : 'passed';
        this.receipt.cleanupErrors = errors.map(String);
        await this.save();
        if (errors.length)
            throw new AggregateError(errors, 'E2E cleanup incomplete; see receipt');
    }
    async run(rpc: Rpc, body: () => Promise<void>) {
        await this.init(rpc);
        const errors: unknown[] = [];
        try {
            await body();
        }
        catch (e) {
            errors.push(e);
            this.receipt.failure = String(e);
        }
        try {
            await this.cleanup(rpc);
        }
        catch (e) {
            errors.push(e);
        }
        this.receipt.success = !errors.length;
        await this.save();
        if (errors.length)
            throw new AggregateError(errors, 'E2E failed; see receipt');
    }
}
