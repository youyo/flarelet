import type { FlareonConfig } from "../config/index.js";
import type { AuthIR, FlareonIR, HttpIR } from "./types.js";

export const DEFAULT_RUNTIME_VERSION = { python: "3.13", typescript: "24" } as const;

function toAuth(
  auth: NonNullable<Extract<FlareonConfig["http"], object>["auth"]> | undefined,
): AuthIR {
  if (auth === false) return { enabled: false };
  if (auth === undefined || auth === true) return { enabled: true, provider: "cognito" };
  return { enabled: true, provider: auth.provider ?? "cognito" };
}

function toHttp(http: FlareonConfig["http"]): HttpIR | null {
  if (http === undefined || http === false) return null;
  if (http === true) return { auth: toAuth(undefined) };
  return { auth: toAuth(http.auth) };
}

const names = (r: Record<string, unknown> | undefined) =>
  Object.keys(r ?? {})
    .sort()
    .map((name) => ({ name }));

export function toIR(c: FlareonConfig): FlareonIR {
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
