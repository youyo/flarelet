import type { SUPPORTED_AUTH_PROVIDERS } from "../config/index.js";

export type RuntimeLanguage = "python" | "typescript";
export type AuthProvider = "cognito" | (typeof SUPPORTED_AUTH_PROVIDERS)[number];

export interface OidcIR {
  issuer: string;
  scopes: string[];
  /** Cognito の IdP 名（Managed Login のボタン表示）。 */
  name: string;
}

export interface EntraIR {
  /** ディレクトリ（テナント）ID（小文字の GUID）。 */
  tenant: string;
}

/** http.auth.allow（小文字に正規化済み）。 */
export interface AllowIR {
  domains: string[];
  emails: string[];
}

interface AuthOn {
  enabled: true;
  /** 未指定なら IdP で認証できた人は誰でも可。 */
  allow?: AllowIR;
}

export type AuthIR =
  | { enabled: false }
  | (AuthOn & { provider: "cognito" })
  | (AuthOn & { provider: "google" })
  | (AuthOn & { provider: "oidc"; oidc: OidcIR })
  | (AuthOn & { provider: "entra"; entra: EntraIR });

export interface HttpIR {
  auth: AuthIR;
}

export interface GitIR {
  /** "default" はリポジトリの default branch を意味する。それ以外は glob。 */
  production: { branch: string; version: string };
  preview: { branch: string } | null;
  pullRequests: boolean;
}

/** 正規化済み Flareon IR。YAML スキーマと CDK 実装の境界。 */
export interface FlareonIR {
  version: 1;
  name: string;
  runtime: { language: RuntimeLanguage; version: string };
  /** HTTP を公開しない場合は null。 */
  http: HttpIR | null;
  databases: { name: string }[];
  storages: { name: string }[];
  aiModels: string[];
  secrets: string[];
  git: GitIR;
}
