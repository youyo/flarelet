import { createHash } from "node:crypto";

/**
 * http.auth.allow: IdP で認証できたユーザーのうち、アプリに入れる人を絞る（DECISIONS.md「アクセス制限」）。
 * どちらかのリストに一致すれば許可（OR）。リストは小文字で比較する。
 */
export interface AllowPolicy {
  domains: string[];
  emails: string[];
}

export type IdpKind = "cognito" | "google" | "oidc" | "entra";
export const IDP_KINDS: readonly IdpKind[] = ["cognito", "google", "oidc", "entra"];

/** Google Workspace の hosted domain（`hd`）をマッピングする User Pool のカスタム属性。 */
export const HD_CLAIM = "custom:hd";

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v.toLowerCase() : undefined;

const verified = (v: unknown): boolean => v === true || v === "true";

const domainOf = (email: string): string | undefined => {
  const i = email.lastIndexOf("@");
  return i > 0 && i < email.length - 1 ? email.slice(i + 1) : undefined;
};

/**
 * Cognito の id_token のクレームで判定する。
 * - google: domains は Workspace の hd（custom:hd）で判定（会社ドメインの email で作った個人アカウントを弾く）。
 *   emails は email_verified=true の email の完全一致
 * - cognito / oidc: email_verified=true の email のドメイン / 完全一致
 * - entra: Entra は email_verified を出さないので email（無ければ preferred_username）で判定。
 *   テナント固有 issuer でテナント外のユーザーは入れない前提（ゲストはテナント内ユーザーとして扱われる点に注意）
 */
export function isAllowed(
  claims: Record<string, unknown>,
  provider: IdpKind,
  policy: AllowPolicy | undefined,
): boolean {
  if (!policy) return true;
  if (provider === "entra") {
    const email = str(claims["email"]) ?? str(claims["preferred_username"]);
    if (!email) return false;
    const d = domainOf(email);
    return policy.emails.includes(email) || (d !== undefined && policy.domains.includes(d));
  }
  const email = verified(claims["email_verified"]) ? str(claims["email"]) : undefined;
  if (email && policy.emails.includes(email)) return true;
  if (provider === "google") {
    const hd = str(claims[HD_CLAIM]);
    return hd !== undefined && policy.domains.includes(hd);
  }
  const d = email ? domainOf(email) : undefined;
  return d !== undefined && policy.domains.includes(d);
}

/** セッションを発行時のポリシーに結びつけるための値。ポリシーが変わると既存セッションは無効になる。 */
export function policyFingerprint(
  provider: IdpKind,
  policy: AllowPolicy | undefined,
): string | undefined {
  if (!policy) return undefined;
  const canon = JSON.stringify([provider, [...policy.domains].sort(), [...policy.emails].sort()]);
  return createHash("sha256").update(canon).digest("base64url").slice(0, 16);
}
