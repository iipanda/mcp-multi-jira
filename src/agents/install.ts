import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonMap } from "@iarna/toml";
import toml from "@iarna/toml";
import { checkbox, confirm, password } from "@inquirer/prompts";
import type { TokenStoreKind } from "../types.js";
import { backupFile } from "../utils/fs.js";
import { info, warn } from "../utils/log.js";

type AgentTarget = "cursor" | "codex" | "claude";

const MCP_SERVER_NAME = "mcp-jira";
type JsonRecord = JsonMap;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object";
}

function ensureRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function getOrCreateRecord(container: JsonRecord, key: string): JsonRecord {
  const current = container[key];
  if (isRecord(current)) {
    return current;
  }
  const next: JsonRecord = {};
  container[key] = next;
  return next;
}

function createMcpServerEntry(env: Record<string, string>): JsonRecord {
  return {
    command: "npx",
    args: ["-y", "mcp-multi-jira", "serve"],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}

function resolveEnvDefaults() {
  return {
    clientId:
      process.env.MCP_JIRA_CLIENT_ID || process.env.ATLASSIAN_CLIENT_ID || "",
    clientSecret:
      process.env.MCP_JIRA_CLIENT_SECRET ||
      process.env.ATLASSIAN_CLIENT_SECRET ||
      "",
    tokenPassword: process.env.MCP_JIRA_TOKEN_PASSWORD || "",
    tokenStore: process.env.MCP_JIRA_TOKEN_STORE || "",
  };
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

async function promptEnv(tokenStore: TokenStoreKind) {
  const defaults = resolveEnvDefaults();
  if (tokenStore !== "encrypted") {
    return { tokenPassword: "" };
  }
  if (defaults.tokenPassword) {
    return { tokenPassword: defaults.tokenPassword };
  }
  const tokenPassword = await password({
    message:
      "Master token password for encrypted storage (leave blank to skip):",
  });
  return { tokenPassword };
}

function buildEnv(envInput: {
  clientId?: string;
  clientSecret?: string;
  tokenPassword?: string;
  tokenStore?: TokenStoreKind | string;
}) {
  const env: Record<string, string> = {};
  if (envInput.clientId) {
    env.MCP_JIRA_CLIENT_ID = envInput.clientId;
  }
  if (envInput.clientSecret) {
    env.MCP_JIRA_CLIENT_SECRET = envInput.clientSecret;
  }
  if (envInput.tokenPassword) {
    env.MCP_JIRA_TOKEN_PASSWORD = envInput.tokenPassword;
  }
  if (envInput.tokenStore) {
    env.MCP_JIRA_TOKEN_STORE = String(envInput.tokenStore);
  }
  if (envInput.tokenStore === "keychain") {
    env.MCP_JIRA_USE_KEYCHAIN = "true";
  }
  return env;
}

function isJiraEntry(name: string, entry: unknown) {
  const lowered = name.toLowerCase();
  if (lowered.includes("jira") || lowered.includes("atlassian")) {
    return true;
  }
  const serialized = JSON.stringify(entry ?? "").toLowerCase();
  return (
    serialized.includes("mcp.atlassian.com") ||
    serialized.includes("mcp-atlassian") ||
    serialized.includes("jira_url")
  );
}

async function removeJiraEntries(
  entries: JsonRecord,
  message: string,
  configPath: string
) {
  const jiraKeys = Object.keys(entries).filter((key) =>
    isJiraEntry(key, entries[key])
  );
  if (jiraKeys.length === 0) {
    return true;
  }
  const remove = await confirm({
    message: `${message} (${jiraKeys.join(", ")}). Remove them?`,
    default: false,
  });
  if (!remove) {
    warn(`Skipping config update for ${configPath}.`);
    return false;
  }
  await backupFile(configPath);
  for (const key of jiraKeys) {
    delete entries[key];
  }
  return true;
}

async function readJsonConfig(filePath: string) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return { config: ensureRecord(JSON.parse(raw)), exists: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { config: {}, exists: false };
    }
    throw err;
  }
}

async function loadClaudeConfig() {
  const home = os.homedir();
  const mcpServersPath = path.join(home, ".claude", "mcp_servers.json");
  const globalConfigPath = path.join(home, ".claude.json");
  const mcpFile = await readJsonConfig(mcpServersPath);
  if (mcpFile.exists) {
    return { config: mcpFile.config, targetPath: mcpServersPath, mode: "mcp" };
  }
  const globalFile = await readJsonConfig(globalConfigPath);
  return {
    config: globalFile.config,
    targetPath: globalConfigPath,
    mode: "project",
  };
}

