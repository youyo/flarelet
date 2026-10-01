import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHandler } from "../../src/auth/router.js";
import { FLOW_COOKIE } from "../../src/auth/cognito.js";
import { SESSION_COOKIE, verifyPayload } from "../../src/auth/session.js";
import {
  CLIENT_ID,
  COGNITO_DOMAIN,
  COGNITO_ENV,
  cookieValue,
  makeDeps,
  makeEvent,
  NOW,
  SESSION_KEY,
} from "./auth-fixtures.js";

const HOST = "abc.execute-api.ap-northeast-1.amazonaws.com";

async function startLogin(returnTo?: string) {
  const deps = await makeDeps();
  const handler = createHandler(COGNITO_ENV, deps);
  const res = await handler(
    makeEvent({
      rawPath: "/__flareon/auth/login",
      rawQueryString: returnTo === undefined ? "" : `return_to=${encodeURIComponent(returnTo)}`,
    }),
  );
  return { deps, handler, res };
}

describe("cognito login", () => {
  it("PKCE 付きで authorize へ 302 し、flow Cookie を発行する", async () => {
    const { res } = await startLogin("/dash?a=1");
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers!.location!);
    expect(loc.origin + loc.pathname).toBe(`${COGNITO_DOMAIN}/oauth2/authorize`);
    expect(loc.searchParams.get("response_type")).toBe("code");
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("redirect_uri")).toBe(`https://${HOST}/__flareon/auth/callback`);
    expect(loc.searchParams.get("scope")).toBe("openid email profile");
    expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
    const flow = cookieValue(res.cookies, FLOW_COOKIE)!;
    const p = verifyPayload(flow, SESSION_KEY, NOW) as Record<string, string>;
    expect(p.state).toBe(loc.searchParams.get("state"));
    expect(p.returnTo).toBe("/dash?a=1");
    expect(loc.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(p.verifier!).digest("base64url"),
    );
    const flowCookie = res.cookies!.find((c) => c.startsWith(`${FLOW_COOKIE}=`))!;
    expect(flowCookie).toContain("HttpOnly");
    expect(flowCookie).toContain("Secure");
  });
  it.each([
    "//evil.com",
    "https://evil.com",
    "/\\evil.com",
    "evil",
    "/a\r\nb",
    "javascript:alert(1)",
  ])("オープンリダイレクト防止: return_to=%j は / にフォールバック", async (rt) => {
    const { res } = await startLogin(rt);
    const flow = cookieValue(res.cookies, FLOW_COOKIE)!;
    const p = verifyPayload(flow, SESSION_KEY, NOW) as Record<string, string>;
    expect(p.returnTo).toBe("/");
  });
});

