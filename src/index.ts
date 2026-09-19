import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createEssayMcpServer } from "./server.js";
import { FileStore } from "./storage.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const host = process.env.HOST ?? "127.0.0.1";
const store = new FileStore({
  templateDir: process.env.ESSAY_MCP_TEMPLATE_DIR,
  answerDir: process.env.ESSAY_MCP_ANSWER_DIR,
  exportDir: process.env.ESSAY_MCP_EXPORT_DIR,
});

async function readHealth(_request: IncomingMessage, response: ServerResponse): Promise<void> {
  response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: true, service: "police-essay-answer-sheet", version: "0.1.0" }));
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("access-control-allow-origin", process.env.CORS_ORIGIN ?? "*");
  response.setHeader("access-control-allow-headers", "content-type, mcp-session-id, last-event-id");
  response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
}

async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  setCorsHeaders(response);
  const server = createEssayMcpServer(store);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void server.close().catch(() => undefined);
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(request, response);
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    if (!response.writableEnded) {
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : "MCP request failed" }));
    }
  }
}

async function startHttp(): Promise<void> {
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
      await readHealth(request, response);
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
