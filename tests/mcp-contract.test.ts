import { test } from "node:test";
import { checkMcpContract } from "../scripts/check-mcp-contract.js";

test("MCP contract matches the pre-Round-A main snapshot (18cb176)", checkMcpContract);
