// F4: セッションの失効。front はセッション発行時の「セッション世代」（SSM パラメータのバージョン）を Cookie に入れ、
// 現在の世代と一致しないセッションを拒否する。世代は 60 秒キャッシュする。
import { describe, expect, it } from "vitest";
import { FLOW_COOKIE } from "../../src/auth/cognito.js";
import { parseAuthConfig } from "../../src/auth/config.js";
import { createHandler } from "../../src/auth/router.js";
import { issueSessionCookie, SESSION_COOKIE, verifyPayload } from "../../src/auth/session.js";
import {
  COGNITO_ENV,
  cookieValue,
  EPOCH_PARAM,
  makeDeps,
  makeEvent,
  NOW,
  PREVIEW_ENV,
  PREVIEW_TOKEN,
  SESSION_KEY,
} from "./auth-fixtures.js";

type Deps = Awaited<ReturnType<typeof makeDeps>>;

async function signIn(deps: Deps, handler: ReturnType<typeof createHandler>): Promise<string> {
  const login = await handler(makeEvent({ rawPath: "/__flareon/auth/login" }));
  const loc = new URL(login.headers!.location!);
  const idToken = await deps.signIdToken({
    sub: "u1",
    email: "a@example.com",
    email_verified: true,
    nonce: loc.searchParams.get("nonce"),
  });
  deps.setFetch(async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }));
  const cb = await handler(
    makeEvent({
      rawPath: "/__flareon/auth/callback",
      rawQueryString: `code=C&state=${loc.searchParams.get("state")}`,
      cookies: [`${FLOW_COOKIE}=${cookieValue(login.cookies, FLOW_COOKIE)!}`],
    }),
  );
  expect(cb.statusCode).toBe(302);
  return cookieValue(cb.cookies, SESSION_COOKIE)!;
}

const page = (session: string) =>
  makeEvent({
    rawPath: "/",
    headers: { accept: "text/html" },
    cookies: [`${SESSION_COOKIE}=${session}`],
  });
const api = (session: string) =>
  makeEvent({
    rawPath: "/api",
    headers: { accept: "application/json" },
    cookies: [`${SESSION_COOKIE}=${session}`],
  });

describe("session epoch (cognito)", () => {
  it("binds new sessions to the current epoch read from the SSM parameter", async () => {
    const deps = await makeDeps();
    deps.setEpoch(7);
    const handler = createHandler(COGNITO_ENV, deps);
    const session = await signIn(deps, handler);
    expect(verifyPayload(session, SESSION_KEY, NOW)!["se"]).toBe(7);
    expect(deps.paramCalls).toContain(EPOCH_PARAM);
    expect((await handler(api(session))).statusCode).toBe(200);
  });

  it("revokes sessions once the epoch changes (after the 60 s cache)", async () => {
    const deps = await makeDeps();
    const handler = createHandler(COGNITO_ENV, deps);
    const session = await signIn(deps, handler);
    expect((await handler(api(session))).statusCode).toBe(200);

    deps.setEpoch(2);
    // キャッシュ中（60 秒以内）は古い世代のまま
    deps.setNow(NOW + 59_000);
    expect((await handler(api(session))).statusCode).toBe(200);
    // キャッシュが切れると新しい世代で判定し、古いセッションは未認証扱い
    deps.setNow(NOW + 61_000);
    expect((await handler(api(session))).statusCode).toBe(401);
    const nav = await handler(page(session));
    expect(nav.statusCode).toBe(302);
    expect(nav.headers!.location).toMatch(/^\/__flareon\/auth\/login/);
    // 失効前の 2 回だけがアプリに届く
    expect(deps.invocations).toHaveLength(2);
  });

  it("caches the epoch for 60 seconds", async () => {
    const deps = await makeDeps();
    const handler = createHandler(COGNITO_ENV, deps);
    const session = await signIn(deps, handler);
    const before = deps.paramCalls.length;
    for (let i = 0; i < 5; i++) await handler(api(session));
    expect(deps.paramCalls.length).toBe(before);
    deps.setNow(NOW + 61_000);
    await handler(api(session));
    expect(deps.paramCalls.length).toBe(before + 1);
  });

  it("sessions without an epoch (issued before this change) are not accepted", async () => {
    const deps = await makeDeps();
    const handler = createHandler(COGNITO_ENV, deps);
    const old = issueSessionCookie({ sub: "u1" }, "cognito", SESSION_KEY, NOW).split(";")[0]!;
    expect((await handler(makeEvent({ cookies: [old] }))).statusCode).toBe(401);
    expect(deps.invocations).toHaveLength(0);
  });

  it("fails closed with 503 when the epoch cannot be read, and does not cache the failure", async () => {
    const deps = await makeDeps();
    const handler = createHandler(COGNITO_ENV, deps);
    const session = await signIn(deps, handler);
    deps.setNow(NOW + 61_000);
    deps.setEpoch(new Error("ssm down"));
    const r = await handler(api(session));
    expect(r.statusCode).toBe(503);
    expect(deps.invocations).toHaveLength(0);
    deps.setEpoch(1);
    expect((await handler(api(session))).statusCode).toBe(200);
  });
});

describe("session epoch (preview)", () => {
  it("binds preview sessions to the epoch and revokes them when it changes", async () => {
    const deps = await makeDeps();
    deps.setEpoch(3);
    const handler = createHandler(PREVIEW_ENV, deps);
    const login = await handler(
      makeEvent({ rawPath: "/__flareon/auth/preview", rawQueryString: `token=${PREVIEW_TOKEN}` }),
    );
    const session = cookieValue(login.cookies, SESSION_COOKIE)!;
    expect(verifyPayload(session, SESSION_KEY, NOW)!["se"]).toBe(3);
    expect((await handler(api(session))).statusCode).toBe(200);
    deps.setEpoch(4);
    deps.setNow(NOW + 61_000);
    expect((await handler(api(session))).statusCode).toBe(401);
  });
});

describe("FLAREON_SESSION_EPOCH_PARAM", () => {
  it("is required in both modes", () => {
    expect(parseAuthConfig(COGNITO_ENV).sessionEpochParam).toBe(EPOCH_PARAM);
    const without = (env: Record<string, string>) =>
      Object.fromEntries(Object.entries(env).filter(([k]) => k !== "FLAREON_SESSION_EPOCH_PARAM"));
    const cognito = without(COGNITO_ENV);
    const preview = without(PREVIEW_ENV);
    expect(() => parseAuthConfig(cognito)).toThrow(/FLAREON_SESSION_EPOCH_PARAM/);
    expect(() => parseAuthConfig(preview)).toThrow(/FLAREON_SESSION_EPOCH_PARAM/);
  });
});
