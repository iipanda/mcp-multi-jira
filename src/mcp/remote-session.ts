import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { EventSourceInit } from "eventsource";
import PQueue from "p-queue";
import {
  isInvalidGrantError,
  MCP_SERVER_URL,
  MCP_SSE_URL,
  refreshTokensIfNeeded,
  type StaticClientInfo,
} from "../oauth/atlassian.js";
import type { TokenStore } from "../security/token-store.js";
import type { AccountConfig, TokenSet } from "../types.js";
import { debug, warn } from "../utils/log.js";
import { PACKAGE_VERSION } from "../version.js";
import type { ToolDefinition } from "./types.js";

type EventSourceInitWithHeaders = EventSourceInit & {
  headers?: Record<string, string>;
};

export class RemoteSession {
  readonly account: AccountConfig;
  private client: Client;
  private connected = false;
  private readonly tokenStore: TokenStore;
  private readonly scopes: string[];
  private readonly staticClientInfo: StaticClientInfo | null;
  private readonly queue: PQueue;
  private tokens: TokenSet | null = null;
  private loadPromise: Promise<void> | null = null;
  private refreshPromise: Promise<TokenSet> | null = null;

  constructor(
    account: AccountConfig,
    tokenStore: TokenStore,
    scopes: string[],
    staticClientInfo: StaticClientInfo | null
  ) {
    this.account = account;
    this.tokenStore = tokenStore;
    this.scopes = scopes;
    this.staticClientInfo = staticClientInfo;
    this.client = this.createClient();
    this.queue = new PQueue({ concurrency: 4 });
  }

  private createClient() {
    return new Client({ name: "mcp-jira", version: PACKAGE_VERSION });
  }

  private async loadTokens() {
    const stored = await this.tokenStore.get(this.account.alias);
    if (!stored) {
      throw new Error(
        `No tokens found for account ${this.account.alias}. Run login first.`
      );
    }
    this.tokens = stored;
  }

