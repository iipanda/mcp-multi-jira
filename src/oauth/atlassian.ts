import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import getPort from "get-port";
import open from "open";

import {
  OAuthClientProvider,
  auth,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  refreshAuthorization,
  selectResourceURL,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import { TokenSet } from "../types.js";
import { TokenStore } from "../security/tokenStore.js";
import { readClientInfo, writeClientInfo } from "./clientInfoStore.js";
import { debug, info, warn } from "../utils/log.js";

export const DEFAULT_SCOPES = [
  "offline_access",
  "read:jira-work",
  "write:jira-work",
  "read:jira-user",
];

export const MCP_SERVER_URL =
  process.env.MCP_JIRA_ENDPOINT ?? "https://mcp.atlassian.com/v1/mcp";
export const MCP_SSE_URL =
  process.env.MCP_JIRA_SSE_ENDPOINT ?? "https://mcp.atlassian.com/v1/sse";

export interface StaticClientInfo {
  clientId: string;
  clientSecret?: string;
}

export function getStaticClientInfoFromEnv(options?: {
  clientId?: string;
  clientSecret?: string;
}): StaticClientInfo | null {
  const clientId =
    options?.clientId ||
    process.env.MCP_JIRA_CLIENT_ID ||
    process.env.ATLASSIAN_CLIENT_ID;
  const clientSecret =
    options?.clientSecret ||
    process.env.MCP_JIRA_CLIENT_SECRET ||
    process.env.ATLASSIAN_CLIENT_SECRET;
  if (!clientId) {
    return null;
  }
  return { clientId, clientSecret };
}

function toTokenSet(tokens: OAuthTokens, fallbackScopes: string[]): TokenSet {
  const scopes = tokens.scope
    ? tokens.scope.split(" ").filter(Boolean)
    : fallbackScopes;
  const expiresIn = tokens.expires_in ?? 0;
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes,
    tokenType: tokens.token_type,
  };
}

function toOAuthTokens(set: TokenSet): OAuthTokens {
  const expiresIn = Math.max(
    0,
    Math.floor((set.expiresAt - Date.now()) / 1000)
  );
  return {
    access_token: set.accessToken,
    refresh_token: set.refreshToken,
    token_type: set.tokenType ?? "Bearer",
    scope: set.scopes.join(" "),
    expires_in: expiresIn,
  };
}

export class LocalOAuthProvider implements OAuthClientProvider {
  private stateValue = crypto.randomUUID();
  private codeVerifierValue?: string;
  private clientInfoCache?: OAuthClientInformationMixed | null;
  private redirectUrlValue?: string;

  constructor(
    private alias: string,
    private tokenStore: TokenStore,
    private scopes: string[],
    private allowRedirect: boolean,
    private staticClientInfo: StaticClientInfo | null
  ) {}

  setRedirectUrl(url: string) {
    this.redirectUrlValue = url;
  }

  getState() {
    return this.stateValue;
  }

  get redirectUrl() {
    return this.redirectUrlValue;
  }

  get clientMetadata() {
    return {
      redirect_uris: this.redirectUrlValue ? [this.redirectUrlValue] : [],
      token_endpoint_auth_method: this.staticClientInfo?.clientSecret
        ? "client_secret_post"
        : "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "mcp-jira",
      client_uri: "https://github.com/",
      scope: this.scopes.join(" "),
    };
  }

  async state() {
    return this.stateValue;
  }

  async clientInformation() {
    if (this.staticClientInfo) {
      return {
        client_id: this.staticClientInfo.clientId,
        client_secret: this.staticClientInfo.clientSecret,
        token_endpoint_auth_method: this.staticClientInfo.clientSecret
          ? "client_secret_post"
          : "none",
      };
    }
    if (this.clientInfoCache !== undefined) {
      return this.clientInfoCache ?? undefined;
    }
    const stored = await readClientInfo(MCP_SERVER_URL);
    this.clientInfoCache = stored;
    return stored ?? undefined;
  }

  async saveClientInformation(info: OAuthClientInformationMixed) {
    this.clientInfoCache = info;
    await writeClientInfo(MCP_SERVER_URL, info);
  }

  async tokens() {
    const tokens = await this.tokenStore.get(this.alias);
    if (!tokens) {
      return undefined;
    }
    return toOAuthTokens(tokens);
  }

