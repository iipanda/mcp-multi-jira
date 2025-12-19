import { checkbox, confirm, password } from "@inquirer/prompts";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import toml from "@iarna/toml";

import { backupFile } from "../utils/fs.js";
import { info, warn } from "../utils/log.js";
import { TokenStoreKind } from "../types.js";

type AgentTarget = "cursor" | "codex" | "claude";

const MCP_SERVER_NAME = "mcp-jira";

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

async function updateCursorConfig(configPath: string, env: Record<string, string>) {
  let config: any = { mcpServers: {} };
  let exists = false;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    config = JSON.parse(raw);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  if (exists) {
    const entries = config.mcpServers ?? {};
    const jiraKeys = Object.keys(entries).filter((key) =>
      isJiraEntry(key, entries[key]),
    );
    if (jiraKeys.length > 0) {
      const remove = await confirm({
        message: `Cursor config ${configPath} contains Jira MCP entries (${jiraKeys.join(
          ", ",
        )}). Remove them?`,
        default: false,
      });
      if (!remove) {
        warn(`Skipping Cursor config update for ${configPath}.`);
        return;
      }
      await backupFile(configPath);
      for (const key of jiraKeys) {
        delete entries[key];
      }
    }
    config.mcpServers = entries;
  }

  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers[MCP_SERVER_NAME] = {
    command: "npx",
    args: ["-y", "mcp-multi-jira", "serve"],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  info(`Updated Cursor MCP config: ${configPath}`);
}

async function updateCodexConfig(configPath: string, env: Record<string, string>) {
  let config: any = {};
  let exists = false;
  try {
    const raw = await fs.readFile(configPath, "utf8");
    config = toml.parse(raw);
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const servers = config.mcp_servers ?? {};
  const jiraKeys = Object.keys(servers).filter((key) =>
    isJiraEntry(key, servers[key]),
  );
  if (jiraKeys.length > 0) {
    const remove = await confirm({
      message: `Codex config has Jira MCP entries (${jiraKeys.join(
        ", ",
      )}). Remove them?`,
      default: false,
    });
    if (!remove) {
      warn("Skipping Codex config update.");
      return;
    }
    if (exists) {
      await backupFile(configPath);
    }
    for (const key of jiraKeys) {
      delete servers[key];
    }
  }

  servers[MCP_SERVER_NAME.replace(/-/g, "_")] = {
    command: "npx",
    args: ["-y", "mcp-multi-jira", "serve"],
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  config.mcp_servers = servers;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, toml.stringify(config), "utf8");
  info(`Updated Codex MCP config: ${configPath}`);
}

async function updateClaudeConfig(env: Record<string, string>) {
  const home = os.homedir();
  const mcpServersPath = path.join(home, ".claude", "mcp_servers.json");
  const globalConfigPath = path.join(home, ".claude.json");
  let targetPath = mcpServersPath;
  let config: any = { mcpServers: {} };

  try {
    const raw = await fs.readFile(mcpServersPath, "utf8");
    config = JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    targetPath = globalConfigPath;
    try {
      const raw = await fs.readFile(globalConfigPath, "utf8");
      config = JSON.parse(raw);
    } catch (innerErr) {
      if ((innerErr as NodeJS.ErrnoException).code !== "ENOENT") {
        throw innerErr;
      }
      config = {};
    }
  }

  if (targetPath === mcpServersPath) {
    config.mcpServers = config.mcpServers ?? {};
    const jiraKeys = Object.keys(config.mcpServers).filter((key) =>
      isJiraEntry(key, config.mcpServers[key]),
    );
    if (jiraKeys.length > 0) {
      const remove = await confirm({
        message: `Claude MCP config has Jira entries (${jiraKeys.join(
          ", ",
        )}). Remove them?`,
        default: false,
      });
      if (!remove) {
        warn("Skipping Claude config update.");
        return;
      }
      await backupFile(targetPath);
      for (const key of jiraKeys) {
        delete config.mcpServers[key];
      }
    }
    config.mcpServers[MCP_SERVER_NAME] = {
      command: "npx",
      args: ["-y", "mcp-multi-jira", "serve"],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
  } else {
    const projectPath = process.cwd();
    config.projects = config.projects ?? {};
    config.projects[projectPath] = config.projects[projectPath] ?? {};
    const project = config.projects[projectPath];
    project.mcpServers = project.mcpServers ?? {};
    const jiraKeys = Object.keys(project.mcpServers).filter((key) =>
      isJiraEntry(key, project.mcpServers[key]),
    );
    if (jiraKeys.length > 0) {
      const remove = await confirm({
        message: `Claude config for ${projectPath} has Jira entries (${jiraKeys.join(
          ", ",
        )}). Remove them?`,
        default: false,
      });
      if (!remove) {
        warn("Skipping Claude config update.");
        return;
      }
      await backupFile(targetPath);
      for (const key of jiraKeys) {
        delete project.mcpServers[key];
      }
    }
    project.mcpServers[MCP_SERVER_NAME] = {
      command: "npx",
      args: ["-y", "mcp-multi-jira", "serve"],
      ...(Object.keys(env).length > 0 ? { env } : {}),
    };
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
    "Installation complete. Restart each agent to load the new MCP configuration.",
  );
}
