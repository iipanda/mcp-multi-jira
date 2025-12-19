export interface AccountConfig {
  alias: string;
  site: string;
  cloudId: string;
  user?: string;
  default?: boolean;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  tokenType?: string;
}

export type TokenStoreKind = "encrypted" | "plain" | "keychain";

export type AuthStatus = {
  status: "ok" | "missing" | "expired" | "locked";
  reason?: string;
};

export interface ConfigFile {
  accounts: Record<string, AccountConfig>;
  tokenStore?: TokenStoreKind;
}
