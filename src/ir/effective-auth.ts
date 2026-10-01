import type { Deployment } from "../resolver/index.js";
import type { AuthIR, FlareletIR } from "./types.js";

/**
 * デプロイで実際に効く HTTP 認証。PR preview（ephemeral）は `http.auth: false` でも Preview Auth を強制する
 * （仕様 §9: PR preview を誤って無認証公開にしない）。
 */
export type EffectiveAuth =
  | { kind: "none" }
  | { kind: "preview"; forced: boolean }
  | { kind: "cognito"; auth: Extract<AuthIR, { enabled: true }> };

export function effectiveAuth(ir: FlareletIR, d: Deployment): EffectiveAuth | null {
  if (!ir.http) return null;
  const a = ir.http.auth;
  if (d.lifecycle === "ephemeral") return { kind: "preview", forced: !a.enabled };
  return a.enabled ? { kind: "cognito", auth: a } : { kind: "none" };
}
