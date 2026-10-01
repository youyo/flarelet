import { createHmac, timingSafeEqual } from "node:crypto";
import type { ApiEvent, AuthMode, Identity } from "./types.js";

/**
 * `__Host-` プレフィックス: ブラウザが Secure・Path=/・Domain なしの場合だけ受け付ける
 * （同一サイトの別ホストや非 HTTPS からの上書き・注入を防ぐ）。
 */
export const SESSION_COOKIE = "__Host-flarelet_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

const COOKIE_ATTRS = "HttpOnly; Secure; SameSite=Lax";

function mac(data: string, key: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** `base64url(json).base64url(hmac)` 形式の署名付き値を作る。 */
export function signPayload(payload: Record<string, unknown>, key: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${mac(body, key).toString("base64url")}`;
}

/** 署名・期限（`exp`: 秒）を検証してペイロードを返す。不正なら undefined。 */
export function verifyPayload(
  token: string,
  key: string,
  nowMs: number,
): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, sig] = parts as [string, string];
  const given = Buffer.from(sig, "base64url");
  const expected = mac(body, key);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const p: unknown = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof p !== "object" || p === null || Array.isArray(p)) return undefined;
    const exp = (p as Record<string, unknown>)["exp"];
    if (typeof exp !== "number" || exp * 1000 <= nowMs) return undefined;
    return p as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAge: number; path?: string },
): string {
  return `${name}=${value}; ${COOKIE_ATTRS}; Path=${opts.path ?? "/"}; Max-Age=${opts.maxAge}`;
}

export function issueSessionCookie(
  identity: Identity,
  mode: AuthMode,
  key: string,
  nowMs: number,
): string {
  const payload: Record<string, unknown> = {
    t: "session",
    mode,
    sub: identity.sub,
    exp: Math.floor(nowMs / 1000) + SESSION_TTL_SECONDS,
  };
  if (identity.email !== undefined) payload["email"] = identity.email;
  if (identity.emailVerified === true) payload["ev"] = true;
  if (identity.policy !== undefined) payload["ap"] = identity.policy;
  if (identity.epoch !== undefined) payload["se"] = identity.epoch;
  return serializeCookie(SESSION_COOKIE, signPayload(payload, key), {
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(): string {
  return serializeCookie(SESSION_COOKIE, "", { maxAge: 0 });
}

/** `cookies` 配列と `cookie` ヘッダの両方から Cookie を読む。 */
export function parseCookies(event: ApiEvent): Record<string, string> {
  const out: Record<string, string> = {};
  const raws = [...(event.cookies ?? [])];
  const h = event.headers["cookie"];
  if (h) raws.push(h);
  for (const raw of raws) {
    for (const part of raw.split(";")) {
      const i = part.indexOf("=");
      if (i <= 0) continue;
      const name = part.slice(0, i).trim();
      if (!(name in out)) out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function readSession(
  event: ApiEvent,
  key: string,
  mode: AuthMode,
  nowMs: number,
  policy?: string,
  epoch?: number,
): Identity | undefined {
  const raw = parseCookies(event)[SESSION_COOKIE];
  if (!raw) return undefined;
  const p = verifyPayload(raw, key, nowMs);
  if (!p || p["t"] !== "session" || p["mode"] !== mode || typeof p["sub"] !== "string")
    return undefined;
  // allow ポリシーがある場合、同じポリシーで発行したセッションだけを受け付ける
  if (policy !== undefined && p["ap"] !== policy) return undefined;
  // セッション世代が変わった（flarelet auth revoke-sessions / auth user remove）セッションは受け付けない
  if (epoch !== undefined && p["se"] !== epoch) return undefined;
  const identity: Identity = { sub: p["sub"] };
  if (typeof p["email"] === "string") identity.email = p["email"];
  identity.emailVerified = p["ev"] === true;
  return identity;
}
