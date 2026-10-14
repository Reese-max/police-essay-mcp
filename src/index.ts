import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createEssayMcpServer } from "./server.js";
import { createRuntimeStore } from "./cloud-storage.js";
import { initializeRuntimeFont, validateRuntimeFont } from "./runtime-font.js";
import { createReadinessCheck } from "./readiness.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const maxBodyBytes = Number.parseInt(process.env.MCP_MAX_BODY_BYTES ?? "2000000", 10);
const requestTimeoutMs = Number.parseInt(process.env.MCP_REQUEST_TIMEOUT_MS ?? "30000", 10);
const authToken = process.env.MCP_AUTH_TOKEN?.trim();
const readToken = process.env.MCP_READ_TOKEN?.trim();
const allowAnonymousLoopback = process.env.MCP_ALLOW_ANONYMOUS_LOOPBACK === "true";
const corsOrigin = process.env.CORS_ORIGIN?.trim();
const store = createRuntimeStore();
const checkReadiness = createReadinessCheck(store);

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function validateRuntimeConfig(): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT 必須是 1 到 65535 的整數。");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024) throw new Error("MCP_MAX_BODY_BYTES 必須至少為 1024。");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) throw new Error("MCP_REQUEST_TIMEOUT_MS 必須至少為 1000。");
  if (process.env.MCP_ALLOW_ANONYMOUS_REMOTE === "true") {
    throw new Error("MCP_ALLOW_ANONYMOUS_REMOTE 已停用；遠端 HTTP 必須設定 MCP_AUTH_TOKEN。");
  }
  if (allowAnonymousLoopback && (!isLoopbackHost(host) || authToken || readToken)) {
    throw new Error("MCP_ALLOW_ANONYMOUS_LOOPBACK 只能在沒有 token 的純 loopback 模式使用。");
  }
  if (!authToken && !allowAnonymousLoopback) {
    throw new Error("HTTP MCP 必須設定 MCP_AUTH_TOKEN；純本機匿名模式須明確設定 MCP_ALLOW_ANONYMOUS_LOOPBACK=true。");
  }
  if (readToken && (!authToken || readToken === authToken)) {
    throw new Error("MCP_READ_TOKEN 必須與 MCP_AUTH_TOKEN 不同，且須同時設定 owner token。");
  }
  if (corsOrigin) {
    let url: URL;
    try {
      url = new URL(corsOrigin);
    } catch {
      throw new Error("CORS_ORIGIN 必須是單一明確的 HTTPS origin，或本機 HTTP origin。");
    }
    const hostname = url.hostname === "[::1]" ? "::1" : url.hostname;
    if (url.origin !== corsOrigin || (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(hostname)))) {
      throw new Error("CORS_ORIGIN 必須是單一明確的 HTTPS origin，或本機 HTTP origin。");
    }
  }
}

function tokenMatches(supplied: string, expected: string | undefined): boolean {
  if (!expected) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function requestScope(request: IncomingMessage): "owner" | "read" | undefined {
  if (allowAnonymousLoopback) return "owner";
  const supplied = /^Bearer ([^\s]+)$/iu.exec(request.headers.authorization ?? "")?.[1];
  if (!supplied) return undefined;
  if (tokenMatches(supplied, authToken)) return "owner";
  if (tokenMatches(supplied, readToken)) return "read";
  return undefined;
}

function reject(response: ServerResponse, status: number, error: string): void {
  if (!response.headersSent) response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  if (!response.writableEnded) response.end(JSON.stringify({ error }));
}

async function readHealth(_request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: true, service: "police-essay-answer-sheet", version: "0.1.0" }));
}

async function readReadiness(_request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    await checkReadiness();
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, ready: true }));
  } catch {
    console.error(`[${randomUUID()}] readiness_dependency_failed`);
    response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, ready: false }));
  }
}

