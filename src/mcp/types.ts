import type { AccountConfig, AuthStatus } from "../types.js";

export type ToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
  };
};

export type SessionLike = {
  listTools(): Promise<ToolDefinition[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
};

export type SessionManagerLike = {
  listAccounts(): AccountConfig[];
  getSession(alias: string): SessionLike | null;
  getAccountAuthStatus?: (
    alias: string,
    options?: { allowPrompt?: boolean }
  ) => Promise<AuthStatus>;
};