  private async ensureTokensLoaded() {
    if (this.tokens) {
      return;
    }
    if (!this.loadPromise) {
      this.loadPromise = this.loadTokens().finally(() => {
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  private async fetchRefreshedTokens() {
    const alias = this.account.alias;
    const refreshed = await refreshTokensIfNeeded({
      alias,
      tokenStore: this.tokenStore,
      scopes: this.scopes,
      staticClientInfo: this.staticClientInfo,
    });
    this.tokens = refreshed;
    return refreshed;
  }

  private async markRefreshTokenInvalid() {
    if (!this.tokens || this.tokens.refreshInvalid) {
      return;
    }
    const marked = { ...this.tokens, refreshInvalid: true };
    await this.tokenStore.set(this.account.alias, marked);
    this.tokens = marked;
  }

  private async retryRefreshAfterReload(previousRefreshToken?: string) {
    const alias = this.account.alias;
    const latest = await this.tokenStore.get(alias);
    if (!latest?.refreshToken) {
      return null;
    }
    if (latest.refreshToken === previousRefreshToken) {
      return null;
    }
    this.tokens = latest;
    try {
      return await this.fetchRefreshedTokens();
    } catch (err) {
      if (!isInvalidGrantError(err)) {
        throw err;
      }
      return null;
    }
  }

  private async refreshTokensInner() {
    const alias = this.account.alias;
    const currentRefreshToken = this.tokens?.refreshToken;

    try {
      return await this.fetchRefreshedTokens();
    } catch (err) {
      if (!isInvalidGrantError(err)) {
        throw err;
      }

      const refreshed = await this.retryRefreshAfterReload(currentRefreshToken);
      if (refreshed) {
        return refreshed;
      }

      await this.markRefreshTokenInvalid();
      throw new Error(
        `Stored refresh token is invalid for account ${alias}. Run \`mcp-multi-jira login ${alias}\` again.`
      );
    }
  }

  private refreshTokens() {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.refreshTokensInner().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private tokenNeedsRefresh() {
    if (!this.tokens) {
      return true;
    }
    const now = Date.now();
    return this.tokens.expiresAt < now + 5 * 60 * 1000;
  }

  private async ensureValidTokens() {
    await this.ensureTokensLoaded();

    if (!this.tokens) {
      throw new Error("Missing tokens");
    }

    const now = Date.now();
    if (this.tokens.refreshInvalid) {
      if (this.tokens.expiresAt > now) {
        return;
      }
      throw new Error(
        `Tokens for ${this.account.alias} have expired and the stored refresh token is invalid. Run login again.`
      );
    }

    if (!this.tokenNeedsRefresh()) {
      return;
    }
    if (!this.tokens.refreshToken) {
      throw new Error(
        `Tokens for ${this.account.alias} have expired and no refresh token is available.`
      );
    }

    if (this.tokens.expiresAt <= now) {
      await this.refreshTokens();
      return;
    }

    try {
      await this.refreshTokens();
    } catch (err) {
      warn(
        `[${this.account.alias}] Token refresh failed, continuing with existing access token: ${String(
          err
        )}`
      );
    }
  }

  private async connectStreamableHttp() {
    if (!this.tokens) {
      throw new Error("Missing tokens");
    }
    const transport = new StreamableHTTPClientTransport(
      new URL(MCP_SERVER_URL),
      {
        requestInit: {
          headers: {
            authorization: `Bearer ${this.tokens.accessToken}`,
          },
        },
      }
    );
    await this.client.connect(transport);
    this.connected = true;
  }

  private async connectSse() {
    if (!this.tokens) {
      throw new Error("Missing tokens");
    }
    const eventSourceInit: EventSourceInitWithHeaders = {
      headers: {
        authorization: `Bearer ${this.tokens.accessToken}`,
      },
    };
    const transport = new SSEClientTransport(new URL(MCP_SSE_URL), {
      requestInit: {
        headers: {
          authorization: `Bearer ${this.tokens.accessToken}`,
        },
      },
      eventSourceInit,
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  async connect() {
    await this.ensureValidTokens();
    if (this.connected) {
      return;
    }
    try {
      await this.connectStreamableHttp();
      debug(`[${this.account.alias}] Connected via Streamable HTTP`);
    } catch (err) {
      warn(
        `[${this.account.alias}] Streamable HTTP failed, falling back to SSE: ${String(
          err
        )}`
      );
      await this.connectSse();
    }
  }

  private async refreshAndReconnect() {
    await this.ensureValidTokens();
    await this.client.close();
    this.client = this.createClient();
    this.connected = false;
    await this.connect();
  }

  private shouldRefreshOnError(err: unknown) {
    if (!err || typeof err !== "object") {
      return false;
    }
    const code = (err as { code?: number }).code;
    if (code === 401 || code === 403) {
      return true;
    }
    const message = String(err);
    return (
      message.toLowerCase().includes("unauthorized") ||
      message.toLowerCase().includes("forbidden")
    );
  }

  async listTools() {
    if (!this.connected) {
      await this.connect();
    }
    const tools: ToolDefinition[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.client.listTools({ cursor });
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    if (!this.connected) {
      await this.connect();
    }
    return this.queue.add(async () => {
      try {
        return await this.client.callTool({
          name,
          arguments: args,
        });
      } catch (err) {
        if (this.shouldRefreshOnError(err)) {
          await this.refreshAndReconnect();
          return this.client.callTool({
            name,
            arguments: args,
          });
        }
        throw err;
      }
    });
  }

  async refreshTokensInBackground() {
    await this.ensureTokensLoaded();
    if (!this.tokens) {
      throw new Error("Missing tokens");
    }
    if (this.tokens.refreshInvalid) {
      return;
    }
    if (!this.tokenNeedsRefresh()) {
      return;
    }
    if (!this.tokens.refreshToken) {
      return;
    }
    try {
      await this.refreshTokens();
    } catch (err) {
      const now = Date.now();
      if (this.tokens.expiresAt > now) {
        warn(
          `[${this.account.alias}] Background token refresh failed, continuing with existing access token: ${String(
            err
          )}`
        );
        return;
      }
      throw err;
    }
  }

  async close() {
    await this.client.close();
  }
}
