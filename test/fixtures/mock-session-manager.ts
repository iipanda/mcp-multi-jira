import type {
  SessionManagerLike,
  ToolDefinition,
} from "../../src/mcp/types.ts";
import type { AccountConfig } from "../../src/types.ts";

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
  listTools() {
    return Promise.resolve(tools);
  },
  callTool(_name: string, args: Record<string, unknown>) {
    return Promise.resolve({
      content: [
        {
          type: "text",
          text: JSON.stringify(args),
        },
      ],
      structuredContent: args,
    });
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
    getAccountAuthStatus() {
      return Promise.resolve({ status: "ok" });
    },
  };
}
