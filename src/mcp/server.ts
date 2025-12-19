import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { info, warn } from "../utils/log.js";
import type { SessionManagerLike } from "./types.js";

function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

function sanitizeInputSchema(
  inputSchema:
    | {
        type?: string;
        properties?: Record<string, object>;
        required?: string[];
      }
    | undefined
) {
  if (!inputSchema || typeof inputSchema !== "object") {
    return inputSchema;
  }
  const baseSchema = { ...inputSchema };
  if (baseSchema.properties && typeof baseSchema.properties === "object") {
    const properties = { ...baseSchema.properties };
    properties.cloudId = undefined;
    baseSchema.properties = properties;
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

function buildToolSchema(
  inputSchema:
    | {
        type?: string;
        properties?: Record<string, object>;
        required?: string[];
      }
    | undefined
) {
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

function normalizeToolResult(result: any) {
  if (result && typeof result === "object" && "content" in result) {
    return result;
  }
  if (result && typeof result === "object" && "toolResult" in result) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify((result as { toolResult: unknown }).toolResult),
        },
      ],
      structuredContent: (result as { toolResult: unknown }).toolResult,
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
      const statusMap = new Map<string, { status: string; reason?: string }>();
      if (sessionManager.getAccountAuthStatus) {
        await Promise.all(
          accounts.map(async (account) => {
            try {
              const status = await sessionManager.getAccountAuthStatus?.(
                account.alias,
                { allowPrompt: false }
              );
              statusMap.set(account.alias, status);
            } catch (err) {
              statusMap.set(account.alias, {
                status: "unknown",
                reason: String(err),
              });
            }
          })
        );
      }
      const summary = accounts
        .map((account) => {
          const status = statusMap.get(account.alias);
          const authLabel = status ? `auth: ${status.status}` : "auth: unknown";
          return `${account.alias}: ${account.site} (cloudId: ${account.cloudId}, ${authLabel})`;
        })
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
  const toolMap = new Map<
    string,
    {
      description?: string;
      inputSchema?: {
        type?: string;
        properties?: Record<string, object>;
        required?: string[];
      };
    }
  >();
  const toolErrors: string[] = [];

  for (const account of sessions) {
    const session = sessionManager.getSession(account.alias);
    if (!session) {
      continue;
    }
    try {
      if (sessionManager.getAccountAuthStatus) {
        const status = await sessionManager.getAccountAuthStatus(
          account.alias,
          { allowPrompt: false }
        );
        if (status.status !== "ok") {
          warn(
            `[${account.alias}] Skipping tool discovery (auth ${status.status}).`
          );
          continue;
        }
      }
      const tools = await session.listTools();
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

  if (toolMap.size === 0 && sessions.length > 0) {
    warn(`No remote tools could be loaded. ${toolErrors.join(" ")}`.trim());
  }

  for (const [toolName, tool] of toolMap) {
    const required = tool.inputSchema?.required ?? [];
    const requiredHintList = required.filter((item) => item !== "cloudId");
    const requiredHint =
      requiredHintList.length > 0
        ? `Required parameters: ${requiredHintList.join(", ")}.`
        : "";
    const description =
      (tool.description ? `${tool.description}\n\n` : "") +
      "Required parameter: account (account alias).\n" +
      requiredHint;
    server.registerTool(
      toolName,
      {
        description,
        inputSchema: buildToolSchema(tool.inputSchema),
      },
      async (args: Record<string, unknown>) => {
        const { account, ...rest } = args as Record<string, unknown> & {
          account?: string;
        };
        if (!account) {
          return toolError("Missing required parameter: account");
        }
        const session = sessionManager.getSession(account);
        if (!session) {
          return toolError(`Unknown account alias: ${account}`);
        }
        const requiredParams = tool.inputSchema?.required ?? [];
        if (requiredParams.includes("cloudId") && rest.cloudId === undefined) {
          const accountInfo = sessionManager
            .listAccounts()
            .find((item) => item.alias === account);
          if (accountInfo?.cloudId && accountInfo.cloudId !== "unknown") {
            rest.cloudId = accountInfo.cloudId;
          }
        }
        try {
          const result = await session.callTool(toolName, rest);
          return normalizeToolResult(result);
        } catch (err) {
          return toolError(
            `Failed to call ${toolName} for ${account}: ${String(err)}`
          );
        }
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  info("MCP server is running (stdio).");
}
