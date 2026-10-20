import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ownerToken = "issue-1-owner-test-token";
const readToken = "issue-1-read-test-token";

// Every request in this file targets loopback or a LAN interface; ambient
// proxy settings would reroute the remote-path probes and make them flaky.
for (const name of Object.keys(process.env)) {
  if (/^(?:https?|all)_proxy$/iu.test(name)) delete process.env[name];
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function stopServer(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exit = once(child, "exit");
  child.kill();
  await exit;
}

async function spawnServer(overrides: Record<string, string> = {}): Promise<{
  child: ChildProcess;
  port: number;
  root: string;
  logs: string[];
}> {
  const port = await freePort();
  const root = await mkdtemp(path.join(projectRoot, "tmp-http-security-"));
  const logs: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", path.join(projectRoot, "src", "index.ts")], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      MCP_AUTH_TOKEN: ownerToken,
      MCP_READ_TOKEN: readToken,
      MCP_ALLOW_ANONYMOUS_LOOPBACK: "false",
      MCP_ALLOW_ANONYMOUS_REMOTE: "false",
      CORS_ORIGIN: "https://trusted.example",
      ESSAY_MCP_TEMPLATE_DIR: path.join(projectRoot, "templates"),
      ESSAY_MCP_ANSWER_DIR: path.join(root, "answers"),
      ESSAY_MCP_EXPORT_DIR: path.join(root, "exports"),
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString()));
  return { child, port, root, logs };
}

async function waitForReady(runtime: Awaited<ReturnType<typeof spawnServer>>): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (runtime.child.exitCode !== null) throw new Error(`Server exited: ${runtime.logs.join("")}`);
    try {
      const response = await fetch(`http://127.0.0.1:${runtime.port}/readyz`);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become ready: ${runtime.logs.join("")}`);
}

async function connectClient(port: number, token?: string, origin?: string, hostname = "127.0.0.1"): Promise<Client> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  const transport = new StreamableHTTPClientTransport(new URL(`http://${hostname}:${port}/mcp`), {
    requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
  });
  const client = new Client({ name: "issue-1-security-test", version: "0.1.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

type InterfaceAddress = {
  address: string;
  family: string;
  internal: boolean;
};

type InterfaceMap = Record<string, readonly InterfaceAddress[] | undefined>;

// A host's non-loopback IPv4 address can exercise LAN or local-overlay routing.
// That is useful coverage, but it is not evidence of a real HTTPS tunnel.
function nonLoopbackAddress(interfaces: InterfaceMap = os.networkInterfaces()): string | undefined {
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) return address.address;
    }
  }
  return undefined;
}

test("HTTP rejects missing credentials at startup even when a tunnel targets loopback", async () => {
  for (const overrides of [
    { HOST: "127.0.0.1", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_LOOPBACK: "false" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_LOOPBACK: "false" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_LOOPBACK: "true" },
  ]) {
    const runtime = await spawnServer(overrides);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const exit = await Promise.race([
        once(runtime.child, "exit"),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Server did not fail closed")), 90_000); }),
      ]);
      assert.notEqual(exit[0], 0);
      assert.match(runtime.logs.join(""), /MCP_AUTH_TOKEN|MCP_ALLOW_ANONYMOUS_LOOPBACK/u);
      await assert.rejects(fetch(`http://127.0.0.1:${runtime.port}/mcp`));
    } finally {
      if (timeout) clearTimeout(timeout);
      await stopServer(runtime.child);
      await rm(runtime.root, { recursive: true, force: true });
    }
  }
});