  async saveTokens(tokens: OAuthTokens) {
    const set = toTokenSet(tokens, this.scopes);
    await this.tokenStore.set(this.alias, set);
  }

  async redirectToAuthorization(authorizationUrl: URL) {
    if (!this.allowRedirect) {
      throw new Error(
        "Authorization required. Run `mcp-multi-jira login <alias>` to reauthenticate."
      );
    }
    info("Open the following URL in your browser to authorize:");
    info(authorizationUrl.toString());
    try {
      await open(authorizationUrl.toString());
    } catch (err) {
      warn(`Failed to open browser automatically: ${String(err)}`);
    }
  }

  async saveCodeVerifier(codeVerifier: string) {
    this.codeVerifierValue = codeVerifier;
  }

  async codeVerifier() {
    if (!this.codeVerifierValue) {
      throw new Error("Missing OAuth code verifier.");
    }
    return this.codeVerifierValue;
  }
}

export async function startCallbackServer(expectedState: string) {
  const port = await getPort({ port: 3334 });
  const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
  const server = http.createServer();
  const codePromise = new Promise<string>((resolve, reject) => {
    server.on("request", (req, res) => {
      try {
        const url = new URL(req.url ?? "", redirectUri);
        if (url.pathname !== "/oauth/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || state !== expectedState) {
          res.writeHead(400);
          res.end("Invalid OAuth response.");
          reject(new Error("Invalid OAuth response"));
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("Authentication complete. You can return to the CLI.");
        resolve(code);
      } catch (err) {
        reject(err);
      } finally {
        setTimeout(() => server.close(), 100);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return { redirectUri, codePromise };
}

export async function loginWithDynamicOAuth(options: {
  alias: string;
  tokenStore: TokenStore;
  scopes: string[];
  staticClientInfo: StaticClientInfo | null;
}) {
  const provider = new LocalOAuthProvider(
    options.alias,
    options.tokenStore,
    options.scopes,
    true,
    options.staticClientInfo
  );
  const { redirectUri, codePromise } = await startCallbackServer(
    provider.getState()
  );
  provider.setRedirectUrl(redirectUri);
  const result = await auth(provider, {
    serverUrl: MCP_SERVER_URL,
    scope: options.scopes.join(" "),
  });
  if (result !== "REDIRECT") {
    return;
  }
  const code = await codePromise;
  await auth(provider, {
    serverUrl: MCP_SERVER_URL,
    authorizationCode: code,
    scope: options.scopes.join(" "),
  });
}

export async function refreshTokensIfNeeded(options: {
  alias: string;
  tokenStore: TokenStore;
  scopes: string[];
  staticClientInfo: StaticClientInfo | null;
}) {
  const existing = await options.tokenStore.get(options.alias);
  if (!existing) {
    throw new Error("Missing stored tokens.");
  }
  const now = Date.now();
  if (existing.expiresAt > now + 5 * 60 * 1000) {
    return existing;
  }
  if (!existing.refreshToken) {
    throw new Error("No refresh token available. Please login again.");
  }
  const provider = new LocalOAuthProvider(
    options.alias,
    options.tokenStore,
    options.scopes,
    false,
    options.staticClientInfo
  );
  const clientInfo = await provider.clientInformation();
  if (!clientInfo) {
    throw new Error("Missing OAuth client registration. Please login again.");
  }
  let resourceMetadata;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(
      MCP_SERVER_URL
    );
  } catch (err) {
    debug(`Protected resource metadata lookup failed: ${String(err)}`);
  }
  const authServerUrl =
    resourceMetadata?.authorization_servers?.[0] ?? MCP_SERVER_URL;
  const metadata = await discoverAuthorizationServerMetadata(authServerUrl);
  const resource = await selectResourceURL(
    MCP_SERVER_URL,
    {} as OAuthClientProvider,
    resourceMetadata
  );
  const refreshed = await refreshAuthorization(authServerUrl, {
    metadata,
    clientInformation: clientInfo,
    refreshToken: existing.refreshToken,
    resource,
  });
  const updated = toTokenSet(refreshed, options.scopes);
  await options.tokenStore.set(options.alias, updated);
  return updated;
}
