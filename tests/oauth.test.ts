import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign, createHmac, type KeyObject } from "node:crypto";
import { createServer, request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createOAuthVerifier, principalOwnerKey, OAuthError, requireScope, oauthConfiguration } from "../src/oauth.js";
import { createHttpHandler } from "../src/index.js";
import { CloudStore } from "../src/cloud-storage.js";
import { FileStore } from "../src/storage.js";
import { MemoryFirestore, MemoryStorage } from "./fakes/cloud-clients.js";

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotated = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const issuer = "https://issuer.example", resource = "https://essay.example/mcp";
const time = Date.now();
const claims = { iss: issuer, aud: resource, sub: "alice", exp: time / 1000 + 600, scope: "essay.read essay.write essay.export" };
function jwt(patch: Record<string, unknown> = {}, header: Record<string, unknown> = {}, key: KeyObject = rsa.privateKey): string {
  const head = { alg: "RS256", kid: "rsa", ...header };
  const data = Buffer.from(JSON.stringify(head)).toString("base64url") + "." + Buffer.from(JSON.stringify({ ...claims, ...patch })).toString("base64url");
  const signature = head.alg === "none" ? Buffer.from("invalid") : head.alg === "HS256"
    ? createHmac("sha256", rsa.publicKey.export({ type: "spki", format: "pem" })).update(data).digest()
    : sign("sha256", Buffer.from(data), head.alg === "ES256" ? { key, dsaEncoding: "ieee-p1363" } : key);
  return data + "." + signature.toString("base64url");
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
async function jwksFixture() {
  let keys = [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa", alg: "RS256", use: "sig" },
    { ...ec.publicKey.export({ format: "jwk" }), kid: "ec", alg: "ES256", use: "sig" }];
  let requests = 0, failed = false;
  const server = createServer((_req, res) => { requests++; res.writeHead(failed ? 503 : 200, { "content-type": "application/json" }); res.end(JSON.stringify({ keys })); });
  const base = await listen(server);
  return { server, uri: base + "/jwks", requests: () => requests,
    rotate: () => { keys = [{ ...rotated.publicKey.export({ format: "jwk" }), kid: "rotated", alg: "RS256", use: "sig" }]; },
    fail: () => { failed = true; } };
}
async function connect(base: string, token: string) {
  const client = new Client({ name: "oauth-test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: "Bearer " + token } } }));
  return client;
}

test("OAuth RS256/ES256 validate pinned issuer, audience, dates, signature and algorithms", async () => {
  const jwks = await jwksFixture();
  try {
    const verify = createOAuthVerifier({ issuers: [issuer], resource, jwksUri: jwks.uri }, { now: () => time });
    const alice = await verify(jwt());
    assert.equal(alice.ownerKey, principalOwnerKey(issuer, "alice"));
    assert.notEqual(alice.ownerKey, principalOwnerKey(issuer, "bob"));
    assert.notEqual(alice.ownerKey, principalOwnerKey("https://other.example", "alice"));
    assert.equal((await verify(jwt({}, { alg: "ES256", kid: "ec" }, ec.privateKey))).sub, "alice");
    await verify(jwt({ aud: ["other", resource], nbf: time / 1000 + 20 }));
    for (const token of [jwt({ iss: "https://evil.example" }), jwt({ aud: "https://other.example" }),
      jwt({ exp: time / 1000 - 31 }), jwt({ nbf: time / 1000 + 31 }), jwt({ exp: "future" }), jwt({ sub: "" }),
      jwt({}, { alg: "none" }), jwt({}, { alg: "HS256" }), jwt({}, {}, rotated.privateKey),
      jwt({}, { alg: "ES256", kid: "rsa" }, ec.privateKey), jwt({}, { crit: ["anything"] }), "malformed"])
      await assert.rejects(verify(token), (e: unknown) => e instanceof OAuthError && e.status === 401);
    assert.equal(jwks.requests(), 1, "known kid algorithm mismatches reject without refetching JWKS");
    const requestsBeforeTokenUrls = jwks.requests();
    await verify(jwt({}, { jku: "https://evil.example/jwks", x5u: "https://evil.example/cert" }));
    assert.equal(jwks.requests(), requestsBeforeTokenUrls, "token URLs and valid cache do not trigger network requests");
    await assert.rejects(verify(jwt({ scope: "unrelated" })), (e: unknown) => e instanceof OAuthError && e.status === 403);
    assert.throws(() => requireScope({ scopes: ["essay.read"] }, "essay.write"), /insufficient_scope/);
  } finally { await close(jwks.server); }
});

test("JWKS unknown kid refreshes for rotation; unknown, unreachable and stale keys fail closed", async () => {
  const jwks = await jwksFixture();
  try {
    let now = time;
    const verify = createOAuthVerifier({ issuers: [issuer], resource, jwksUri: jwks.uri }, { now: () => now, ttlMs: 100, timeoutMs: 500 });
    await verify(jwt());
    jwks.rotate();
    await verify(jwt({}, { kid: "rotated" }, rotated.privateKey));
    assert.equal(jwks.requests(), 2);
    await assert.rejects(verify(jwt({}, { kid: "unknown" })), OAuthError);
    jwks.fail(); now += 100;
    await assert.rejects(verify(jwt({}, { kid: "rotated" }, rotated.privateKey)), OAuthError);
    await assert.rejects(verify(jwt({}, { kid: "rotated" }, rotated.privateKey)), OAuthError);
    const unreachable = createOAuthVerifier({ issuers: [issuer], resource, jwksUri: "http://127.0.0.1:1/jwks" }, { timeoutMs: 100 });
    await assert.rejects(unreachable(jwt()), OAuthError);
  } finally { await close(jwks.server); }
});

test("OAuth HTTP discovery, challenge, independent scopes and principal isolation enforce the real MCP boundary", async () => {
  const jwks = await jwksFixture();
  const firestore = new MemoryFirestore(), storage = new MemoryStorage();
  const store = new CloudStore({ firestore: firestore.client(), storage: storage.client(), environment: "staging", ownerKey: "0".repeat(64), artifactBucket: "synthetic-artifacts" });
  const server = createServer(createHttpHandler(store, { AUTH_MODE: "oauth", OAUTH_ISSUERS: issuer, OAUTH_RESOURCE_URL: resource, OAUTH_JWKS_URI: jwks.uri }));
  const base = await listen(server);
  const clients: Client[] = [];
  try {
    for (const p of ["/health", "/readyz", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) assert.equal((await fetch(base + p)).status, 200);
    const metadata = await (await fetch(base + "/.well-known/oauth-protected-resource")).json();
    assert.deepEqual(metadata, { resource, authorization_servers: [issuer], scopes_supported: ["essay.read", "essay.write", "essay.export"], bearer_methods_supported: ["header"] });
    for (const p of ["/", "/mcp", "/unknown", "/authorize", "/token", "/register"]) {
      const result = await fetch(base + p); assert.equal(result.status, 401);
      assert.ok(!result.headers.get("www-authenticate")!.includes("error="));
      assert.match(result.headers.get("www-authenticate")!, /resource_metadata="https:\/\/essay\.example\/\.well-known\/oauth-protected-resource", scope="essay.read"/);
    }
    for (const token of ["malformed", jwt({ exp: time / 1000 - 31 })]) {
      const invalid = await fetch(base + "/mcp", { headers: { authorization: "Bearer " + token } });
      assert.equal(invalid.status, 401); assert.match(invalid.headers.get("www-authenticate")!, /error="invalid_token"/);
    }
    const noScopes = await fetch(base + "/mcp", { headers: { authorization: "Bearer " + jwt({ scope: undefined }) } });
    assert.equal(noScopes.status, 403); assert.match(noScopes.headers.get("www-authenticate")!, /insufficient_scope/);
    const scpClient = await connect(base, jwt({ scope: undefined, scp: ["essay.read"] })); clients.push(scpClient);
    assert.equal((await scpClient.listTools()).tools.length, 9);
    const owner = await connect(base, jwt()); clients.push(owner);
    assert.equal((await owner.listTools()).tools.length, 27);
    const missingTemplate = await owner.callTool({ name: "load_exam_paper", arguments: { templateId: "nonexistent" } });
    assert.equal(missingTemplate.isError, true);
    assert.match(JSON.stringify(missingTemplate), /找不到模板/);
    assert.ok(!JSON.stringify(missingTemplate).includes("ENOENT"));
    assert.ok(!JSON.stringify(missingTemplate).includes(store.resolveExportPath("private", "txt")));
    const created = await owner.callTool({ name: "create_answer", arguments: { title: "Alice", sections: [{ id: "body", text: "PRIVATE_ALICE" }] } });
    assert.equal(created.isError, undefined);
    const id = (created.structuredContent as { answer: { id: string } }).answer.id;
    const exported = await owner.callTool({ name: "export_text", arguments: { answerId: id, filename: "alice" } });
    assert.equal(exported.isError, undefined);
    const uri = (exported.structuredContent as { exportUri: string }).exportUri;
    assert.ok((await owner.readResource({ uri })).contents.length);
    const readerToken = jwt({ scope: "essay.read" });
    for (const resourceUri of [uri, uri.replace("essay:", "ESSAY:"), uri.replace("exports", "EXPORTS")]) {
      const response = await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + readerToken, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: resourceUri } }) });
      assert.equal(response.status, 403); assert.match(response.headers.get("www-authenticate")!, /scope="essay.export"/);
    }
    for (const resourceUri of [null, 42, {}, "invalid URI"]) {
      const response = await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + readerToken, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: resourceUri } }) });
      assert.equal(response.status, 400);
    }
    const reader = await connect(base, readerToken); clients.push(reader);
    assert.equal((await reader.listTools()).tools.length, 9);
    assert.equal((await reader.callTool({ name: "read_answer", arguments: { answerId: id } })).isError, undefined);
    for (const name of ["create_answer", "write_answer", "export_text"]) {
      const response = await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer " + readerToken, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { answerId: id, sections: [] } } }) });
      assert.equal(response.status, 403); assert.match(response.headers.get("www-authenticate")!, /insufficient_scope/);
    }
    await assert.rejects(reader.callTool({ name: "write_answer", arguments: { answerId: id, sections: [] } }));
    await assert.rejects(reader.readResource({ uri }));
    const writer = await connect(base, jwt({ scope: "essay.read essay.write" })); clients.push(writer);
    assert.equal((await writer.listTools()).tools.length, 23);
    await assert.rejects(writer.callTool({ name: "export_text", arguments: { answerId: id } }));
    const exporter = await connect(base, jwt({ scope: "essay.read essay.export" })); clients.push(exporter);
    assert.equal((await exporter.listTools()).tools.length, 13);
    assert.ok((await exporter.readResource({ uri })).contents.length);
    await assert.rejects(exporter.callTool({ name: "write_answer", arguments: { answerId: id, sections: [] } }));
    const bob = await connect(base, jwt({ sub: "bob" })); clients.push(bob);
    assert.equal((await bob.callTool({ name: "read_answer", arguments: { answerId: id } })).isError, true);
    assert.deepEqual((await bob.callTool({ name: "list_answers", arguments: {} })).structuredContent, { answers: [] });
    await assert.rejects(bob.readResource({ uri }));
    assert.equal(storage.downloads, 2, "other principals are denied before download");
    const prefix = "essayEnvironments/staging/users/" + principalOwnerKey(issuer, "alice") + "/answers/";
    assert.ok([...firestore.documents.keys()].some(p => p.startsWith(prefix)));
    assert.ok(![...firestore.documents.keys()].some(p => p.includes(principalOwnerKey(issuer, "bob"))));
  } finally { await Promise.all(clients.map(c => c.close())); await close(server); await close(jwks.server); }
});