function setCorsHeaders(request: IncomingMessage, response: ServerResponse): void {
  response.setHeader("vary", "Origin");
  if (!corsOrigin || request.headers.origin !== corsOrigin) return;
  response.setHeader("access-control-allow-origin", corsOrigin);
  response.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id, last-event-id");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("access-control-expose-headers", "mcp-session-id");
}

function originDenied(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  if (corsOrigin) return origin !== corsOrigin;
  // With no CORS grant, browsers cannot read cross-origin responses. The
  // explicit anonymous loopback mode still rejects browser-origin requests.
  return allowAnonymousLoopback;
}

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCorsHeaders(request, response);
  const scope = requestScope(request);
  if (!scope) {
    // RFC 9110 §15.5.1 / RFC 6750 §3: a 401 response must carry a Bearer
    // challenge so remote connectors can discover the credential scheme.
    response.setHeader("www-authenticate", 'Bearer realm="police-essay-mcp"');
    reject(response, 401, "Unauthorized");
    return;
  }
  if (originDenied(request)) {
    reject(response, 403, "Origin not allowed");
    return;
  }
  const contentLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (contentLength > maxBodyBytes) {
    reject(response, 413, "Request body too large");
    return;
  }
  request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("MCP request timed out")));
  const server = createEssayMcpServer(store, { readOnly: scope === "read" });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    // Pause before handing the request to the transport so the size guard can
    // observe every chunk without putting IncomingMessage into flowing mode
    // before the SDK has attached its own body reader.
    request.pause();
    const handlePromise = transport.handleRequest(request, response);
    let bodyBytes = 0;
    let bodyTooLarge = false;
    const onData = (chunk: Buffer): void => {
      bodyBytes += chunk.length;
      if (bodyBytes > maxBodyBytes && !bodyTooLarge) {
        bodyTooLarge = true;
        reject(response, 413, "Request body too large");
      }
    };
    request.on("data", onData);
    request.resume();
    try {
      await handlePromise;
    } finally {
      request.off("data", onData);
    }
  } catch (error) {
    const requestId = randomUUID();
    console.error(`[${requestId}] MCP request failed`);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: "MCP request failed", requestId }));
    }
  }
}

async function startHttp(): Promise<void> {
  try { validateRuntimeConfig(); }
  catch (error) {
    // These configuration messages are authored here and contain no supplied values.
    console.error((error as Error).message);
    throw error;
  }
  try {
    await initializeRuntimeFont();
    if (process.env.ESSAY_MCP_PAPER_FONT) {
      await validateRuntimeFont(await store.getTemplate("police_information_essay_166"));
    }
  } catch { throw new Error("Runtime font initialization failed."); }
  await store.ensureDirectories();
  const httpServer = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") {
      setCorsHeaders(request, response);
      if (originDenied(request)) {
        reject(response, 403, "Origin not allowed");
        return;
      }
      response.writeHead(204);
      response.end();
      return;
    }
    if (requestUrl.pathname === "/health" && request.method === "GET") {
      setCorsHeaders(request, response);
      await readHealth(request, response);
      return;
    }
    if (requestUrl.pathname === "/readyz" && request.method === "GET") {
      setCorsHeaders(request, response);
      await readReadiness(request, response);
      return;
    }
    if (requestUrl.pathname === "/" && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("police-essay-answer-sheet MCP server\nMCP endpoint: /mcp\n");
      return;
    }
    if (requestUrl.pathname === "/mcp") {
      await handleMcp(request, response);
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = requestTimeoutMs;

  httpServer.listen(port, host, () => {
    console.error(`police-essay-answer-sheet listening on http://${host}:${port}/mcp`);
  });
}

async function startStdio(): Promise<void> {
  await store.ensureDirectories();
  const server = createEssayMcpServer(store);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

try {
  if (process.env.MCP_TRANSPORT === "stdio") await startStdio();
  else await startHttp();
} catch {
  console.error("startup_failed");
  process.exitCode = 1;
}