describe("cognito callback", () => {
  async function callbackSetup(idClaims: Record<string, unknown> = {}, idOpts = {}) {
    const { deps, handler, res } = await startLogin("/dash");
    const loc = new URL(res.headers!.location!);
    const state = loc.searchParams.get("state")!;
    const flow = cookieValue(res.cookies, FLOW_COOKIE)!;
    const verifier = (verifyPayload(flow, SESSION_KEY, NOW) as Record<string, string>).verifier!;
    const nonce = loc.searchParams.get("nonce")!;
    const idToken = await deps.signIdToken(
      { sub: "u1", email: "a@b.c", nonce, ...idClaims },
      idOpts,
    );
    deps.setFetch(async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }));
    const cb = (q: string, cookie = `${FLOW_COOKIE}=${flow}`) =>
      handler(
        makeEvent({
          rawPath: "/__flareon/auth/callback",
          rawQueryString: q,
          cookies: [cookie],
        }),
      );
    return { deps, state, verifier, cb };
  }

  it("成功: トークン交換 → セッション発行 → return_to へ 302", async () => {
    const { deps, state, verifier, cb } = await callbackSetup();
    const res = await cb(`code=CODE&state=${state}`);
    expect(res.statusCode).toBe(302);
    expect(res.headers!.location).toBe("/dash");
    const sess = cookieValue(res.cookies, SESSION_COOKIE)!;
    expect(verifyPayload(sess, SESSION_KEY, NOW)).toMatchObject({
      sub: "u1",
      email: "a@b.c",
      mode: "cognito",
    });
    expect(res.cookies!.some((c) => c.startsWith(`${FLOW_COOKIE}=;`))).toBe(true);
    const call = deps.fetchCalls[0]!;
    expect(call.url).toBe(`${COGNITO_DOMAIN}/oauth2/token`);
    expect(call.init!.method).toBe("POST");
    const body = new URLSearchParams(call.init!.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("CODE");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.get("redirect_uri")).toBe(`https://${HOST}/__flareon/auth/callback`);
  });
  it("state 不一致は 400 で fetch しない", async () => {
    const { deps, cb } = await callbackSetup();
    const res = await cb("code=CODE&state=WRONG");
    expect(res.statusCode).toBe(400);
    expect(deps.fetchCalls).toHaveLength(0);
    expect(cookieValue(res.cookies, SESSION_COOKIE)).toBeUndefined();
  });
  it("flow Cookie が無い/改ざんは 400", async () => {
    const { state, cb } = await callbackSetup();
    expect((await cb(`code=C&state=${state}`, "x=1")).statusCode).toBe(400);
    expect((await cb(`code=C&state=${state}`, `${FLOW_COOKIE}=aaa.bbb`)).statusCode).toBe(400);
  });
  it("code が無い・error 付きは 400", async () => {
    const { state, cb } = await callbackSetup();
    expect((await cb(`state=${state}`)).statusCode).toBe(400);
    expect((await cb(`error=access_denied&state=${state}`)).statusCode).toBe(400);
  });
  it("トークンエンドポイント失敗は 502", async () => {
    const { deps, state, cb } = await callbackSetup();
    deps.setFetch(async () => new Response("{}", { status: 400 }));
    expect((await cb(`code=C&state=${state}`)).statusCode).toBe(502);
  });
  it.each([
    ["aud 不一致", {}, { aud: "other" }],
    ["issuer 不一致", {}, { iss: "https://evil.example.com/x" }],
    ["期限切れ", {}, { exp: Math.floor(NOW / 1000) - 100 }],
    ["token_use=access", { token_use: "access" }, {}],
    ["nonce 不一致", { nonce: "zzz" }, {}],
  ])("id_token 検証失敗(%s)は 401 でセッションを発行しない", async (_n, claims, opts) => {
    const { state, cb } = await callbackSetup(claims, opts);
    const res = await cb(`code=C&state=${state}`);
    expect(res.statusCode).toBe(401);
    expect(cookieValue(res.cookies, SESSION_COOKIE)).toBeUndefined();
  });
});

describe("cognito logout", () => {
  it("Cookie 削除して Cognito /logout へ 302", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      COGNITO_ENV,
      deps,
    )(makeEvent({ rawPath: "/__flareon/auth/logout" }));
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers!.location!);
    expect(loc.origin + loc.pathname).toBe(`${COGNITO_DOMAIN}/logout`);
    expect(loc.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(loc.searchParams.get("logout_uri")).toBe(`https://${HOST}/`);
    expect(res.cookies!.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
  });
});

describe("cognito login with an external identity provider", () => {
  it("skips the provider chooser with identity_provider when configured", async () => {
    const deps = await makeDeps();
    const handler = createHandler(
      { ...COGNITO_ENV, FLAREON_COGNITO_IDENTITY_PROVIDER: "Google" },
      deps,
    );
    const res = await handler(makeEvent({ rawPath: "/__flareon/auth/login" }));
    const loc = new URL(res.headers!.location!);
    expect(loc.searchParams.get("identity_provider")).toBe("Google");
  });

  it("does not send identity_provider by default", async () => {
    const { res } = await startLogin();
    expect(new URL(res.headers!.location!).searchParams.has("identity_provider")).toBe(false);
  });
});
