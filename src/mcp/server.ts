import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { info, warn } from "../utils/log.js";
import type { SessionManagerLike } from "./types.js";

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

type ToolInputSchema = {
  type?: string;
  properties?: Record<string, object>;
  required?: string[];
};

type ToolConfig = {
  description?: string;
  inputSchema?: ToolInputSchema;
};

type AccountAuthStatus = { status: string; reason?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

function sanitizeInputSchema(inputSchema: ToolInputSchema | undefined) {
  if (!inputSchema || typeof inputSchema !== "object") {
    return inputSchema;
  }
  const baseSchema = { ...inputSchema };
  if (baseSchema.properties && typeof baseSchema.properties === "object") {
    const { cloudId: _cloudId, ...rest } = baseSchema.properties;
    baseSchema.properties = rest;
  }
  if (Array.isArray(baseSchema.required)) {
    baseSchema.required = baseSchema.required.filter(
      (item) => item !== "cloudId"
    );
  }
  return baseSchema;
}

function getObjectShape(schema: unknown) {
  if (!schema || typeof schema !== "object") {
    return null;
  }
  const maybeShape = (schema as { shape?: unknown }).shape;
  if (maybeShape && typeof maybeShape === "object") {
    return maybeShape as Record<string, z.ZodTypeAny>;
  }
  const maybeDefShape = (schema as { _def?: { shape?: unknown } })._def?.shape;
  if (maybeDefShape && typeof maybeDefShape === "object") {
    return maybeDefShape as Record<string, z.ZodTypeAny>;
  }
  if (typeof maybeDefShape === "function") {
    try {
      const evaluated = maybeDefShape();
      if (evaluated && typeof evaluated === "object") {
        return evaluated as Record<string, z.ZodTypeAny>;
      }
    } catch {
      return null;
    }
  }
  return null;
}

function buildToolSchema(inputSchema: ToolInputSchema | undefined) {
  const accountField = z
    .string()
    .describe("Account alias to route this call to.");
  const accountOnly = z.object({ account: accountField }).loose();
  const fromJSONSchema = (
    z as typeof z & {
      fromJSONSchema?: (schema: unknown) => z.ZodTypeAny;
    }
  ).fromJSONSchema;
  if (!fromJSONSchema) {
    return accountOnly;
  }
  try {
    const remoteSchema = fromJSONSchema(
      sanitizeInputSchema(inputSchema) ?? { type: "object", properties: {} }
    );
    const shape = getObjectShape(remoteSchema);
    if (!shape) {
      return accountOnly;
    }
    const mergedShape = {
      ...shape,
      account: accountField,
    };
    return z.object(mergedShape).loose();
  } catch {
    return accountOnly;
  }
}

function normalizeToolResult(result: unknown): CallToolResult {
  if (isToolResult(result)) {
    return result;
  }
  if (isRecord(result) && "toolResult" in result) {
    const structuredContent = isRecord(result.toolResult)
      ? result.toolResult
      : undefined;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result.toolResult),
        },
      ],
      ...(structuredContent ? { structuredContent } : {}),
    };
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result),
      },
    ],
  };
}

async function buildAccountStatusMap(
  sessionManager: SessionManagerLike,
  accounts: Array<{ alias: string }>
) {
  const statusMap = new Map<string, AccountAuthStatus>();
  const getAccountAuthStatus = sessionManager.getAccountAuthStatus;
  if (!getAccountAuthStatus) {
    return statusMap;
  }
  await Promise.all(
    accounts.map(async (account) => {
      try {
        const status = await getAccountAuthStatus(account.alias, {
          allowPrompt: false,
        });
        statusMap.set(account.alias, status);
      } catch (err) {
        statusMap.set(account.alias, {
          status: "unknown",
          reason: String(err),
        });
      }
    })
  );
  return statusMap;
}

function buildAccountSummaryLine(
  account: { alias: string; site: string; cloudId: string },
  status: AccountAuthStatus | undefined
) {
  const authLabel = status ? `auth: ${status.status}` : "auth: unknown";
  return `${account.alias}: ${account.site} (cloudId: ${account.cloudId}, ${authLabel})`;
}

async function collectToolsForAccount(
  sessionManager: SessionManagerLike,
  account: { alias: string }
) {
  const session = sessionManager.getSession(account.alias);
  if (!session) {
    return null;
  }
  if (sessionManager.getAccountAuthStatus) {
    const status = await sessionManager.getAccountAuthStatus(account.alias, {
      allowPrompt: false,
    });
    if (status.status !== "ok") {
      warn(
        `[${account.alias}] Skipping tool discovery (auth ${status.status}).`
      );
      return null;
    }
  }
  return session.listTools();
}

