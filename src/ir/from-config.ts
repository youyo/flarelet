import type { FlareletConfig } from "../config/index.js";
import type { AuthIR, FlareletIR, HttpIR } from "./types.js";

export const DEFAULT_RUNTIME_VERSION = { python: "3.13", typescript: "24" } as const;

function toAuth(
  auth: NonNullable<Extract<FlareletConfig["http"], object>["auth"]> | undefined,
): AuthIR {
  if (auth === false) return { enabled: false };
  if (auth === undefined || auth === true) return { enabled: true, provider: "cognito" };
  const p = auth.provider ?? "cognito";
  const lower = (xs: string[] | undefined) => (xs ?? []).map((x) => x.toLowerCase());
  const allow = auth.allow
    ? { allow: { domains: lower(auth.allow.domains), emails: lower(auth.allow.emails) } }
    : {};
  if (p === "entra") {
    return {
      enabled: true,
      provider: "entra",
      entra: { tenant: (auth.tenant ?? "").toLowerCase() },
      ...allow,
    };
  }
  if (p === "oidc") {
    return {
      enabled: true,
      provider: "oidc",
      ...allow,
      oidc: {
        issuer: auth.issuer ?? "",
        scopes: auth.scopes ?? ["openid", "email", "profile"],
        name: auth.name ?? "OIDC",
      },
    };
  }
  // saml はスキーマで弾いている
  if (p !== "cognito" && p !== "google") throw new Error(`internal: unsupported provider ${p}`);
  return { enabled: true, provider: p, ...allow };
}

function toHttp(http: FlareletConfig["http"]): HttpIR | null {
  if (http === undefined || http === false) return null;
  if (http === true) return { auth: toAuth(undefined) };
  return { auth: toAuth(http.auth) };
}

const names = (r: Record<string, unknown> | undefined) =>
  Object.keys(r ?? {})
    .sort()
    .map((name) => ({ name }));

export function toIR(c: FlareletConfig): FlareletIR {
  return {
    version: 1,
    name: c.name,
    runtime: {
      language: c.runtime.language,
      version: c.runtime.version ?? DEFAULT_RUNTIME_VERSION[c.runtime.language],
    },
    http: toHttp(c.http),
    databases: names(c.database),
    storages: names(c.storage),
    aiModels: [...(c.ai?.models ?? [])],
    secrets: [...(c.secrets ?? [])],
    git: {
      production: {
        branch: c.git?.production?.branch ?? "default",
        version: c.git?.production?.version ?? "current",
      },
      preview: c.git?.preview ? { branch: c.git.preview.branch } : null,
      pullRequests: c.git?.pullRequests ?? true,
    },
  };
}
