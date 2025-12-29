import { loadConfig } from "../config/store.js";
import {
  getAuthStatusForAlias,
  type TokenStore,
} from "../security/token-store.js";
import type { AccountConfig, AuthStatus, TokenStoreKind } from "../types.js";
import { warn } from "../utils/log.js";
import { RemoteSession } from "./remote-session.js";
import type { SessionManagerLike } from "./types.js";

const DEFAULT_BACKGROUND_REFRESH_INTERVAL_MS = 60_000;

function resolveBackgroundRefreshIntervalMs() {
  const raw = process.env.MCP_JIRA_BACKGROUND_REFRESH_INTERVAL_MS;
  if (!raw) {
    return DEFAULT_BACKGROUND_REFRESH_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export class SessionManager implements SessionManagerLike {
  private readonly tokenStore: TokenStore;
  private readonly scopes: string[];
  private readonly staticClientInfo: {
    clientId: string;
    clientSecret?: string;
  } | null;
  private readonly tokenStoreKind: TokenStoreKind;
  private readonly sessions = new Map<string, RemoteSession>();
  private accounts = new Map<string, AccountConfig>();
  private backgroundRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundRefreshRunning = false;
  private backgroundRefreshStopped = false;

  constructor(
    tokenStore: TokenStore,
    scopes: string[],
    staticClientInfo: {
      clientId: string;
      clientSecret?: string;
    } | null,
    tokenStoreKind: TokenStoreKind
  ) {
    this.tokenStore = tokenStore;
    this.scopes = scopes;
    this.staticClientInfo = staticClientInfo;
    this.tokenStoreKind = tokenStoreKind;
  }

  async loadAll() {
    const config = await loadConfig();
    this.accounts = new Map(
      Object.values(config.accounts).map((account) => [account.alias, account])
    );
    for (const account of this.accounts.values()) {
      const session = new RemoteSession(
        account,
        this.tokenStore,
        this.scopes,
        this.staticClientInfo
      );
      this.sessions.set(account.alias, session);
    }
  }

  listAccounts() {
    return Array.from(this.accounts.values());
  }

  getSession(alias: string) {
    return this.sessions.get(alias) ?? null;
  }

  getAccountAuthStatus(
    alias: string,
    options?: { allowPrompt?: boolean }
  ): Promise<AuthStatus> {
    return getAuthStatusForAlias({
      alias,
      tokenStore: this.tokenStore,
      storeKind: this.tokenStoreKind,
      allowPrompt: options?.allowPrompt ?? false,
    });
  }

  async connectAll() {
    const sessions = Array.from(this.sessions.values());
    const results = await Promise.allSettled(
      sessions.map(async (session) => {
        const status = await this.getAccountAuthStatus(session.account.alias, {
          allowPrompt: false,
        });
        if (status.status !== "ok") {
          warn(
            `[${session.account.alias}] Auth status ${status.status}. ${status.reason ?? "Run login."}`
          );
          return;
        }
        await session.connect();
      })
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const session = sessions[index];
        warn(
          `[${session.account.alias}] Failed to connect: ${String(result.reason)}`
        );
      }
    });
  }

  private async refreshAllTokensOnce() {
    for (const session of this.sessions.values()) {
      try {
        const status = await this.getAccountAuthStatus(session.account.alias, {
          allowPrompt: false,
        });
        if (status.status !== "ok") {
          continue;
        }
        await session.refreshTokensInBackground();
      } catch (err) {
        warn(
          `[${session.account.alias}] Background token refresh failed: ${String(
            err
          )}`
        );
      }
    }
  }

  startBackgroundRefresh(options?: { intervalMs?: number }) {
    if (this.backgroundRefreshTimer) {
      return;
    }
    const intervalMs =
      options?.intervalMs ?? resolveBackgroundRefreshIntervalMs();
    if (intervalMs <= 0) {
      return;
    }
    this.backgroundRefreshStopped = false;

    const schedule = (delay: number) => {
      const timer = setTimeout(run, delay);
      timer.unref?.();
      this.backgroundRefreshTimer = timer;
    };

    const run = async () => {
      if (this.backgroundRefreshStopped) {
        return;
      }
      if (this.backgroundRefreshRunning) {
        schedule(intervalMs);
        return;
      }
      this.backgroundRefreshRunning = true;
      try {
        await this.refreshAllTokensOnce();
      } finally {
        this.backgroundRefreshRunning = false;
        schedule(intervalMs);
      }
    };

    schedule(intervalMs);
  }

  stopBackgroundRefresh() {
    this.backgroundRefreshStopped = true;
    if (this.backgroundRefreshTimer) {
      clearTimeout(this.backgroundRefreshTimer);
      this.backgroundRefreshTimer = null;
    }
  }

  async closeAll() {
    this.stopBackgroundRefresh();
    await Promise.all(
      Array.from(this.sessions.values()).map((session) => session.close())
    );
  }
}
