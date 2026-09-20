import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createEssayMcpServer, DEFAULT_TEMPLATE_ID } from "./server.js";
import { FileStore } from "./storage.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const maxBodyBytes = Number.parseInt(process.env.MCP_MAX_BODY_BYTES ?? "2000000", 10);
const requestTimeoutMs = Number.parseInt(process.env.MCP_REQUEST_TIMEOUT_MS ?? "30000", 10);
const authToken = process.env.MCP_AUTH_TOKEN?.trim();
const corsOrigin = process.env.CORS_ORIGIN ?? "*";
const store = new FileStore({
  templateDir: process.env.ESSAY_MCP_TEMPLATE_DIR,
  answerDir: process.env.ESSAY_MCP_ANSWER_DIR,
  exportDir: process.env.ESSAY_MCP_EXPORT_DIR,
});

function isLoopbackHost(value: string): boolean {
  return value === "127.0.0.1" || value === "localhost" || value === "::1";
}

function validateRuntimeConfig(): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT 必須是 1 到 65535 的整數。");
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024) throw new Error("MCP_MAX_BODY_BYTES 必須至少為 1024。");
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) throw new Error("MCP_REQUEST_TIMEOUT_MS 必須至少為 1000。");
  if (!isLoopbackHost(host) && !authToken && process.env.MCP_ALLOW_ANONYMOUS_REMOTE !== "true") {
    throw new Error("非本機 HOST 必須設定 MCP_AUTH_TOKEN，或明確設定 MCP_ALLOW_ANONYMOUS_REMOTE=true。");
  }
}

function tokenMatches(request: IncomingMessage): boolean {
  if (!authToken) return true;
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/iu, "") ?? "";
  const expectedBytes = Buffer.from(authToken, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
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
    await store.getTemplate(DEFAULT_TEMPLATE_ID);
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, ready: true }));
  } catch {
    response.writeHead(503, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, ready: false }));
  }
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", corsOrigin);
  response.setHeader("access-control-allow-headers", "content-type, mcp-session-id, last-event-id");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  response.setHeader("access-control-expose-headers", "mcp-session-id");
}

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCorsHeaders(response);
  if (!tokenMatches(request)) {
    reject(response, 401, "Unauthorized");
    return;
  }
  const contentLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (contentLength > maxBodyBytes) {
    reject(response, 413, "Request body too large");
    return;
  }
  request.setTimeout(requestTimeoutMs, () => request.destroy(new Error("MCP request timed out")));
  const server = createEssayMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    const requestId = randomUUID();
    console.error(`[${requestId}] MCP request failed`, error);
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: "MCP request failed", requestId }));
    }
  }
}

async function startHttp(): Promise<void> {
  validateRuntimeConfig();
  await store.ensureDirectories();
  const httpServer = createHttpServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      response.end();
      return;
    }
    if (requestUrl.pathname === "/health" && request.method === "GET") {
      setCorsHeaders(response);
      await readHealth(request, response);
      return;
    }
    if (requestUrl.pathname === "/readyz" && request.method === "GET") {
      setCorsHeaders(response);
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

if (process.env.MCP_TRANSPORT === "stdio") {
  await startStdio();
} else {
  await startHttp();
}

