#!/usr/bin/env node
import { existsSync } from "node:fs";
import { confirm, select } from "@inquirer/prompts";
import { Command } from "commander";
import { runInstaller } from "./agents/install.js";
import { plainTokenFilePath, tokenFilePath } from "./config/paths.js";
import {
  loadConfig,
  removeAccount,
  setAccount,
  setTokenStore,
} from "./config/store.js";
import { RemoteSession } from "./mcp/remoteSession.js";
import { startLocalServer } from "./mcp/server.js";
import { SessionManager } from "./mcp/sessionManager.js";
import {
  DEFAULT_SCOPES,
  getStaticClientInfoFromEnv,
  loginWithDynamicOAuth,
} from "./oauth/atlassian.js";
import {
  createTokenStore,
  getAuthStatusForAlias,
} from "./security/tokenStore.js";
import type { AccountConfig, TokenStoreKind } from "./types.js";
import { info, setLogTarget, warn } from "./utils/log.js";

const PACKAGE_VERSION = "0.1.0";

function parseScopes(scopes?: string) {
  if (!scopes) {
    return DEFAULT_SCOPES;
  }
  return scopes
    .split(/[ ,]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function resolveScopes(scopes?: string) {
  return parseScopes(scopes || process.env.MCP_JIRA_SCOPES);
}

function normalizeTokenStore(value?: string): TokenStoreKind | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (
    normalized === "encrypted" ||
    normalized === "plain" ||
    normalized === "keychain"
  ) {
    return normalized as TokenStoreKind;
  }
  return null;
}

function resolveTokenStoreFromConfig(config: { tokenStore?: TokenStoreKind }) {
  const envStore = normalizeTokenStore(process.env.MCP_JIRA_TOKEN_STORE);
  if (envStore) {
    return envStore;
  }
  const envUseKeychain =
    process.env.MCP_JIRA_USE_KEYCHAIN === "1" ||
    process.env.MCP_JIRA_USE_KEYCHAIN === "true";
  if (envUseKeychain) {
    return "keychain";
  }
  if (config.tokenStore) {
    return config.tokenStore;
  }
  const plainExists = existsSync(plainTokenFilePath());
  const encryptedExists = existsSync(tokenFilePath());
  if (plainExists && !encryptedExists) {
    return "plain";
  }
  if (encryptedExists && !plainExists) {
    return "encrypted";
  }
  if (plainExists && encryptedExists) {
    return "plain";
  }
  return "plain";
}

function describeTokenStore(store: TokenStoreKind) {
  if (store === "encrypted") {
    return "encrypted file";
  }
  if (store === "plain") {
    return "plaintext file";
  }
  return "keychain";
}

async function migrateTokenStore(options: {
  from: TokenStoreKind;
  to: TokenStoreKind;
  aliases: string[];
}) {
  const fromStore = await createTokenStore({ store: options.from });
  const toStore = await createTokenStore({ store: options.to });
  let migrated = 0;
  let alreadyPresent = 0;
  let missing = 0;
  for (const alias of options.aliases) {
    const tokens = await fromStore.get(alias);
    if (!tokens) {
      const existing = await toStore.get(alias);
      if (existing) {
        alreadyPresent += 1;
      } else {
        missing += 1;
      }
      continue;
    }
    await toStore.set(alias, tokens);
    await fromStore.remove(alias);
    migrated += 1;
  }
  return { migrated, alreadyPresent, missing };
}

function formatAccounts(
  accounts: AccountConfig[],
  statusMap: Map<string, string>
) {
  if (accounts.length === 0) {
    return "No accounts configured.";
  }
  const headers = ["Alias", "Site", "User", "Auth"];
  const rows = accounts.map((account) => [
    account.alias,
    account.site,
    account.user ?? "",
    statusMap.get(account.alias) ?? "unknown",
  ]);
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length))
  );
  const formatRow = (row: string[]) =>
    row
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [
    formatRow(headers),
    formatRow(widths.map((w) => "-".repeat(w))),
    ...rows.map(formatRow),
  ].join("\n");
}

