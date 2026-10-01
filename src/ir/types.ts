import type { AUTH_PROVIDERS } from "../config/index.js";

export type RuntimeLanguage = "python" | "typescript";
export type AuthProvider = "cognito" | (typeof AUTH_PROVIDERS)[number];

export type AuthIR = { enabled: false } | { enabled: true; provider: AuthProvider };

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