test("default bearer stays owner=26/read=14; both accepts JWT and fixed tokens; OAuth FileStore is single-owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "essay-oauth-file-"));
  const jwks = await jwksFixture();
  try {
    const store = new FileStore({ answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
    await store.ensureDirectories();
    const bearerEnv = { MCP_AUTH_TOKEN: "fixed-owner", MCP_READ_TOKEN: "fixed-reader" };
    assert.deepEqual(oauthConfiguration(bearerEnv), { mode: "bearer" });
    assert.throws(() => createHttpHandler(store, { ...bearerEnv, AUTH_MODE: "invalid" }), /AUTH_MODE/);
    const oauthEnv = { ...bearerEnv, AUTH_MODE: "both", OAUTH_ISSUERS: issuer, OAUTH_RESOURCE_URL: resource, OAUTH_JWKS_URI: jwks.uri,
      OAUTH_FILE_OWNER_KEY: principalOwnerKey(issuer, "alice") };
    assert.throws(() => createHttpHandler(store, { ...oauthEnv, OAUTH_FILE_OWNER_KEY: "" }), /single owner/);
    for (const env of [bearerEnv, oauthEnv]) {
      const server = createServer(createHttpHandler(store, env)); const base = await listen(server);
      const clients: Client[] = [];
      try {
        const owner = await connect(base, "fixed-owner"), reader = await connect(base, "fixed-reader"); clients.push(owner, reader);
        assert.equal((await owner.listTools()).tools.length, 27); assert.equal((await reader.listTools()).tools.length, 9);
        assert.equal((await reader.callTool({ name: "create_answer", arguments: { title: "denied" } })).isError, true);
        const missing = await fetch(base + "/mcp"); assert.equal(missing.status, 401);
        if (env === bearerEnv) { assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="police-essay-mcp"'); await assert.rejects(connect(base, jwt())); }
        else { const alice = await connect(base, jwt()); clients.push(alice); assert.equal((await alice.listTools()).tools.length, 27); await assert.rejects(connect(base, jwt({ sub: "bob" }))); }
      } finally { await Promise.all(clients.map(c => c.close())); await close(server); }
    }
    const oauthOnly = createServer(createHttpHandler(store, { ...oauthEnv, AUTH_MODE: "oauth" }));
    const base = await listen(oauthOnly);
    try { await assert.rejects(connect(base, "fixed-owner")); } finally { await close(oauthOnly); }
  } finally { await close(jwks.server); await rm(root, { recursive: true, force: true }); }
});


test("bearer keeps CORS, fixed/chunked body limits and pre-storage rejection", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "essay-bearer-http-"));
  const store = new FileStore({ answerDir: path.join(root, "answers"), exportDir: path.join(root, "exports") });
  await store.ensureDirectories();
  const server = createServer(createHttpHandler(store, { MCP_AUTH_TOKEN: "owner", MCP_READ_TOKEN: "reader", MCP_MAX_BODY_BYTES: "1024", CORS_ORIGIN: "https://trusted.example" }));
  const base = await listen(server);
  try {
    for (const method of ["GET", "POST", "DELETE"]) assert.equal((await fetch(base + "/mcp", { method })).status, 401);
    const preflight = await fetch(base + "/mcp", { method: "OPTIONS", headers: { origin: "https://trusted.example" } });
    assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), "https://trusted.example");
    assert.equal((await fetch(base + "/mcp", { method: "OPTIONS", headers: { origin: "https://untrusted.example" } })).status, 403);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { padding: "x".repeat(2048) } });
    assert.equal((await fetch(base + "/mcp", { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json", accept: "application/json, text/event-stream" }, body })).status, 413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(base + "/mcp", { method: "POST", headers: { authorization: "Bearer owner", "content-type": "application/json", accept: "application/json, text/event-stream" } }, response => {
        response.resume(); response.on("end", () => resolve(response.statusCode!));
      });
      request.on("error", reject);
      for (let i = 0; i < body.length; i += 127) request.write(body.slice(i, i + 127));
      request.end();
    });
    assert.equal(chunked, 413);
    assert.deepEqual(await store.listAnswers(), []);
  } finally { await close(server); await rm(root, { recursive: true, force: true }); }
});