function extractStructuredResult(result: any) {
  if (!result || typeof result !== "object") {
    return null;
  }
  if ("structuredContent" in result && result.structuredContent) {
    return result.structuredContent;
  }
  if ("toolResult" in result) {
    return result.toolResult;
  }
  if ("content" in result && Array.isArray(result.content)) {
    for (const item of result.content) {
      if (item?.type === "text" && typeof item.text === "string") {
        const text = item.text.trim();
        if (text.startsWith("{") || text.startsWith("[")) {
          try {
            return JSON.parse(text);
          } catch {}
        }
      }
    }
  }
  return null;
}

function pickResourceArray(payload: any): any[] | null {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  for (const key of ["resources", "values", "items", "sites", "data"]) {
    if (Array.isArray(payload[key])) {
      return payload[key];
    }
  }
  return null;
}

function normalizeResource(raw: any) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const cloudId =
    raw.id || raw.cloudId || raw.cloud_id || raw.resourceId || raw.resource_id;
  const url = raw.url || raw.baseUrl || raw.base_url || raw.siteUrl;
  const name = raw.name || raw.label || raw.displayName;
  if (!(cloudId && url)) {
    return null;
  }
  return {
    id: String(cloudId),
    url: String(url),
    name: name ? String(name) : String(url),
  };
}

async function handleLogin(
  alias: string,
  options: {
    clientId?: string;
    clientSecret?: string;
    scopes?: string;
    default?: boolean;
  }
) {
  const config = await loadConfig();
  if (config.accounts[alias]) {
    const overwrite = await confirm({
      message: `Account alias "${alias}" already exists. Re-authenticate and overwrite?`,
      default: false,
    });
    if (!overwrite) {
      info("Login cancelled.");
      return;
    }
  }

  const scopes = resolveScopes(options.scopes);
  const tokenStoreKind = resolveTokenStoreFromConfig(config);
  const tokenStore = await createTokenStore({
    store: tokenStoreKind,
  });
  const staticClientInfo = getStaticClientInfoFromEnv(options);
  await loginWithDynamicOAuth({
    alias,
    tokenStore,
    scopes,
    staticClientInfo,
  });
  const tokens = await tokenStore.get(alias);
  if (!tokens) {
    throw new Error("Login failed: no tokens stored.");
  }

  const tempAccount: AccountConfig = {
    alias,
    site: "",
    cloudId: "",
  };
  const session = new RemoteSession(
    tempAccount,
    tokenStore,
    scopes,
    staticClientInfo
  );
  let resource: { id: string; url: string; name: string } | null = null;
  let user: string | undefined;
  try {
    const tools = await session.listTools();
    const hasResources = tools.some(
      (tool) => tool.name === "getAccessibleAtlassianResources"
    );
    if (hasResources) {
      const result = await session.callTool(
        "getAccessibleAtlassianResources",
        {}
      );
      const payload = extractStructuredResult(result);
      const resources = pickResourceArray(payload) ?? [];
      const normalized = resources
        .map(normalizeResource)
        .filter((item): item is { id: string; url: string; name: string } =>
          Boolean(item)
        );
      const unique = new Map<
        string,
        { id: string; url: string; name: string }
      >();
      for (const item of normalized) {
        const key = `${item.id}|${item.url}`;
        if (!unique.has(key)) {
          unique.set(key, item);
        }
      }
      const deduped = Array.from(unique.values());
      if (deduped.length === 0) {
        warn("No accessible Jira resources found via MCP.");
      } else {
        resource = deduped[0];
        if (deduped.length > 1) {
          const selected = await select({
            message: "Select the Jira site to link:",
            choices: deduped.map((item) => ({
              name: `${item.name} (${item.url})`,
              value: item.id,
            })),
          });
          resource = deduped.find((item) => item.id === selected) ?? resource;
        }
      }
    } else {
      warn(
        "MCP tool getAccessibleAtlassianResources not available. Storing account without site metadata."
      );
    }

    const hasUserInfo = tools.some((tool) => tool.name === "atlassianUserInfo");
    if (hasUserInfo) {
      try {
        const result = await session.callTool("atlassianUserInfo", {});
        const payload = extractStructuredResult(result);
        if (payload && typeof payload === "object") {
          user =
            payload.email ||
            payload.emailAddress ||
            payload.userEmail ||
            payload.username;
        }
      } catch {
        user = undefined;
      }
    }
  } finally {
    await session.close();
  }

  const account: AccountConfig = {
    alias,
    site: resource?.url ?? "unknown",
    cloudId: resource?.id ?? "unknown",
    user,
    default: options.default ?? Object.keys(config.accounts).length === 0,
  };

  await setAccount(account);

  info(`Account "${alias}" connected to ${account.site}.`);
}

