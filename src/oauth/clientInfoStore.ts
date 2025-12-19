import crypto from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";

import { configDir } from "../config/paths.js";
import { atomicWrite, ensureDir } from "../utils/fs.js";

function hashServerUrl(serverUrl: string) {
  return crypto.createHash("sha256").update(serverUrl).digest("hex");
}

function clientInfoPath(serverUrl: string) {
  return path.join(configDir(), "oauth", hashServerUrl(serverUrl), "client_info.json");
}

export async function readClientInfo(
  serverUrl: string,
): Promise<OAuthClientInformationMixed | null> {
  const filePath = clientInfoPath(serverUrl);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as OAuthClientInformationMixed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function writeClientInfo(
  serverUrl: string,
  info: OAuthClientInformationMixed,
) {
  const filePath = clientInfoPath(serverUrl);
  await ensureDir(path.dirname(filePath));
  await atomicWrite(filePath, JSON.stringify(info, null, 2));
}
