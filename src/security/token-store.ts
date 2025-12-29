import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { password as promptPassword } from "@inquirer/prompts";
import PQueue from "p-queue";
import { plainTokenFilePath, tokenFilePath } from "../config/paths.js";
import type { AuthStatus, TokenSet, TokenStoreKind } from "../types.js";
import { atomicWrite, ensureDir } from "../utils/fs.js";

export type TokenStore = {
  get(alias: string): Promise<TokenSet | null>;
  set(alias: string, tokens: TokenSet): Promise<void>;
  remove(alias: string): Promise<void>;
};

const SERVICE_NAME = "mcp-jira";
const TOKEN_ENV = "MCP_JIRA_TOKEN_PASSWORD";

let cachedPassword: string | null = null;
const fileStoreQueue = new PQueue({ concurrency: 1 });

async function getMasterPassword(intent: "read" | "write") {
  if (cachedPassword !== null) {
    return cachedPassword;
  }
  if (process.env[TOKEN_ENV] !== undefined) {
    cachedPassword = process.env[TOKEN_ENV] as string;
    return cachedPassword;
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      "Encrypted token store requires a password. Set MCP_JIRA_TOKEN_PASSWORD to run non-interactively."
    );
  }
  cachedPassword = await promptPassword({
    message:
      intent === "read"
        ? "Enter master password to unlock Jira tokens"
        : "Create a master password to encrypt Jira tokens",
    mask: "*",
  });
  return cachedPassword;
}

async function loadEncryptedFile(
  password: string
): Promise<Record<string, TokenSet>> {
  const filePath = tokenFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const payload = JSON.parse(raw) as {
      version: number;
      salt: string;
      iv: string;
      tag: string;
      ciphertext: string;
    };
    if (!payload.ciphertext) {
      return {};
    }
    const salt = Buffer.from(payload.salt, "base64");
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const ciphertext = Buffer.from(payload.ciphertext, "base64");
    const key = crypto.scryptSync(password, salt, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(decrypted) as Record<string, TokenSet>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function saveEncryptedFile(
  password: string,
  tokens: Record<string, TokenSet>
) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(tokens);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = {
    version: 1,
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  await ensureDir(path.dirname(tokenFilePath()));
  await atomicWrite(tokenFilePath(), JSON.stringify(payload, null, 2));
}

async function loadPlainFile(): Promise<Record<string, TokenSet>> {
  const filePath = plainTokenFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as Record<string, TokenSet>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

async function savePlainFile(tokens: Record<string, TokenSet>) {
  await ensureDir(path.dirname(plainTokenFilePath()));
  await atomicWrite(plainTokenFilePath(), JSON.stringify(tokens, null, 2));
}

class EncryptedFileTokenStore implements TokenStore {
  async get(alias: string) {
    const password = await getMasterPassword("read");
    const tokens = await loadEncryptedFile(password);
    return tokens[alias] ?? null;
  }

  async set(alias: string, tokens: TokenSet) {
    await fileStoreQueue.add(async () => {
      const password = await getMasterPassword("write");
      const existing = await loadEncryptedFile(password);
      existing[alias] = tokens;
      await saveEncryptedFile(password, existing);
    });
  }

  async remove(alias: string) {
    await fileStoreQueue.add(async () => {
      const password = await getMasterPassword("read");
      const existing = await loadEncryptedFile(password);
      if (existing[alias]) {
        delete existing[alias];
        await saveEncryptedFile(password, existing);
      }
    });
  }
}

class PlaintextTokenStore implements TokenStore {
  async get(alias: string) {
    const tokens = await loadPlainFile();
    return tokens[alias] ?? null;
  }

  async set(alias: string, tokens: TokenSet) {
    await fileStoreQueue.add(async () => {
      const existing = await loadPlainFile();
      existing[alias] = tokens;
      await savePlainFile(existing);
    });
  }

  async remove(alias: string) {
    await fileStoreQueue.add(async () => {
      const existing = await loadPlainFile();
      if (existing[alias]) {
        delete existing[alias];
        await savePlainFile(existing);
      }
    });
  }
}

class KeytarTokenStore implements TokenStore {
  private readonly keytar: typeof import("keytar");

  constructor(keytar: typeof import("keytar")) {
    this.keytar = keytar;
  }

  async get(alias: string) {
    const raw = await this.keytar.getPassword(SERVICE_NAME, `tokens:${alias}`);
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as TokenSet;
  }

  async set(alias: string, tokens: TokenSet) {
    await this.keytar.setPassword(
      SERVICE_NAME,
      `tokens:${alias}`,
      JSON.stringify(tokens)
    );
  }

  async remove(alias: string) {
    await this.keytar.deletePassword(SERVICE_NAME, `tokens:${alias}`);
  }
}

async function loadKeytar() {
  try {
    const mod = await import("keytar");
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export async function getAuthStatusForAlias(options: {
  alias: string;
  tokenStore: TokenStore;
  storeKind: TokenStoreKind;
  allowPrompt?: boolean;
}): Promise<AuthStatus> {
  const allowPrompt = options.allowPrompt ?? false;
  if (
    options.storeKind === "encrypted" &&
    !allowPrompt &&
    process.env[TOKEN_ENV] === undefined
  ) {
    return {
      status: "locked",
      reason:
        "Encrypted token store is locked. Set MCP_JIRA_TOKEN_PASSWORD or login interactively.",
    };
  }
  const tokens = await options.tokenStore.get(options.alias);
  if (!tokens) {
    return {
      status: "missing",
      reason: "No tokens found. Run login to authenticate this account.",
    };
  }
  if (tokens.refreshInvalid) {
    return {
      status: "invalid",
      reason: `Stored refresh token is invalid. Run \`mcp-multi-jira login ${options.alias}\` to reauthenticate this account.`,
    };
  }
  if (tokens.expiresAt < Date.now() && !tokens.refreshToken) {
    return {
      status: "expired",
      reason: "Token expired and no refresh token available. Run login again.",
    };
  }
  return { status: "ok" };
}

export async function createTokenStore(options?: {
  useKeychain?: boolean;
  store?: TokenStoreKind;
}): Promise<TokenStore> {
  const useKeychain = options?.useKeychain;
  let store = options?.store ?? "encrypted";
  if (useKeychain) {
    store = "keychain";
  }
  if (store === "keychain") {
    const keytar = await loadKeytar();
    if (!keytar) {
      throw new Error(
        "Keychain usage requested but keytar could not be loaded. Reinstall dependencies or switch token storage to plain/encrypted."
      );
    }
    return new KeytarTokenStore(keytar);
  }
  if (store === "plain") {
    return new PlaintextTokenStore();
  }
  return new EncryptedFileTokenStore();
}
