import { promises as fs } from "node:fs";
import { AccountConfig, ConfigFile, TokenStoreKind } from "../types.js";
import { configDir, configFilePath } from "./paths.js";
import { atomicWrite, ensureDir } from "../utils/fs.js";

const emptyConfig: ConfigFile = { accounts: {} };

export async function loadConfig(): Promise<ConfigFile> {
  const filePath = configFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as ConfigFile;
    if (!parsed.accounts) {
      return { ...emptyConfig };
    }
    return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...emptyConfig };
    }
    throw err;
  }
}

export async function saveConfig(config: ConfigFile) {
  await ensureDir(configDir());
  await atomicWrite(configFilePath(), JSON.stringify(config, null, 2));
}

export async function setAccount(account: AccountConfig) {
  const config = await loadConfig();
  config.accounts[account.alias] = account;
  await saveConfig(config);
}

export async function removeAccount(alias: string) {
  const config = await loadConfig();
  if (config.accounts[alias]) {
    delete config.accounts[alias];
    await saveConfig(config);
  }
}

export async function getAccount(alias: string) {
  const config = await loadConfig();
  return config.accounts[alias] ?? null;
}

export async function listAccounts() {
  const config = await loadConfig();
  return Object.values(config.accounts);
}

export async function getTokenStore() {
  const config = await loadConfig();
  return config.tokenStore ?? null;
}

export async function setTokenStore(tokenStore: TokenStoreKind) {
  const config = await loadConfig();
  config.tokenStore = tokenStore;
  await saveConfig(config);
}
