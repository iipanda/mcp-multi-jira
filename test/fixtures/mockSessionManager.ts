import { AccountConfig } from "../../src/types.ts";
import { SessionManagerLike, ToolDefinition } from "../../src/mcp/types.ts";

const account: AccountConfig = {
  alias: "mock",
  site: "mock://jira",
  cloudId: "mock",
};

const tools: ToolDefinition[] = [
  {
    name: "mockEcho",
    description: "Echoes arguments back as JSON.",
    inputSchema: {
      type: "object",
      properties: {
        cloudId: { type: "string" },
        jql: { type: "string" },
      },
      required: ["cloudId", "jql"],
    },
  },
  {
    name: "mockSecondTool",
    description: "Second tool for pass-through tests.",
    inputSchema: {
      type: "object",
      properties: {
        cloudId: { type: "string" },
        query: { type: "string" },
      },
      required: ["cloudId", "query"],
    },
  },
];

const session = {
  async listTools() {
    return tools;
  },
  async callTool(_name: string, args: Record<string, unknown>) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(args),
        },
      ],
      structuredContent: args,
    };
  },
};

export function createMockSessionManager(): SessionManagerLike {
  return {
    listAccounts() {
      return [account];
    },
    getSession(alias: string) {
      if (alias === account.alias) {
        return session;
      }
      return null;
    },
    async getAccountAuthStatus() {
      return { status: "ok" };
    },
  };
}