test("unknown-kid 503 preserves live keys and globally bounds retries, including expired keys", async () => {
  let now = time, requests = 0, failed = false;
  const verify = createOAuthVerifier({ issuers: [issuer], resource, jwksUri: "https://issuer.example/jwks" }, {
    now: () => now, ttlMs: 300_000,
    fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa" }] }), { status: failed ? 503 : 200 });
    },
  });
  await verify(jwt());
  failed = true;
  await assert.rejects(verify(jwt({}, { kid: "forged" })), OAuthError);
  assert.equal(requests, 2);
  await verify(jwt());
  for (let i = 0; i < 29; i++) {
    now += 1000;
    await assert.rejects(verify(jwt({}, { kid: i % 2 ? "forged" : "random-" + i })), OAuthError);
    await verify(jwt());
  }
  assert.equal(requests, 2, "same and random kids cannot amplify a failed IdP");
  now += 1000;
  await assert.rejects(verify(jwt({}, { kid: "forged" })), OAuthError);
  assert.equal(requests, 3);
  await verify(jwt());
  now = time + 300_000;
  await assert.rejects(verify(jwt()), OAuthError);
  await assert.rejects(verify(jwt()), OAuthError);
  assert.equal(requests, 4, "expired keys fail closed, with failure backoff");
});

