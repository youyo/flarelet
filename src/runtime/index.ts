// `flareon/runtime`: アプリ向け runtime bindings。環境変数を読むだけで AWS には接続しない。
import { bindingEnvName, type BindingKind } from "./env.js";

export { bindingEnvName } from "./env.js";

type Env = Record<string, string | undefined>;

function need(kind: BindingKind, label: string, name: string, suffix: string, env: Env): string {
  const key = bindingEnvName(kind, name, suffix);
  const v = env[key];
  if (!v) {
    throw new Error(
      `${label} "${name}" is not bound: ${key} is not set (is it declared in flareon.yaml?)`,
    );
  }
  return v;
}

export const bindings = {
  database: (name: string, env: Env = process.env) => ({
    tableName: need("DATABASE", "database", name, "TABLE", env),
  }),
  storage: (name: string, env: Env = process.env) => ({
    bucketName: need("STORAGE", "storage", name, "BUCKET", env),
  }),
  ai: (name: string, env: Env = process.env) => ({
    modelId: need("AI", "ai model", name, "MODEL_ID", env),
  }),
};

export interface Identity {
  sub: string;
  email: string | undefined;
  authMode: string | undefined;
}

type HeaderBag = Headers | Record<string, string | string[] | undefined>;

function header(h: HeaderBag, name: string): string | undefined {
  if (h instanceof Headers) return h.get(name) ?? undefined;
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/** Flareon front auth が付与する x-flareon-* ヘッダからユーザーを取り出す。未認証なら null。 */
export function identity(headers: HeaderBag): Identity | null {
  const sub = header(headers, "x-flareon-user-sub");
  if (!sub) return null;
  return {
    sub,
    email: header(headers, "x-flareon-user-email"),
    authMode: header(headers, "x-flareon-auth-mode"),
  };
}
