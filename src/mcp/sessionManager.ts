import { loadConfig } from "../config/store.js";
import { AccountConfig } from "../types.js";
import { getAuthStatusForAlias, TokenStore } from "../security/tokenStore.js";
import { RemoteSession } from "./remoteSession.js";
import { SessionManagerLike } from "./types.js";
import { warn } from "../utils/log.js";
import { AuthStatus, TokenStoreKind } from "../types.js";

export class SessionManager implements SessionManagerLike {
  private sessions = new Map<string, RemoteSession>();
  private accounts = new Map<string, AccountConfig>();

  constructor(
    private tokenStore: TokenStore,
    private scopes: string[],
    private staticClientInfo: { clientId: string; clientSecret?: string } | null,
    private tokenStoreKind: TokenStoreKind,
  ) {}

  async loadAll() {
    const config = await loadConfig();
    this.accounts = new Map(
      Object.values(config.accounts).map((account) => [account.alias, account]),
    );
    for (const account of this.accounts.values()) {
      const session = new RemoteSession(
        account,
        this.tokenStore,
        this.scopes,
        this.staticClientInfo,
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

  async getAccountAuthStatus(
    alias: string,
    options?: { allowPrompt?: boolean },
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
            `[${session.account.alias}] Auth status ${status.status}. ${status.reason ?? "Run login."}`,
          );
          return;
        }
        await session.connect();
      }),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const session = sessions[index];
        warn(
          `[${session.account.alias}] Failed to connect: ${String(result.reason)}`,
        );
      }
    });
  }

  async closeAll() {
    await Promise.all(
      Array.from(this.sessions.values()).map((session) => session.close()),
    );
  }
}
