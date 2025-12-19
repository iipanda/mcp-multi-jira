import { readFileSync } from "node:fs";

type PackageJson = { version?: string };

const packageJsonUrl = new URL("../package.json", import.meta.url);
const packageJson = JSON.parse(
  readFileSync(packageJsonUrl, "utf-8")
) as PackageJson;

export const PACKAGE_VERSION = packageJson.version ?? "0.0.0";
