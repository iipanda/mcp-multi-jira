import os from "node:os";
import path from "node:path";

export function configDir() {
  return path.join(os.homedir(), ".mcp-jira");
}

export function configFilePath() {
  return path.join(configDir(), "config.json");
}

export function tokenFilePath() {
  return path.join(configDir(), "tokens.enc.json");
}

export function plainTokenFilePath() {
  return path.join(configDir(), "tokens.json");
}
