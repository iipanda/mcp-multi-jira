export type AccountConfig = {
  alias: string;
  site: string;
  cloudId: string;
  user?: string;
  default?: boolean;
};

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  refreshInvalid?: boolean;
  expiresAt: number;
  scopes: string[];
  tokenType?: string;
};

export type TokenStoreKind = "encrypted" | "plain" | "keychain";

export type AuthStatus = {
  status: "ok" | "missing" | "expired" | "locked" | "invalid";
  reason?: string;
};

export type ConfigFile = {
  accounts: Record<string, AccountConfig>;
  tokenStore?: TokenStoreKind;
};
