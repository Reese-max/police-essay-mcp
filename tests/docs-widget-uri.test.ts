import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createEssayMcpServer } from '../src/server.js';
import { FileStore } from '../src/storage.js';
import { ANSWER_SHEET_WIDGET_URI } from '../src/widget.js';

const repoRoot = new URL('../', import.meta.url);

function listMarkdownFiles(directory: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git' || entry.name.startsWith('.issue-loop')) continue;
    const path = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, directory);
    if (entry.isDirectory()) files.push(...listMarkdownFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path);
  }
  return files;
}

const staleBaseUri = ANSWER_SHEET_WIDGET_URI.replace(/-v\d+\.html$/, '.html');
const staleBaseUriPrefix = staleBaseUri.replace('.html', '');

test('markdown documents must reference only the registered widget URI', () => {
  const stale: Array<{ file: string; uri: string }> = [];
  for (const file of listMarkdownFiles(repoRoot)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/ui:\/\/widget\/[^)\s"'`]+\.html/g)) {
      if (match[0] !== ANSWER_SHEET_WIDGET_URI) stale.push({ file: file.href, uri: match[0] });
    }
  }
  assert.deepEqual(stale, [], `stale widget URIs in docs: ${JSON.stringify(stale)}`);
  assert.ok(listMarkdownFiles(repoRoot).length > 0);
});

test('reading the retired widget URI fails with the requested URI, un-normalized', async () => {
  assert.notEqual(staleBaseUriPrefix, ANSWER_SHEET_WIDGET_URI.replace('.html', ''));
  const server = createEssayMcpServer(new FileStore());
  const client = new Client({ name: 'doc-uri-regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    await assert.rejects(client.readResource({ uri: staleBaseUri }), (error: Error) => {
      assert.match(error.message, /not found/);
      assert.ok(error.message.includes(staleBaseUri), `failure must mention the requested URI, got: ${error.message}`);
      return true;
    });
  } finally { await client.close(); await server.close(); }
});

test('reading the registered widget URI succeeds', async () => {
  const server = createEssayMcpServer(new FileStore());
  const client = new Client({ name: 'doc-uri-regression', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const resource = await client.readResource({ uri: ANSWER_SHEET_WIDGET_URI });
    assert.equal(resource.contents[0].uri, ANSWER_SHEET_WIDGET_URI);
    assert.ok('text' in resource.contents[0] && resource.contents[0].text, 'widget resource must carry inline HTML text');
    assert.match(String(resource.contents[0].text), /<html/i);
  } finally { await client.close(); await server.close(); }
});