async function loadRemoteTools(
  sessionManager: SessionManagerLike,
  accounts: Array<{ alias: string }>
) {
  const toolMap = new Map<string, ToolConfig>();
  const toolErrors: string[] = [];
  for (const account of accounts) {
    try {
      const tools = await collectToolsForAccount(sessionManager, account);
      if (!tools) {
        continue;
      }
      for (const tool of tools) {
        if (!toolMap.has(tool.name)) {
          toolMap.set(tool.name, {
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
      }
    } catch (err) {
      const message = `[${account.alias}] Failed to fetch tools during startup: ${String(
        err
      )}`;
      toolErrors.push(message);
      warn(message);
    }
  }
  return { toolMap, toolErrors };
}

function buildToolDescription(tool: ToolConfig) {
  const required = tool.inputSchema?.required ?? [];
  const requiredHintList = required.filter((item) => item !== "cloudId");
  const requiredHint =
    requiredHintList.length > 0
      ? `Required parameters: ${requiredHintList.join(", ")}.`
      : "";
  return (
    (tool.description ? `${tool.description}\n\n` : "") +
    "Required parameter: account (account alias).\n" +
    requiredHint
  );
}

function splitAccountArgs(args: Record<string, unknown>) {
  const { account, ...rest } = args as Record<string, unknown> & {
    account?: string;
  };
  return { account, rest };
}

function applyCloudIdFallback(
  sessionManager: SessionManagerLike,
  account: string,
  tool: ToolConfig,
  args: Record<string, unknown>
) {
  const requiredParams = tool.inputSchema?.required ?? [];
  if (!requiredParams.includes("cloudId") || args.cloudId !== undefined) {
    return;
  }
  const accountInfo = sessionManager
    .listAccounts()
    .find((item) => item.alias === account);
  if (accountInfo?.cloudId && accountInfo.cloudId !== "unknown") {
    args.cloudId = accountInfo.cloudId;
  }
}

function createToolHandler(
  sessionManager: SessionManagerLike,
  toolName: string,
  tool: ToolConfig
) {
  return async (args: Record<string, unknown>) => {
    const { account, rest } = splitAccountArgs(args);
    if (!account) {
      return toolError("Missing required parameter: account");
    }
    const session = sessionManager.getSession(account);
    if (!session) {
      return toolError(`Unknown account alias: ${account}`);
    }
    applyCloudIdFallback(sessionManager, account, tool, rest);
    try {
      const result = await session.callTool(toolName, rest);
      return normalizeToolResult(result);
    } catch (err) {
      return toolError(
        `Failed to call ${toolName} for ${account}: ${String(err)}`
      );
    }
  };
}

export async function startLocalServer(
  sessionManager: SessionManagerLike,
  version: string
) {
  const server = new McpServer(
    { name: "mcp-jira", version },
    {
      instructions:
        "All Jira tools require an 'account' parameter indicating the account alias. " +
        "Use listJiraAccounts to discover available aliases and cloud IDs. " +
        "If a tool requires 'cloudId' and it is missing, the server will fill it from the selected account when possible. " +
        "For JQL search use the 'jql' parameter.",
    }
  );

  server.registerTool(
    "listJiraAccounts",
    {
      description: "List configured Jira account aliases and site metadata.",
    },
    async () => {
      const accounts = sessionManager.listAccounts();
      const statusMap = await buildAccountStatusMap(sessionManager, accounts);
      const summary = accounts
        .map((account) =>
          buildAccountSummaryLine(account, statusMap.get(account.alias))
        )
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: summary || "No accounts are configured.",
          },
        ],
        structuredContent: {
          accounts: accounts.map((account) => ({
            ...account,
            auth: statusMap.get(account.alias) ?? { status: "unknown" },
          })),
        },
      };
    }
  );

  const sessions = sessionManager.listAccounts();
  const { toolMap, toolErrors } = await loadRemoteTools(
    sessionManager,
    sessions
  );

  if (toolMap.size === 0 && sessions.length > 0) {
    warn(`No remote tools could be loaded. ${toolErrors.join(" ")}`.trim());
  }

  for (const [toolName, tool] of toolMap) {
    server.registerTool(
      toolName,
      {
        description: buildToolDescription(tool),
        inputSchema: buildToolSchema(tool.inputSchema),
      },
      createToolHandler(sessionManager, toolName, tool)
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  info("MCP server is running (stdio).");
}