test("JWKS refresh is single-flight and successful unknown-kid refreshes have a bounded total", async () => {
  let now = time, requests = 0;
  let release!: () => void;
  let gate = Promise.resolve();
  const verify = createOAuthVerifier({ issuers: [issuer], resource, jwksUri: "https://issuer.example/jwks", refreshBackoffMs: 2000 }, {
    now: () => now,
    fetch: async () => {
      requests++; await gate;
      return new Response(JSON.stringify({ keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa" }] }));
    },
  });
  gate = new Promise<void>(resolve => { release = resolve; });
  const cold = Array.from({ length: 20 }, () => verify(jwt()));
  assert.equal(requests, 1); release(); await Promise.all(cold);
  gate = new Promise<void>(resolve => { release = resolve; });
  const unknown = Array.from({ length: 20 }, (_, i) => verify(jwt({}, { kid: "missing-" + i })));
  const settled = Promise.allSettled(unknown);
  assert.equal(requests, 2);
  await verify(jwt()); // live known keys do not wait for an unknown-kid refresh
  release(); assert.ok((await settled).every(r => r.status === "rejected"));
  for (let i = 0; i < 9; i++) {
    now += 1000;
    await assert.rejects(verify(jwt({}, { kid: "missing-" + i })), OAuthError);
  }
  assert.equal(requests, 6, "at most initial fetch + one unknown refresh per configured interval");
});

test("scope string and scp array are supported; valid scopeless JWTs return 403", async () => {
  const verify = createOAuthVerifier({ issuers: [issuer], resource, jwksUri: "https://issuer.example/jwks" }, {
    now: () => time,
    fetch: async () => new Response(JSON.stringify({ keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa" }] })),
  });
  assert.deepEqual((await verify(jwt({ scope: "essay.read essay.export" }))).scopes, ["essay.read", "essay.export"]);
  assert.deepEqual((await verify(jwt({ scope: undefined, scp: ["essay.read", "unrelated", 123] }))).scopes, ["essay.read"]);
  for (const patch of [{ scope: undefined }, { scope: "" }, { scope: 123 }, { scope: undefined, scp: [] }])
    await assert.rejects(verify(jwt(patch)), (e: unknown) => e instanceof OAuthError && e.status === 403);
  await assert.rejects(verify(jwt({ scope: undefined }, {}, rotated.privateKey)), (e: unknown) => e instanceof OAuthError && e.status === 401);
});

test("OAUTH_REQUIRE_AT_JWT is opt-in and configurable backoff defaults to 30 seconds", async () => {
  const env = { AUTH_MODE: "oauth", OAUTH_RESOURCE_URL: resource, OAUTH_ISSUERS: issuer, OAUTH_JWKS_URI: issuer + "/jwks" };
  const defaults = oauthConfiguration(env);
  assert.equal(defaults.refreshBackoffMs, 30_000); assert.equal(defaults.requireAtJwt, false);
  assert.equal(oauthConfiguration({ ...env, OAUTH_JWKS_BACKOFF_SECONDS: "7" }).refreshBackoffMs, 7000);
  for (const value of ["0", "-1", "NaN", "Infinity", "301", "3600"]) assert.throws(() => oauthConfiguration({ ...env, OAUTH_JWKS_BACKOFF_SECONDS: value }), /between 1 and 300/);
  assert.equal(oauthConfiguration({ ...env, OAUTH_JWKS_BACKOFF_SECONDS: "300" }).refreshBackoffMs, 300_000);
  for (const value of ["TRUE", "1", "yes"]) assert.throws(() => oauthConfiguration({ ...env, OAUTH_REQUIRE_AT_JWT: value }), /must be "true" or "false"/);
  assert.equal(oauthConfiguration({ ...env, OAUTH_REQUIRE_AT_JWT: "false" }).requireAtJwt, false);
  const config = oauthConfiguration({ ...env, OAUTH_REQUIRE_AT_JWT: "true" });
  assert.ok(config.mode !== "bearer");
  const fetchKeys: typeof fetch = async () => new Response(JSON.stringify({ keys: [{ ...rsa.publicKey.export({ format: "jwk" }), kid: "rsa" }] }));
  const strict = createOAuthVerifier(config, { now: () => time, fetch: fetchKeys });
  for (const typ of [undefined, "JWT", "id+jwt"]) await assert.rejects(strict(jwt({}, { typ })), OAuthError);
  for (const typ of ["at+jwt", "AT+JWT", "application/at+jwt", "Application/AT+JWT"]) await strict(jwt({}, { typ }));
  for (const typ of [123, null, ["at+jwt"]] as unknown[]) await assert.rejects(strict(jwt({}, { typ } as never)), OAuthError);
  await createOAuthVerifier(defaults, { now: () => time, fetch: fetchKeys })(jwt({}, { typ: "JWT" }));
});


test("FileStore missing templates have a generic error without server paths", async () => {
  const store = new FileStore();
  await assert.rejects(store.getTemplate("nonexistent"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "找不到模板。");
    assert.ok(!error.message.includes(store.templateDir));
    return true;
  });
});
