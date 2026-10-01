// `flarelet/runtime`: アプリ向け runtime bindings。環境変数を読むだけで AWS には接続しない。
import { bindingEnvName, type BindingKind } from "./env.js";

export { bindingEnvName } from "./env.js";

type Env = Record<string, string | undefined>;

function need(kind: BindingKind, label: string, name: string, suffix: string, env: Env): string {
  const key = bindingEnvName(kind, name, suffix);
  const v = env[key];
  if (!v) {
    throw new Error(
      `${label} "${name}" is not bound: ${key} is not set (is it declared in flarelet.yaml?)`,
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
  /** IdP 上のユーザー ID。認可・ユーザーの紐付けにはこれを使う。 */
  sub: string;
  /**
   * IdP が返した email。検証済みとは限らない（cognito ネイティブ以外では IdP 側で自由に設定できることがある）。
   * email で認可・紐付けをするなら emailVerified が true のときだけ使うこと。
   */
  email: string | undefined;
  /** email が IdP で検証済みか（id_token の email_verified）。Entra ID は常に false。 */
  emailVerified: boolean;
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

/** 長さ以外の情報を漏らさない比較（node:crypto に依存しない）。 */
function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Flarelet front auth が付与する x-flarelet-* ヘッダからユーザーを取り出す。未認証なら null。
 * - `http.auth: false`（FLARELET_AUTH_ENABLED=false）では front auth が無くクライアントのヘッダがそのまま届くので、
 *   ヘッダに関わらず常に null を返す。
 * - `flarelet dev`（FLARELET_DEV_SECRET が設定されている）では、dev プロキシが付けた秘密ヘッダ
 *   `x-flarelet-dev-secret` が一致するときだけ identity を返す（プロキシを経由せずアプリに直接届いたリクエストを信用しない）。
 *
 * 認可・ユーザーの紐付けには `sub` を使う。`email` を使う場合は `emailVerified` を確認すること。
 */
export function identity(headers: HeaderBag, env: Env = process.env): Identity | null {
  if (env.FLARELET_AUTH_ENABLED === "false") return null;
  const devSecret = env.FLARELET_DEV_SECRET;
  if (devSecret && !sameSecret(header(headers, "x-flarelet-dev-secret"), devSecret)) return null;
  const sub = header(headers, "x-flarelet-user-sub");
  if (!sub) return null;
  return {
    sub,
    email: header(headers, "x-flarelet-user-email"),
    emailVerified: header(headers, "x-flarelet-user-email-verified") === "true",
    authMode: header(headers, "x-flarelet-auth-mode"),
  };
}