async function handleListAccounts() {
  const config = await loadConfig();
  const accounts = Object.values(config.accounts);
  if (accounts.length === 0) {
    info(formatAccounts(accounts, new Map()));
    return;
  }
  const storeKind = resolveTokenStoreFromConfig(config);
  const tokenStore = await createTokenStore({ store: storeKind });
  const statusMap = new Map<string, string>();
  for (const account of accounts) {
    try {
      const status = await getAuthStatusForAlias({
        alias: account.alias,
        tokenStore,
        storeKind,
        allowPrompt: process.stdin.isTTY,
      });
      const label =
        status.status === "ok"
          ? "ok"
          : status.status === "missing"
            ? "needs login"
            : status.status === "expired"
              ? "expired"
              : "locked";
      statusMap.set(account.alias, label);
    } catch (err) {
      statusMap.set(account.alias, "unknown");
      warn(
        `Failed to resolve auth status for ${account.alias}: ${String(err)}`
      );
    }
  }
  info(formatAccounts(accounts, statusMap));
}

async function handleRemove(alias: string) {
  const config = await loadConfig();
  if (!config.accounts[alias]) {
    warn(`No account found for alias "${alias}".`);
    return;
  }
  const confirmed = await confirm({
    message: `Remove account "${alias}" and delete stored tokens?`,
    default: false,
  });
  if (!confirmed) {
    info("Remove cancelled.");
    return;
  }
  const tokenStore = await createTokenStore({
    store: resolveTokenStoreFromConfig(config),
  });
  await tokenStore.remove(alias);
  await removeAccount(alias);
  info(`Removed account "${alias}".`);
}

async function handleServe(options: {
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
}) {
  setLogTarget("stderr");
  const config = await loadConfig();
  const scopes = resolveScopes(options.scopes);
  const tokenStoreKind = resolveTokenStoreFromConfig(config);
  const tokenStore = await createTokenStore({
    store: tokenStoreKind,
  });
  const manager = new SessionManager(
    tokenStore,
    scopes,
    getStaticClientInfoFromEnv(options),
    tokenStoreKind
  );
  await manager.loadAll();
  if (manager.listAccounts().length === 0) {
    warn("No accounts configured. Run `mcp-multi-jira login <alias>` first.");
    return;
  }
  await manager.connectAll();
  await startLocalServer(manager, PACKAGE_VERSION);
}

