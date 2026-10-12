import assert from "node:assert/strict";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const authToken = "integration-test-token";
const readToken = "integration-read-test-token";
const bodyLimit = 1_024;

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function waitForReady(port: number, child: ChildProcess, logs: string[]): Promise<void> {
  const url = `http://127.0.0.1:${port}/readyz`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`MCP server exited before readiness: ${logs.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      await response.text();
    } catch {
      // The child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for MCP server readiness: ${logs.join("")}`);
}

async function startServer(): Promise<{
  port: number;
  root: string;
  child: ChildProcess;
  logs: string[];
}> {
  const port = await freePort();
  const root = await mkdtemp(path.join(projectRoot, "tmp-mcp-http-"));
  const logs: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", path.join(projectRoot, "src", "index.ts")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_AUTH_TOKEN: authToken,
      MCP_READ_TOKEN: readToken,
      MCP_MAX_BODY_BYTES: String(bodyLimit),
      CORS_ORIGIN: "https://example.test",
      ESSAY_MCP_TEMPLATE_DIR: path.join(projectRoot, "templates"),
      ESSAY_MCP_ANSWER_DIR: path.join(root, "answers"),
      ESSAY_MCP_EXPORT_DIR: path.join(root, "exports"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  try {
    await waitForReady(port, child, logs);
  } catch (error) {
    await stopServer(child);
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return { port, root, child, logs };
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
}

async function request(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string> },
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request({ hostname: "127.0.0.1", port, ...options }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

async function chunkedRequest(port: number, body: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      method: "POST",
      path: "/mcp",
      headers: {
        authorization: `Bearer ${authToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    req.on("error", reject);
    for (let index = 0; index < body.length; index += 127) {
      req.write(body.slice(index, index + 127));
    }
    req.end();
  });
}

test("MCP round-trip enforces authentication, CORS, and chunked body limits", async () => {
  const runtime = await startServer();
  let client: Client | undefined;
  try {
    const health = await request(runtime.port, { method: "GET", path: "/health" });
    assert.equal(health.status, 200);
    assert.match(health.body, /"ok":true/);

    const unauthorized = await request(
      runtime.port,
      { method: "POST", path: "/mcp", headers: { "content-type": "application/json" } },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    );
    assert.equal(unauthorized.status, 401);

    const wrongToken = await request(
      runtime.port,
      {
        method: "POST",
        path: "/mcp",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
      },
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    );
    assert.equal(wrongToken.status, 401);

    const cors = await request(runtime.port, {
      method: "OPTIONS",
      path: "/mcp",
      headers: { origin: "https://example.test" },
    });
    assert.equal(cors.status, 204);
    assert.equal(cors.headers["access-control-allow-origin"], "https://example.test");
    assert.match(cors.headers["access-control-allow-headers"] ?? "", /authorization/);

    const oversizedBody = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { padding: "x".repeat(bodyLimit) } });
    const oversized = await request(
      runtime.port,
      {
        method: "POST",
        path: "/mcp",
        headers: {
          authorization: `Bearer ${authToken}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(oversizedBody)),
        },
      },
      oversizedBody,
    );
    assert.equal(oversized.status, 413);

    const chunked = await chunkedRequest(
      runtime.port,
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { padding: "x".repeat(bodyLimit) } }),
    );
    assert.equal(chunked.status, 413, chunked.body);

    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${authToken}` },
      },
    });
    client = new Client({ name: "police-essay-mcp-integration-test", version: "0.1.0" }, { capabilities: {} });
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    for (const name of ["preview_write_answer", "preview_replace_text", "preview_format_section", "preview_insert_text", "preview_delete_text"]) {
      assert.ok(toolNames.includes(name), `missing tool ${name}`);
    }
    const renderTool = tools.tools.find((tool) => tool.name === "render_answer_sheet");
    assert.ok(renderTool, "missing tool render_answer_sheet");
    const renderMeta = renderTool._meta as { ui?: { resourceUri?: string } } | undefined;
    assert.equal(renderMeta?.ui?.resourceUri, "ui://widget/police-essay-answer-sheet.html");

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === "ui://widget/police-essay-answer-sheet.html"));
    const widgetResource = await client.readResource({ uri: "ui://widget/police-essay-answer-sheet.html" });
    const widgetText = String(widgetResource.contents.find((content) => "text" in content)?.text ?? "");
    assert.match(widgetText, /警察資訊三等/);
    assert.match(widgetText, /tools\/call/);

    const created = await client.callTool({
      name: "create_answer",
      arguments: {
        templateId: "police_information_essay",
        title: "MCP round-trip 測試",
        sections: [{ id: "intro", heading: "前言", text: "這是一段測試內容。" }],
      },
    });
    assert.equal(created.isError, undefined);
    const createdSnapshot = created.structuredContent as { answer: { id: string; version: number }; layout: { fits: boolean } };
    assert.match(createdSnapshot.answer.id, /^ans_/);
    assert.equal(createdSnapshot.answer.version, 1);
    assert.equal(createdSnapshot.layout.fits, true);

    const rendered = await client.callTool({
      name: "render_answer_sheet",
      arguments: { answerId: createdSnapshot.answer.id },
    });
    assert.equal(rendered.isError, undefined);
    assert.equal(rendered._meta?.readOnly, false);
    const renderedSnapshot = rendered.structuredContent as { answer: { id: string }; layout: { lines: unknown[] } };
    assert.equal(renderedSnapshot.answer.id, createdSnapshot.answer.id);
    assert.ok(renderedSnapshot.layout.lines.length > 0);

    const preview = await client.callTool({
      name: "preview_format_section",
      arguments: {
        answerId: createdSnapshot.answer.id,
        sectionId: "intro",
        expectedVersion: 1,
        paragraphFormat: { firstLineIndent: 2, leftIndent: 1, alignment: "justify" },
      },
    });
    assert.equal(preview.isError, undefined);
    const previewContent = preview.structuredContent as { applied: boolean; baseVersion: number; after: { answer: { version: number } } };
    assert.equal(previewContent.applied, false);
    assert.equal(previewContent.baseVersion, 1);
    assert.equal(previewContent.after.answer.version, 2);

    const formatted = await client.callTool({
      name: "format_section",
      arguments: {
        answerId: createdSnapshot.answer.id,
        sectionId: "intro",
        expectedVersion: 1,
        paragraphFormat: { firstLineIndent: 2, leftIndent: 1, alignment: "justify" },
      },
    });
    assert.equal(formatted.isError, undefined);
    const formattedContent = formatted.structuredContent as { answer: { version: number }; section: { paragraphFormat?: { firstLineIndent?: number } } };
    assert.equal(formattedContent.answer.version, 2);
    assert.equal(formattedContent.section.paragraphFormat?.firstLineIndent, 2);

    const checked = await client.callTool({
      name: "check_layout",
      arguments: { answerId: createdSnapshot.answer.id },
    });
    const checkedContent = checked.structuredContent as { version: number; layout: { fits: boolean } };
    assert.equal(checkedContent.version, 2);
    assert.equal(checkedContent.layout.fits, true);

    const exported = await client.callTool({
      name: "export_text",
      arguments: { answerId: createdSnapshot.answer.id, filename: "round-trip.txt" },
    });
    assert.equal(exported.isError, undefined);
    const exportedContent = exported.structuredContent as { path: string; pages: number };
    assert.equal(exportedContent.pages, 2);
    assert.equal((await stat(exportedContent.path)).isFile(), true);
  } finally {
    await client?.close().catch(() => undefined);
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("independent HTTP MCP clients cannot overwrite the same accepted answer version", async () => {
  const runtime = await startServer();
  const clients: Client[] = [];
  try {
    for (const name of ["writer-a", "writer-b", "independent-writer"]) {
      const client = new Client({ name, version: "0.1.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${authToken}` } },
      }));
      clients.push(client);
    }
    for (let round = 0; round < 10; round++) {
      const create = async (client: Client, title: string) => {
        const result = await client.callTool({ name: "create_answer", arguments: {
          templateId: "police_information_essay", title,
          sections: [{ id: "intro", text: "初稿" }],
        } });
        assert.equal(result.isError, undefined);
        return (result.structuredContent as { answer: { id: string } }).answer.id;
      };
      const answerId = await create(clients[0], `重疊作答 ${round}`);
      const otherId = await create(clients[2], `獨立作答 ${round}`);
      const edit = (client: Client, id: string, text: string) => client.callTool({
        name: "write_answer", arguments: { answerId: id, expectedVersion: 1,
          sections: [{ id: "intro", text }],
        },
      });
      // Distinct SDK clients issue distinct HTTP requests to the child process;
      // the direct FileStore barrier tests separately pin the atomic critical section.
      const results = await Promise.all([
        edit(clients[0], answerId, "writer A"),
        edit(clients[1], answerId, "writer B"),
        edit(clients[2], otherId, "independent writer"),
      ]);
      const shared = results.slice(0, 2);
      assert.equal(shared.filter(result => !result.isError).length, 1);
      const rejected = shared.find(result => result.isError);
      assert.ok(rejected);
      assert.match(JSON.stringify(rejected.content), /Version conflict: expected 1, current version is 2/);
      assert.equal(results[2].isError, undefined);
      const winner = shared.find(result => !result.isError)!.structuredContent as {
        answer: { version: number; sections: Array<{ text: string }> };
      };
      const persisted = JSON.parse(await readFile(path.join(runtime.root, "answers", `${answerId}.json`), "utf8"));
      assert.equal(persisted.version, 2);
      assert.equal(persisted.sections[0].text, winner.answer.sections[0].text);
      const independent = JSON.parse(await readFile(path.join(runtime.root, "answers", `${otherId}.json`), "utf8"));
      assert.equal(independent.version, 2);
      assert.equal(independent.sections[0].text, "independent writer");
    }
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("concurrent exports sharing a filename retain each answer's immutable artifact", async () => {
  const runtime = await startServer();
  const clients: Client[] = [];
  try {
    for (let index = 0; index < 2; index++) {
      const client = new Client({ name: `essay-export-writer-${index}`, version: "0.1.0" }, { capabilities: {} });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${authToken}` } },
      }));
      clients.push(client);
    }
    for (let pair = 0; pair < 6; pair++) {
      const texts = [`EXPORT_A_${pair}`, `EXPORT_B_${pair}`];
      const created = await Promise.all(clients.map((client, index) => client.callTool({
        name: "create_answer",
        arguments: { templateId: "police_information_essay", title: `export-${index}-${pair}`,
          sections: [{ id: "intro", heading: "前言", text: texts[index] }] },
      })));
      const answerIds = created.map(result => {
        assert.equal(result.isError, undefined, JSON.stringify(result));
        return (result.structuredContent as { answer: { id: string } }).answer.id;
      });
      const exported = await Promise.all(clients.map((client, index) => client.callTool({
        name: "export_text", arguments: { answerId: answerIds[index], filename: `shared-export-${pair}` },
      })));
      const uris: string[] = [];
      for (let index = 0; index < exported.length; index++) {
        const result = exported[index];
        assert.equal(result.isError, undefined, JSON.stringify(result));
        const structured = result.structuredContent as { answerId: string; version: number; exportUri: string };
        assert.equal(structured.answerId, answerIds[index]);
        assert.equal(structured.version, 1);
        uris.push(structured.exportUri);
        const resource = await clients[index].readResource({ uri: structured.exportUri });
        const artifact = resource.contents[0] as { mimeType: string; blob: string };
        assert.equal(artifact.mimeType, "text/plain");
        const text = Buffer.from(artifact.blob, "base64").toString("utf8");
        assert.ok(text.includes(texts[index]), `artifact must contain its own answer: ${text}`);
        assert.ok(!text.includes(texts[1 - index]), "artifact must not contain the competing answer");
      }
      assert.notEqual(uris[0], uris[1]);
    }
  } finally {
    await Promise.all(clients.map(client => client.close().catch(() => undefined)));
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("export artifacts are owner-only opaque resources with bytes, MIME, and expiry", async () => {
  const runtime = await startServer();
  let owner: Client | undefined;
  let reader: Client | undefined;
  try {
    const ownerTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${authToken}` } },
    });
    owner = new Client({ name: "police-essay-mcp-export-artifact-owner-test", version: "0.1.0" }, { capabilities: {} });
    await owner.connect(ownerTransport);

    const created = await owner.callTool({
      name: "create_answer",
      arguments: {
        templateId: "police_information_essay",
        title: "匯出 artifact 測試",
        sections: [{ id: "intro", heading: "前言", text: "這是一段測試內容。" }],
      },
    });
    assert.equal(created.isError, undefined);
    const answerId = (created.structuredContent as { answer: { id: string } }).answer.id;

    const expectedMime = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      pdf: "application/pdf",
      txt: "text/plain",
    } as const;
    const uris: string[] = [];

    for (const format of ["docx", "pdf", "txt"] as const) {
      const exported = await owner.callTool({
        name: format === "txt" ? "export_text" : `export_${format}`,
        arguments: { answerId, filename: `artifact-round-trip-${format}` },
      });
      assert.equal(exported.isError, undefined, JSON.stringify(exported));
      const structured = exported.structuredContent as {
        answerId: string;
        version: number;
        format: string;
        path: string;
        exportUri: string;
        exportExpiresAt: string;
      };
      assert.equal(structured.answerId, answerId);
      assert.equal(structured.version, 1);
      assert.equal(structured.format, format);
      const expiresIn = Date.parse(structured.exportExpiresAt) - Date.now();
      assert.ok(expiresIn > 23 * 60 * 60 * 1000 && expiresIn <= 24 * 60 * 60 * 1000);

      const handle = structured.exportUri.slice("essay://exports/".length);
      assert.match(handle, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      assert.ok(!structured.exportUri.includes(`artifact-round-trip-${format}`));
      uris.push(structured.exportUri);

      const blocks = (exported.content ?? []) as Array<{ type: string; uri?: string; mimeType?: string }>;
      const link = blocks.find((block) => block.type === "resource_link");
      assert.ok(link);
      assert.equal(link.uri, structured.exportUri);
      assert.equal(link.mimeType, expectedMime[format]);

      const resource = await owner.readResource({ uri: structured.exportUri });
      assert.equal(resource.contents.length, 1);
      const artifact = resource.contents[0] as { uri: string; mimeType?: string; blob?: string };
      assert.equal(artifact.uri, structured.exportUri);
      assert.equal(artifact.mimeType, expectedMime[format]);
      const encoded = artifact.blob;
      assert.ok(encoded);
      const onDisk = await readFile(structured.path);
      assert.equal(Buffer.from(encoded, "base64").equals(onDisk), true);
    }

    const unauthenticated = await request(
      runtime.port,
      { method: "POST", path: "/mcp", headers: { "content-type": "application/json" } },
      JSON.stringify({
        jsonrpc: "2.0",
        id: 90,
        method: "resources/read",
        params: { uri: uris[0] },
      }),
    );
    assert.equal(unauthenticated.status, 401);

    const readerTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${runtime.port}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${readToken}` } },
    });
    reader = new Client({ name: "police-essay-mcp-export-artifact-reader-test", version: "0.1.0" }, { capabilities: {} });
    await reader.connect(readerTransport);
    await assert.rejects(
      () => reader!.readResource({ uri: uris[0] }),
      /.+/,
      "read token must not retrieve owner exports",
    );

    await assert.rejects(
      () => owner!.readResource({ uri: "essay://exports/00000000-0000-4000-8000-000000000000" }),
      /.+/,
      "unknown handle must fail closed",
    );
    await assert.rejects(
      () => owner!.readResource({ uri: "essay://exports/..%2Fsecret.txt" }),
      /.+/,
      "path traversal must fail closed",
    );

    const expiredHandle = uris[2].slice("essay://exports/".length);
    const manifestPath = path.join(runtime.root, "exports", ".artifacts", `${expiredHandle}.json`);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { createdAt: number; expiresAt: number };
    manifest.expiresAt = Date.now() - 1;
    manifest.createdAt = manifest.expiresAt - 24 * 60 * 60 * 1000;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      () => owner!.readResource({ uri: uris[2] }),
      /.+/,
      "expired handle must fail closed",
    );
  } finally {
    await reader?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

