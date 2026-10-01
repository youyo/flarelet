import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import type { CognitoConfig } from "./config.js";
import { json, redirect } from "./responses.js";
import {
  clearSessionCookie,
  issueSessionCookie,
  parseCookies,
  serializeCookie,
  signPayload,
  verifyPayload,
} from "./session.js";
import type { ApiEvent, ApiResult, AuthDeps } from "./types.js";

export const FLOW_COOKIE = "__flareon_flow";
const FLOW_TTL_SECONDS = 10 * 60;
const FLOW_COOKIE_PATH = "/__flareon/auth";
export const CALLBACK_PATH = "/__flareon/auth/callback";

export interface CognitoContext {
  config: CognitoConfig;
  sessionKey: string;
  deps: AuthDeps;
}

/** オープンリダイレクト防止: 同一オリジンのパス（/ 始まり、// や \ を含まない）のみ許可。 */
export function sanitizeReturnTo(v: string | null | undefined): string {
  if (!v || !v.startsWith("/") || v.startsWith("//")) return "/";
  // eslint-disable-next-line no-control-regex
  if (v.includes("\\") || /[\u0000-\u001f\u007f]/.test(v)) return "/";
  return v;
}

function host(event: ApiEvent): string | undefined {
  return event.requestContext.domainName ?? event.headers["host"];
}

function origin(event: ApiEvent): string | undefined {
  const h = host(event);
  return h ? `https://${h}` : undefined;
}

function rand(): string {
  return randomBytes(32).toString("base64url");
}

function clearFlowCookie(): string {
  return serializeCookie(FLOW_COOKIE, "", { maxAge: 0, path: FLOW_COOKIE_PATH });
}

export function cognitoLogin(event: ApiEvent, ctx: CognitoContext): ApiResult {
  const o = origin(event);
  if (!o) return json(400, { error: "missing_host" });
  const returnTo = sanitizeReturnTo(new URLSearchParams(event.rawQueryString).get("return_to"));
  const state = rand();
  const nonce = rand();
  const verifier = rand();
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const flow = signPayload(
    {
      t: "flow",
      state,
      nonce,
      verifier,
      returnTo,
      exp: Math.floor(ctx.deps.now() / 1000) + FLOW_TTL_SECONDS,
    },
    ctx.sessionKey,
  );
  const q = new URLSearchParams({
    response_type: "code",
    client_id: ctx.config.cognito.clientId,
    redirect_uri: `${o}${CALLBACK_PATH}`,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return redirect(`${ctx.config.cognito.domain}/oauth2/authorize?${q}`, [
    serializeCookie(FLOW_COOKIE, flow, { maxAge: FLOW_TTL_SECONDS, path: FLOW_COOKIE_PATH }),
  ]);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const jwksCache = new Map<string, JWTVerifyGetKey>();

function defaultKeyGetter(region: string, poolId: string): JWTVerifyGetKey {
  const url = `https://cognito-idp.${region}.amazonaws.com/${poolId}/.well-known/jwks.json`;
  let g = jwksCache.get(url);
  if (!g) {
    g = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, g);
  }
  return g;
}

export async function verifyIdToken(
  idToken: string,
  nonce: string,
  ctx: CognitoContext,
): Promise<{ sub: string; email?: string }> {
  const { userPoolId, clientId } = ctx.config.cognito;
  const region = userPoolId.split("_")[0] ?? "";
  const getKey = ctx.deps.getVerificationKey ?? defaultKeyGetter(region, userPoolId);
  const { payload } = await jwtVerify(idToken, getKey, {
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    audience: clientId,
    algorithms: ["RS256"],
    currentDate: new Date(ctx.deps.now()),
  });
  if (payload["token_use"] !== "id") throw new Error("token_use is not id");
  if (typeof payload["nonce"] !== "string" || !safeEqual(payload["nonce"], nonce)) {
    throw new Error("nonce mismatch");
  }
  if (typeof payload.sub !== "string") throw new Error("missing sub");
  const email = payload["email"];
  return typeof email === "string" ? { sub: payload.sub, email } : { sub: payload.sub };
}

export async function cognitoCallback(event: ApiEvent, ctx: CognitoContext): Promise<ApiResult> {
  const bad = (status: number, error: string): ApiResult =>
    json(status, { error }, [clearFlowCookie()]);
  const o = origin(event);
  if (!o) return bad(400, "missing_host");
  const q = new URLSearchParams(event.rawQueryString);
  const rawFlow = parseCookies(event)[FLOW_COOKIE];
  const flow = rawFlow ? verifyPayload(rawFlow, ctx.sessionKey, ctx.deps.now()) : undefined;
  if (!flow || flow["t"] !== "flow") return bad(400, "invalid_flow");
  const { state, nonce, verifier, returnTo } = flow as Record<string, unknown>;
  if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string") {
    return bad(400, "invalid_flow");
  }
  const gotState = q.get("state");
  if (q.get("error") || !gotState || !safeEqual(gotState, state)) return bad(400, "invalid_state");
  const code = q.get("code");
  if (!code) return bad(400, "missing_code");

  let idToken: unknown;
  try {
    const res = await ctx.deps.fetch(`${ctx.config.cognito.domain}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: ctx.config.cognito.clientId,
        code,
        redirect_uri: `${o}${CALLBACK_PATH}`,
        code_verifier: verifier,
      }).toString(),
    });
    if (!res.ok) return bad(502, "token_exchange_failed");
    idToken = ((await res.json()) as { id_token?: unknown }).id_token;
  } catch {
    return bad(502, "token_exchange_failed");
  }
  if (typeof idToken !== "string") return bad(502, "token_exchange_failed");

  let identity;
  try {
    identity = await verifyIdToken(idToken, nonce, ctx);
  } catch {
    return bad(401, "invalid_id_token");
  }
  return redirect(sanitizeReturnTo(typeof returnTo === "string" ? returnTo : "/"), [
    issueSessionCookie(identity, "cognito", ctx.sessionKey, ctx.deps.now()),
    clearFlowCookie(),
  ]);
}

export function cognitoLogout(event: ApiEvent, ctx: CognitoContext): ApiResult {
  const o = origin(event);
  const cookies = [clearSessionCookie()];
  if (!o) return redirect("/", cookies);
  const q = new URLSearchParams({ client_id: ctx.config.cognito.clientId, logout_uri: `${o}/` });
  return redirect(`${ctx.config.cognito.domain}/logout?${q}`, cookies);
}