async function handleTokenStore(storeValue?: string) {
  const normalized = normalizeTokenStore(storeValue);
  if (!storeValue) {
    const config = await loadConfig();
    const envOverride = normalizeTokenStore(process.env.MCP_JIRA_TOKEN_STORE);
    const effective = resolveTokenStoreFromConfig(config);
    if (envOverride && envOverride !== config.tokenStore) {
      warn(
        `MCP_JIRA_TOKEN_STORE is set to ${envOverride}. This overrides the configured default (${
          config.tokenStore ?? "plain"
        }).`
      );
    }
    info(`Current token store: ${effective}.`);
    info("Available token stores: encrypted, plain, keychain.");
    info("Set with: mcp-multi-jira token-store <store>");
    return;
  }
  if (!normalized) {
    throw new Error(
      "Invalid token store. Use one of: encrypted, plain, keychain."
    );
  }
  const config = await loadConfig();
  const envOverride = normalizeTokenStore(process.env.MCP_JIRA_TOKEN_STORE);
  if (envOverride && envOverride !== config.tokenStore) {
    warn(
      `MCP_JIRA_TOKEN_STORE is set to ${envOverride}. This overrides the configured default (${
        config.tokenStore ?? "plain"
      }).`
    );
  }
  const currentStore = config.tokenStore ?? "plain";
  if (currentStore === normalized) {
    info(`Token store already set to ${normalized}.`);
    return;
  }
  const aliases = Object.keys(config.accounts);
  let shouldMigrate = false;
  if (aliases.length > 0 && process.stdin.isTTY) {
    shouldMigrate = await confirm({
      message: `Migrate ${
        aliases.length
      } account token(s) from ${describeTokenStore(
        currentStore
      )} to ${describeTokenStore(
        normalized
      )}? This will move tokens to the new backend.`,
      default: true,
    });
  } else if (aliases.length > 0) {
    warn(
      "Accounts exist but no TTY available to prompt for migration. Tokens will remain in the previous store."
    );
  }
  if (shouldMigrate) {
    const result = await migrateTokenStore({
      from: currentStore,
      to: normalized,
      aliases,
    });
    info(`Migrated ${result.migrated} account(s) to ${normalized}.`);
    if (result.alreadyPresent > 0) {
      info(
        `${result.alreadyPresent} account(s) already had tokens in ${normalized}.`
      );
    }
    if (result.missing > 0) {
      warn(`${result.missing} account(s) had no tokens in the previous store.`);
    }
  }
  await setTokenStore(normalized);
  info(`Default token store set to ${normalized}.`);
  if (!shouldMigrate && aliases.length > 0) {
    warn(
      "Tokens remain in the previous store. Run the token-store command again to migrate, or re-login."
    );
  }
}

async function main() {
  const program = new Command();
  program
    .name("mcp-multi-jira")
    .description("Multi-account Jira MCP server and CLI")
    .version(PACKAGE_VERSION)
    .option("--client-id <clientId>", "Atlassian OAuth client ID")
    .option("--client-secret <clientSecret>", "Atlassian OAuth client secret")
    .option("--scopes <scopes>", "OAuth scopes (space or comma separated)");

  program
    .command("login")
    .argument("<alias>", "Account alias to store")
    .option("--default", "Mark this account as default")
    .action(async (alias, options) => {
      const opts = program.opts();
      await handleLogin(alias, { ...opts, ...options });
    });

  program
    .command("list")
    .description("List configured Jira accounts")
    .action(handleListAccounts);

  program
    .command("remove")
    .argument("<alias>", "Account alias to remove")
    .description("Remove a Jira account and delete stored tokens")
    .action(async (alias) => {
      await handleRemove(alias);
    });

  program
    .command("serve")
    .description("Start the local MCP server")
    .action(async (options) => {
      const opts = program.opts();
      await handleServe({ ...opts, ...options });
    });

  program
    .command("token-store")
    .argument("[store]", "Token store backend (encrypted|plain|keychain)")
    .description("Set the default token storage backend")
    .action(async (store) => {
      await handleTokenStore(store);
    });

  program
    .command("install")
    .description("Install MCP configuration into supported agents")
    .action(async () => {
      const config = await loadConfig();
      await runInstaller({
        tokenStore:
          normalizeTokenStore(process.env.MCP_JIRA_TOKEN_STORE) ??
          config.tokenStore,
      });
    });

  if (process.argv.length <= 2) {
    program.outputHelp();
    return;
  }

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
