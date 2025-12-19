import { promises as fs } from "node:fs";
import path from "node:path";

export async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

export async function atomicWrite(filePath: string, contents: string) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.tmp-${Date.now()}-${process.pid}`);
  await fs.writeFile(tempPath, contents, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function backupFile(filePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.${timestamp}.bak`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}