test("owner and read credentials enforce the HTTP boundary before storage", async () => {
  const runtime = await spawnServer();
  let owner: Client | undefined;
  let reader: Client | undefined;
  try {
    await waitForReady(runtime);
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const authorization of [undefined, "Bearer wrong-token"]) {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
          method,
          headers: authorization ? { authorization, origin: "https://untrusted.example" } : { origin: "https://untrusted.example" },
        });
        assert.equal(response.status, 401, `${method} ${authorization ?? "missing token"}`);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer\s/, `${method} ${authorization ?? "missing token"} challenge`);
      }
    }
    assert.deepEqual(await readdir(path.join(runtime.root, "answers")), []);
    assert.deepEqual(await readdir(path.join(runtime.root, "exports")), []);

    const trusted = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://trusted.example" },
    });
    assert.equal(trusted.status, 204);
    assert.equal(trusted.headers.get("access-control-allow-origin"), "https://trusted.example");
    const untrusted = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://untrusted.example" },
    });
    assert.equal(untrusted.status, 403);
    assert.equal(untrusted.headers.get("access-control-allow-origin"), null);

    owner = await connectClient(runtime.port, ownerToken);
    const created = await owner.callTool({
      name: "create_answer",
      arguments: {
        templateId: "police_information_essay",
        title: "Security boundary test",
        sections: [{ id: "intro", text: "Original answer" }],
      },
    });
    assert.equal(created.isError, undefined);
    const answer = created.structuredContent as { answer: { id: string; version: number } };
    const ownerList = await owner.callTool({ name: "list_answers", arguments: {} });
    assert.equal(ownerList.isError, undefined);
    const ownerAnswers = ownerList.structuredContent as { answers: Array<{ id: string }> };
    assert.ok(ownerAnswers.answers.some((item) => item.id === answer.answer.id));
    reader = await connectClient(runtime.port, readToken);
    const toolNames = (await reader.listTools()).tools.map((tool) => tool.name);
    for (const name of ["list_answers", "read_answer", "check_layout"]) assert.ok(toolNames.includes(name));
    for (const name of ["create_answer", "write_answer", "replace_text", "format_section", "insert_text", "delete_text", "edit_text", "restore_revision",
      "export_docx", "export_text", "export_pdf"]) {
      assert.ok(!toolNames.includes(name), `${name} exposed to read credential`);
    }
    const listed = await reader.callTool({ name: "list_answers", arguments: {} });
    assert.equal(listed.isError, undefined);
    const answers = listed.structuredContent as { answers: Array<{ id: string }> };
    assert.ok(answers.answers.some((item) => item.id === answer.answer.id));
    const read = await reader.callTool({ name: "read_answer", arguments: { answerId: answer.answer.id } });
    assert.equal(read.isError, undefined);
    const rendered = await reader.callTool({ name: "render_answer_sheet", arguments: { answerId: answer.answer.id } });
    assert.equal(rendered.isError, undefined);
    assert.equal(rendered._meta?.readOnly, true);
    for (const [name, args] of [
      ["write_answer", { answerId: answer.answer.id, sections: [], expectedVersion: 1 }],
      ["delete_text", { answerId: answer.answer.id, sectionId: "intro", expectedVersion: 1 }],
      ["export_text", { answerId: answer.answer.id, filename: "denied.txt" }],
    ] as const) {
      const denied = await reader.callTool({ name, arguments: args });
      assert.equal(denied.isError, true, `${name} should be denied`);
    }
    assert.equal((await readdir(path.join(runtime.root, "answers"))).length, 1);
    assert.deepEqual(await readdir(path.join(runtime.root, "exports")), []);
    const unchanged = await owner.callTool({ name: "read_answer", arguments: { answerId: answer.answer.id } });
    const snapshot = unchanged.structuredContent as { answer: { version: number; sections: Array<{ text: string }> } };
    assert.equal(snapshot.answer.version, 1);
    assert.equal(snapshot.answer.sections[0].text, "Original answer");
  } finally {
    await reader?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("nonLoopbackAddress selects only an external IPv4 interface", () => {
  const syntheticInterfaces: InterfaceMap = {
    loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    ipv6: [{ address: "2001:db8::1", family: "IPv6", internal: false }],
    lan: [{ address: "192.0.2.25", family: "IPv4", internal: false }],
  };

  assert.equal(nonLoopbackAddress(syntheticInterfaces), "192.0.2.25");
  assert.equal(nonLoopbackAddress({ loopback: syntheticInterfaces.loopback, ipv6: syntheticInterfaces.ipv6 }), undefined);
});

test("LAN-path requests without owner credentials get a Bearer-challenged 401 before storage", async (t) => {
  // HOST=0.0.0.0 plus a real non-loopback dial exercises a LAN/overlay path.
  // It deliberately does not claim to exercise TLS or a public tunnel.
  const remoteHost = nonLoopbackAddress();
  if (!remoteHost) {
    t.skip("LAN-path integration NOT_RUN: no eligible non-loopback IPv4 interface");
    return;
  }

  const runtime = await spawnServer({ HOST: "0.0.0.0" });
  let owner: Client | undefined;
  let reader: Client | undefined;
  try {
    await waitForReady(runtime);
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const authorization of [undefined, "Bearer wrong-token"]) {
        const response: Response = await fetch(`http://${remoteHost}:${runtime.port}/mcp`, {
          method,
          headers: authorization ? { authorization } : {},
        });
        assert.equal(response.status, 401, `remote ${method} ${authorization ?? "missing token"}`);
        assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer\s/, `remote ${method} ${authorization ?? "missing token"} challenge`);
      }
    }
    assert.deepEqual(await readdir(path.join(runtime.root, "answers")), []);
    assert.deepEqual(await readdir(path.join(runtime.root, "exports")), []);

    owner = await connectClient(runtime.port, ownerToken, undefined, remoteHost);
    const ownerList = await owner.callTool({ name: "list_answers", arguments: {} });
    assert.equal(ownerList.isError, undefined);

    reader = await connectClient(runtime.port, readToken, undefined, remoteHost);
    const toolNames = (await reader.listTools()).tools.map((tool) => tool.name);
    for (const name of ["create_answer", "write_answer", "delete_text", "export_text"]) {
      assert.ok(!toolNames.includes(name), `${name} exposed to remote read credential`);
    }
  } finally {
    await reader?.close().catch(() => undefined);
    await owner?.close().catch(() => undefined);
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("anonymous loopback requires explicit opt-in and never enables browser origins by default", async () => {
  const runtime = await spawnServer({ MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_LOOPBACK: "true", CORS_ORIGIN: "" });
  let client: Client | undefined;
  try {
    await waitForReady(runtime);
    const blocked = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://outside.example" },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
    client = await connectClient(runtime.port);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "create_answer"));
  } finally {
    await client?.close().catch(() => undefined);
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("anonymous remote requires explicit opt-in, refuses tokens and OAuth, and still blocks browser origins", async () => {
  // Only the exact string "true" opts in; anything else falls back to the token requirement.
  for (const overrides of <Record<string, string>[]>[
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "TRUE", CORS_ORIGIN: "" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true ", CORS_ORIGIN: "" },
  ]) {
    const runtime = await spawnServer(overrides);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const exit = await Promise.race([
        once(runtime.child, "exit"),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Server did not fail closed")), 90_000); }),
      ]);
      assert.notEqual(exit[0], 0);
      assert.match(runtime.logs.join(""), /MCP_AUTH_TOKEN/u);
    } finally {
      if (timeout) clearTimeout(timeout);
      await stopServer(runtime.child);
      await rm(runtime.root, { recursive: true, force: true });
    }
  }
  for (const overrides of <Record<string, string>[]>[
    { HOST: "0.0.0.0", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "" },
    { HOST: "0.0.0.0", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "", MCP_ALLOW_ANONYMOUS_LOOPBACK: "true" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "https://trusted.example" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "", AUTH_MODE: "oauth",
      OAUTH_RESOURCE_URL: "https://mcp.example/mcp", OAUTH_ISSUERS: "https://issuer.example", OAUTH_JWKS_URI: "https://issuer.example/jwks" },
    { HOST: "0.0.0.0", MCP_AUTH_TOKEN: "", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "", AUTH_MODE: "both",
      OAUTH_RESOURCE_URL: "https://mcp.example/mcp", OAUTH_ISSUERS: "https://issuer.example", OAUTH_JWKS_URI: "https://issuer.example/jwks" },
  ]) {
    const runtime = await spawnServer(overrides);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const exit = await Promise.race([
        once(runtime.child, "exit"),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Server did not fail closed")), 90_000); }),
      ]);
      assert.notEqual(exit[0], 0);
      assert.match(runtime.logs.join(""), /MCP_ALLOW_ANONYMOUS_REMOTE/u);
    } finally {
      if (timeout) clearTimeout(timeout);
      await stopServer(runtime.child);
      await rm(runtime.root, { recursive: true, force: true });
    }
  }

  // Whitespace-only tokens keep the existing "unset" semantics.
  const runtime = await spawnServer({ HOST: "0.0.0.0", MCP_AUTH_TOKEN: "   ", MCP_READ_TOKEN: "", MCP_ALLOW_ANONYMOUS_REMOTE: "true", CORS_ORIGIN: "" });
  let client: Client | undefined;
  try {
    await waitForReady(runtime);
    assert.match(runtime.logs.join(""), /MCP_ALLOW_ANONYMOUS_REMOTE=true/u);
    const preflight = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, { method: "OPTIONS", headers: { origin: "https://outside.example" } });
    assert.equal(preflight.status, 403);
    for (const method of ["GET", "POST", "DELETE"]) {
      const browser = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
        method,
        headers: { origin: "https://outside.example", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: method === "POST" ? JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) : undefined,
      });
      assert.equal(browser.status, 403, `${method} with browser origin`);
    }
    const standaloneStream = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      headers: { accept: "text/event-stream" }, signal: AbortSignal.timeout(5_000),
    });
    assert.equal(standaloneStream.status, 405);
    assert.equal(standaloneStream.headers.get("allow"), "POST, DELETE");
    await standaloneStream.text();
    client = await connectClient(runtime.port);
    const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(toolNames, [
      "check_layout", "create_answer", "delete_answer", "delete_text", "edit_text", "export_docx", "export_pdf", "export_text", "format_section",
      "insert_text", "list_answers", "list_revisions", "list_templates", "load_exam_paper", "move_section", "preview_change", "read_answer",
      "reflow_answer", "render_answer_sheet", "renumber_items", "replace_text", "restore_revision", "set_line_targets", "write_answer",
    ]);
    const created = await client.callTool({ name: "create_answer", arguments: { title: "Anonymous remote", sections: [{ id: "intro", text: "Opt-in" }] } });
    assert.equal(created.isError, undefined);
    assert.equal((await readdir(path.join(runtime.root, "answers"))).length, 1);
    const answerId = (created.structuredContent as { answer: { id: string } }).answer.id;
    const written = await client.callTool({ name: "write_answer", arguments: { answerId, expectedVersion: 1, sections: [{ id: "intro", text: "Anonymous edit" }] } });
    assert.equal((written.structuredContent as { answer: { version: number } }).answer.version, 2);
    const exported = await client.callTool({ name: "export_text", arguments: { answerId } });
    assert.equal(exported.isError, undefined);
    const exportUri = (exported.structuredContent as { exportUri: string }).exportUri;
    const resource = await client.readResource({ uri: exportUri });
    const content = resource.contents[0] as { text?: string; blob?: string };
    assert.match(content.text ?? Buffer.from(content.blob ?? "", "base64").toString("utf8"), /Anonymous edit/u);
  } finally {
    await client?.close().catch(() => undefined);
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("IPv6 loopback CORS origin is accepted", async () => {
  const origin = "http://[::1]:3000";
  const runtime = await spawnServer({ CORS_ORIGIN: origin });
  try {
    await waitForReady(runtime);
    const preflight = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "OPTIONS",
      headers: { origin },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
  } finally {
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("authenticated same-origin clients work without a CORS grant", async () => {
  const runtime = await spawnServer({ CORS_ORIGIN: "" });
  let client: Client | undefined;
  try {
    await waitForReady(runtime);
    const preflight = await fetch(`http://127.0.0.1:${runtime.port}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://same.example" },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    client = await connectClient(runtime.port, ownerToken, "https://same.example");
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "read_answer"));
  } finally {
    await client?.close().catch(() => undefined);
    await stopServer(runtime.child);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("stdio remains available without HTTP credentials", async () => {
  const root = await mkdtemp(path.join(projectRoot, "tmp-stdio-security-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", path.join(projectRoot, "src", "index.ts")],
    cwd: projectRoot,
    env: {
      ...process.env,
      MCP_TRANSPORT: "stdio",
      MCP_AUTH_TOKEN: "",
      MCP_READ_TOKEN: "",
      ESSAY_MCP_TEMPLATE_DIR: path.join(projectRoot, "templates"),
      ESSAY_MCP_ANSWER_DIR: path.join(root, "answers"),
      ESSAY_MCP_EXPORT_DIR: path.join(root, "exports"),
    },
  });
  const client = new Client({ name: "issue-1-stdio-test", version: "0.1.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    assert.ok((await client.listTools()).tools.some((tool) => tool.name === "create_answer"));
  } finally {
    await client.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