async function updateCursorConfig(
  configPath: string,
  env: Record<string, string>
) {
  let config: JsonRecord = { mcpServers: {} };
  let exists = false;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    config = ensureRecord(JSON.parse(raw));
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const mcpServers = getOrCreateRecord(config, "mcpServers");
  if (exists) {
    const shouldContinue = await removeJiraEntries(
      mcpServers,
      `Cursor config ${configPath} contains Jira MCP entries`,
      configPath
    );
    if (!shouldContinue) {
      return;
    }
  }

  mcpServers[MCP_SERVER_NAME] = createMcpServerEntry(env);

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  info(`Updated Cursor MCP config: ${configPath}`);
}

async function updateCodexConfig(
  configPath: string,
  env: Record<string, string>
) {
  let config: JsonRecord = {};
  let exists = false;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    config = ensureRecord(toml.parse(raw));
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const servers = getOrCreateRecord(config, "mcp_servers");
  if (exists) {
    const shouldContinue = await removeJiraEntries(
      servers,
      "Codex config has Jira MCP entries",
      configPath
    );
    if (!shouldContinue) {
      return;
    }
  }

  servers[MCP_SERVER_NAME.replace(/-/g, "_")] = createMcpServerEntry(env);
  config.mcp_servers = servers;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, toml.stringify(config), "utf8");
  info(`Updated Codex MCP config: ${configPath}`);
}

async function updateClaudeMcpServers(
  config: JsonRecord,
  targetPath: string,
  env: Record<string, string>
) {
  const mcpServers = getOrCreateRecord(config, "mcpServers");
  const shouldContinue = await removeJiraEntries(
    mcpServers,
    "Claude MCP config has Jira entries",
    targetPath
  );
  if (!shouldContinue) {
    return false;
  }
  mcpServers[MCP_SERVER_NAME] = createMcpServerEntry(env);
  return true;
}

async function updateClaudeProjectConfig(
  config: JsonRecord,
  targetPath: string,
  env: Record<string, string>
) {
  const projectPath = process.cwd();
  const projects = getOrCreateRecord(config, "projects");
  const project = getOrCreateRecord(projects, projectPath);
  const mcpServers = getOrCreateRecord(project, "mcpServers");
  const shouldContinue = await removeJiraEntries(
    mcpServers,
    `Claude config for ${projectPath} has Jira entries`,
    targetPath
  );
  if (!shouldContinue) {
    return false;
  }
  mcpServers[MCP_SERVER_NAME] = createMcpServerEntry(env);
  return true;
}

async function updateClaudeConfig(env: Record<string, string>) {
  const { config, targetPath, mode } = await loadClaudeConfig();
  const updated =
    mode === "mcp"
      ? await updateClaudeMcpServers(config, targetPath, env)
      : await updateClaudeProjectConfig(config, targetPath, env);
  if (!updated) {
    return;
  }
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, JSON.stringify(config, null, 2), "utf8");
  info(`Updated Claude MCP config: ${targetPath}`);
}

export async function runInstaller(options?: {
  tokenStore?: TokenStoreKind | string;
}) {
  const targets = (await checkbox<AgentTarget>({
    message: "Select which agents to configure:",
    choices: [
      { name: "Cursor", value: "cursor" },
      { name: "OpenAI Codex CLI", value: "codex" },
      { name: "Claude Code CLI", value: "claude" },
    ],
    required: true,
  })) as AgentTarget[];

  const defaults = resolveEnvDefaults();
  const envStore =
    normalizeTokenStore(options?.tokenStore) ??
    normalizeTokenStore(process.env.MCP_JIRA_TOKEN_STORE) ??
    (process.env.MCP_JIRA_USE_KEYCHAIN ? "keychain" : null) ??
    normalizeTokenStore(defaults.tokenStore) ??
    "plain";
  const envInput = await promptEnv(envStore);
  const env = buildEnv({
    ...envInput,
    tokenStore: envStore,
    clientId: defaults.clientId,
    clientSecret: defaults.clientSecret,
  });

  for (const target of targets) {
    if (target === "cursor") {
      const home = os.homedir();
      const globalPath = path.join(home, ".cursor", "mcp.json");
      const localPath = path.join(process.cwd(), ".cursor", "mcp.json");
      await updateCursorConfig(globalPath, env);
      try {
        await fs.access(localPath);
        const updateLocal = await confirm({
          message: `Also update local Cursor config at ${localPath}?`,
          default: false,
        });
        if (updateLocal) {
          await updateCursorConfig(localPath, env);
        }
      } catch {
        // ignore missing local config
      }
      continue;
    }
    if (target === "codex") {
      const configPath = path.join(os.homedir(), ".codex", "config.toml");
      await updateCodexConfig(configPath, env);
      continue;
    }
    if (target === "claude") {
      await updateClaudeConfig(env);
    }
  }

  info(
    "Installation complete. Restart each agent to load the new MCP configuration."
  );
}
