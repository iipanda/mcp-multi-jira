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
import { RemoteSession } from "./mcp/remote-session.js";
import { startLocalServer } from "./mcp/server.js";
import { SessionManager } from "./mcp/session-manager.js";
import type { ToolDefinition } from "./mcp/types.js";
import {
  DEFAULT_SCOPES,
  getStaticClientInfoFromEnv,
  isInvalidGrantError,
  loginWithDynamicOAuth,
  refreshTokensIfNeeded,
} from "./oauth/atlassian.js";
import {
  createTokenStore,
  getAuthStatusForAlias,
  type TokenStore,
} from "./security/token-store.js";
import type {
  AccountConfig,
  AuthStatus,
  TokenSet,
  TokenStoreKind,
} from "./types.js";
import { info, setLogTarget, warn } from "./utils/log.js";
import { PACKAGE_VERSION } from "./version.js";

const SCOPE_SPLIT_RE = /[ ,]+/;
const RESOURCE_ARRAY_KEYS = [
  "resources",
  "values",
  "items",
  "sites",
  "data",
] as const;

type JsonRecord = Record<string, unknown>;
type ResourceInfo = { id: string; url: string; name: string };
type TextContentItem = { type: string; text: string };

function parseScopes(scopes?: string) {
  if (!scopes) {
    return DEFAULT_SCOPES;
  }
  return scopes
    .split(SCOPE_SPLIT_RE)
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

function formatAuthStatus(status: AuthStatus): string {
  switch (status.status) {
    case "ok":
      return "ok";
    case "missing":
      return "needs login";
    case "expired":
      return "expired";
    case "invalid":
      return "needs relogin";
    case "locked":
      return "locked";
    default:
      return "unknown";
  }
}

function shouldVerifyRefresh(tokens: TokenSet | null) {
  if (!tokens || tokens.refreshInvalid) {
    return false;
  }
  if (!tokens.refreshToken) {
    return false;
  }
  return tokens.expiresAt < Date.now() + 5 * 60 * 1000;
}

async function resolveAuthStatusForList(options: {
  alias: string;
  tokenStore: TokenStore;
  storeKind: TokenStoreKind;
  allowPrompt: boolean;
  scopes: string[];
  staticClientInfo: ReturnType<typeof getStaticClientInfoFromEnv>;
}): Promise<AuthStatus> {
  const status = await getAuthStatusForAlias({
    alias: options.alias,
    tokenStore: options.tokenStore,
    storeKind: options.storeKind,
    allowPrompt: options.allowPrompt,
  });

  if (status.status !== "ok") {
    return status;
  }

  const tokens = await options.tokenStore.get(options.alias);
  if (!shouldVerifyRefresh(tokens)) {
    return status;
  }

  try {
    await refreshTokensIfNeeded({
      alias: options.alias,
      tokenStore: options.tokenStore,
      scopes: options.scopes,
      staticClientInfo: options.staticClientInfo,
    });
    return status;
  } catch (err) {
    if (tokens && isInvalidGrantError(err)) {
      await options.tokenStore.set(options.alias, {
        ...tokens,
        refreshInvalid: true,
      });
      return {
        status: "invalid",
        reason: `Stored refresh token is invalid. Run \`mcp-multi-jira login ${options.alias}\` to reauthenticate this account.`,
      };
    }

    warn(`Failed to refresh tokens for ${options.alias}: ${String(err)}`);
    return status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object";
}

function extractStructuredContent(result: JsonRecord): unknown | null {
  if ("structuredContent" in result && result.structuredContent) {
    return result.structuredContent;
  }
  return null;
}

function extractToolResult(result: JsonRecord): unknown | null {
  if ("toolResult" in result) {
    return result.toolResult;
  }
  return null;
}

function extractTextItems(result: JsonRecord): TextContentItem[] {
  const raw = result.content;
  if (!Array.isArray(raw)) {
    return [];
  }
  const items: TextContentItem[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const type = typeof entry.type === "string" ? entry.type : "";
    const text = typeof entry.text === "string" ? entry.text : "";
    if (type === "text" && text) {
      items.push({ type, text });
    }
  }
  return items;
}

function parseJsonPayload(text: string): unknown | null {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function extractStructuredResult(result: unknown): unknown | null {
  if (!isRecord(result)) {
    return null;
  }
  const structured = extractStructuredContent(result);
  if (structured) {
    return structured;
  }
  const toolResult = extractToolResult(result);
  if (toolResult) {
    return toolResult;
  }
  for (const item of extractTextItems(result)) {
    const parsed = parseJsonPayload(item.text);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function pickResourceArray(payload: unknown): unknown[] | null {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (!isRecord(payload)) {
    return null;
  }
  for (const key of RESOURCE_ARRAY_KEYS) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

function toStringValue(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function normalizeResource(raw: unknown): ResourceInfo | null {
  if (!isRecord(raw)) {
    return null;
  }
  const cloudId =
    toStringValue(raw.id) ??
    toStringValue(raw.cloudId) ??
    toStringValue(raw.cloud_id) ??
    toStringValue(raw.resourceId) ??
    toStringValue(raw.resource_id);
  const url =
    toStringValue(raw.url) ??
    toStringValue(raw.baseUrl) ??
    toStringValue(raw.base_url) ??
    toStringValue(raw.siteUrl);
  const name =
    toStringValue(raw.name) ??
    toStringValue(raw.label) ??
    toStringValue(raw.displayName);
  if (!(cloudId && url)) {
    return null;
  }
  return {
    id: cloudId,
    url,
    name: name ?? url,
  };
}

function dedupeResources(resources: ResourceInfo[]): ResourceInfo[] {
  const unique = new Map<string, ResourceInfo>();
  for (const item of resources) {
    const key = `${item.id}|${item.url}`;
    if (!unique.has(key)) {
      unique.set(key, item);
    }
  }
  return Array.from(unique.values());
}

function toolNameSet(tools: ToolDefinition[]) {
  return new Set(tools.map((tool) => tool.name));
}

async function fetchAccessibleResources(
  session: RemoteSession,
  toolNames: Set<string>
): Promise<ResourceInfo[]> {
  if (!toolNames.has("getAccessibleAtlassianResources")) {
    warn(
      "MCP tool getAccessibleAtlassianResources not available. Storing account without site metadata."
    );
    return [];
  }
  const result = await session.callTool("getAccessibleAtlassianResources", {});
  const payload = extractStructuredResult(result);
  const resources = pickResourceArray(payload) ?? [];
  const normalized = resources
    .map(normalizeResource)
    .filter((item): item is ResourceInfo => Boolean(item));
  return dedupeResources(normalized);
}

async function selectResource(
  resources: ResourceInfo[]
): Promise<ResourceInfo | null> {
  if (resources.length === 0) {
    return null;
  }
  if (resources.length === 1) {
    return resources[0];
  }
  const selected = await select({
    message: "Select the Jira site to link:",
    choices: resources.map((item) => ({
      name: `${item.name} (${item.url})`,
      value: item.id,
    })),
  });
  return resources.find((item) => item.id === selected) ?? resources[0];
}

function extractUserEmail(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return;
  }
  return (
    toStringValue(payload.email) ??
    toStringValue(payload.emailAddress) ??
    toStringValue(payload.userEmail) ??
    toStringValue(payload.username) ??
    undefined
  );
}

async function fetchUserEmail(
  session: RemoteSession,
  toolNames: Set<string>
): Promise<string | undefined> {
  if (!toolNames.has("atlassianUserInfo")) {
    return;
  }
  try {
    const result = await session.callTool("atlassianUserInfo", {});
    const payload = extractStructuredResult(result);
    return extractUserEmail(payload);
  } catch {
    return;
  }
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
  const existingAccount = Boolean(config.accounts[alias]);
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
  if (existingAccount) {
    await tokenStore.remove(alias);
  }
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
  let resource: ResourceInfo | null = null;
  let user: string | undefined;
  try {
    const tools = await session.listTools();
    const toolNames = toolNameSet(tools);
    const resources = await fetchAccessibleResources(session, toolNames);
    if (resources.length === 0) {
      warn("No accessible Jira resources found via MCP.");
    }
    resource = await selectResource(resources);
    user = await fetchUserEmail(session, toolNames);
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
  const scopes = resolveScopes();
  const staticClientInfo = getStaticClientInfoFromEnv();
  const statusMap = new Map<string, string>();
  for (const account of accounts) {
    try {
      const status = await resolveAuthStatusForList({
        alias: account.alias,
        tokenStore,
        storeKind,
        allowPrompt: process.stdin.isTTY,
        scopes,
        staticClientInfo,
      });
      statusMap.set(account.alias, formatAuthStatus(status));
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
  manager.startBackgroundRefresh();
  await startLocalServer(manager, PACKAGE_VERSION);
}

function warnTokenStoreOverride(config: { tokenStore?: TokenStoreKind }) {
  const envOverride = normalizeTokenStore(process.env.MCP_JIRA_TOKEN_STORE);
  if (envOverride && envOverride !== config.tokenStore) {
    warn(
      `MCP_JIRA_TOKEN_STORE is set to ${envOverride}. This overrides the configured default (${config.tokenStore ?? "plain"}).`
    );
  }
}

async function showTokenStoreStatus() {
  const config = await loadConfig();
  warnTokenStoreOverride(config);
  const effective = resolveTokenStoreFromConfig(config);
  info(`Current token store: ${effective}.`);
  info("Available token stores: encrypted, plain, keychain.");
  info("Set with: mcp-multi-jira token-store <store>");
}

async function migrateTokenStoreIfConfirmed(
  fromStore: TokenStoreKind,
  toStore: TokenStoreKind,
  aliases: string[]
) {
  if (aliases.length === 0) {
    return false;
  }
  if (!process.stdin.isTTY) {
    warn(
      "Accounts exist but no TTY available to prompt for migration. Tokens will remain in the previous store."
    );
    return false;
  }
  const shouldMigrate = await confirm({
    message: `Migrate ${aliases.length} account token(s) from ${describeTokenStore(
      fromStore
    )} to ${describeTokenStore(toStore)}? This will move tokens to the new backend.`,
    default: true,
  });
  if (!shouldMigrate) {
    return false;
  }
  const result = await migrateTokenStore({
    from: fromStore,
    to: toStore,
    aliases,
  });
  info(`Migrated ${result.migrated} account(s) to ${toStore}.`);
  if (result.alreadyPresent > 0) {
    info(
      `${result.alreadyPresent} account(s) already had tokens in ${toStore}.`
    );
  }
  if (result.missing > 0) {
    warn(`${result.missing} account(s) had no tokens in the previous store.`);
  }
  return true;
}

async function setTokenStoreWithMigration(store: TokenStoreKind) {
  const config = await loadConfig();
  warnTokenStoreOverride(config);
  const currentStore = config.tokenStore ?? "plain";
  if (currentStore === store) {
    info(`Token store already set to ${store}.`);
    return;
  }
  const aliases = Object.keys(config.accounts);
  const migrated = await migrateTokenStoreIfConfirmed(
    currentStore,
    store,
    aliases
  );
  await setTokenStore(store);
  info(`Default token store set to ${store}.`);
  if (!migrated && aliases.length > 0) {
    warn(
      "Tokens remain in the previous store. Run the token-store command again to migrate, or re-login."
    );
  }
}

async function handleTokenStore(storeValue?: string) {
  if (!storeValue) {
    await showTokenStoreStatus();
    return;
  }
  const normalized = normalizeTokenStore(storeValue);
  if (!normalized) {
    throw new Error(
      "Invalid token store. Use one of: encrypted, plain, keychain."
    );
  }
  await setTokenStoreWithMigration(normalized);
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
