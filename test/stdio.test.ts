import { expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveServerScript() {
  return path.resolve(__dirname, "fixtures", "stdio-server.ts");
}

test("stdio MCP server accepts connection and routes tool calls", async () => {
  const serverScript = resolveServerScript();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverScript],
    env: {
      ...process.env,
      MCP_JIRA_LOG_STDERR: "true",
    },
  });

  const client = new Client({ name: "mcp-jira-test", version: "0.0.0" });

  try {
    await client.connect(transport);

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("mockEcho");
    expect(toolNames).toContain("mockSecondTool");

    const mockEcho = tools.tools.find((tool) => tool.name === "mockEcho");
    expect(mockEcho).toBeDefined();
    expect(Array.isArray(mockEcho?.inputSchema.required)).toBe(true);
    expect(mockEcho?.inputSchema.required).toContain("account");
    expect(mockEcho?.inputSchema.required).toContain("jql");
    expect(mockEcho?.inputSchema.required).not.toContain("cloudId");

    const result = await client.callTool({
      name: "mockEcho",
      arguments: { account: "mock", jql: "project = TEST", hello: "world" },
    });

    const text = result.content.find((item) => item.type === "text");
    expect(text).toBeDefined();
    if (text && text.type === "text") {
      const payload = JSON.parse(text.text);
      expect(payload.hello).toBe("world");
    }
  } finally {
    await client.close().catch(() => {});
  }
});
