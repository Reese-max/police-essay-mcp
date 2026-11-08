import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createEssayMcpServer } from "../src/server.js";
import { FileStore } from "../src/storage.js";

const server = createEssayMcpServer(new FileStore());
const client = new Client({ name: "guidance-surface", version: "1" });
const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);
try {
  const tools = [];
  let toolCursor: string | undefined;
  do {
    const page = await client.listTools({ cursor: toolCursor });
    tools.push(...page.tools.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema })));
    toolCursor = page.nextCursor;
  } while (toolCursor);
  const resources = [];
  let resourceCursor: string | undefined;
  do {
    const page = await client.listResources({ cursor: resourceCursor });
    resources.push(...page.resources);
    resourceCursor = page.nextCursor;
  } while (resourceCursor);
  const resourceContents = [];
  for (const resource of resources) {
    resourceContents.push({ uri: resource.uri, contents: (await client.readResource({ uri: resource.uri })).contents });
  }
  process.stdout.write(JSON.stringify({ instructions: client.getInstructions(), tools, resources, resourceContents }, null, 2) + "\n");
} finally {
  await client.close();
  await server.close();
}

