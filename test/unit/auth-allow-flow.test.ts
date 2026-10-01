// allow ポリシー付きの cognito モード: callback で拒否（403 HTML、セッションなし）、ポリシー変更で既存セッションを無効化。
import { describe, expect, it } from "vitest";
import { FLOW_COOKIE } from "../../src/auth/cognito.js";
import { createHandler } from "../../src/auth/router.js";
import { issueSessionCookie, SESSION_COOKIE, verifyPayload } from "../../src/auth/session.js";
import {
  COGNITO_ENV,
  cookieValue,
  makeDeps,
  makeEvent,
  NOW,
  SESSION_KEY,
} from "./auth-fixtures.js";

const ALLOW_ENV = {
  ...COGNITO_ENV,
  FLAREON_AUTH_PROVIDER: "google",
  FLAREON_AUTH_ALLOW_DOMAINS: "example.com",
};

async function signInWith(env: Record<string, string>, claims: Record<string, unknown>) {
  const deps = await makeDeps();
  const handler = createHandler(env, deps);
  const login = await handler(
    makeEvent({ rawPath: "/__flareon/auth/login", rawQueryString: "return_to=%2Fdash" }),
  );
  const loc = new URL(login.headers!.location!);
  const flow = cookieValue(login.cookies, FLOW_COOKIE)!;
  const idToken = await deps.signIdToken({
    sub: "u1",
    nonce: loc.searchParams.get("nonce"),
    ...claims,
  });
  deps.setFetch(async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }));
  const res = await handler(
    makeEvent({
      rawPath: "/__flareon/auth/callback",
      rawQueryString: `code=C&state=${loc.searchParams.get("state")}`,
      cookies: [`${FLOW_COOKIE}=${flow}`],
    }),
  );
  return { res, handler, deps };
}

describe("allow policy at sign-in", () => {
  it("denies users outside the policy with a 403 page and no session", async () => {
    const { res, deps } = await signInWith(ALLOW_ENV, {
      email: "mallory@example.com",
      email_verified: true,
    });
    expect(res.statusCode).toBe(403);
    expect(res.headers!["content-type"]).toContain("text/html");
    expect(res.body).toContain("mallory@example.com");
    expect(res.body).toContain('href="/__flareon/auth/logout"');
    expect(cookieValue(res.cookies, SESSION_COOKIE)).toBeUndefined();
    expect(res.cookies!.some((c) => c.startsWith(`${FLOW_COOKIE}=;`))).toBe(true);
    expect(deps.invocations).toHaveLength(0);
  });

  it("escapes the email shown on the 403 page", async () => {
    const { res } = await signInWith(ALLOW_ENV, { email: "<script>@x.com", email_verified: true });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("<script>");
  });

  it("signs in users inside the policy and binds the session to it", async () => {
    const { res } = await signInWith(ALLOW_ENV, {
      email: "alice@example.com",
      email_verified: true,
      "custom:hd": "example.com",
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers!.location).toBe("/dash");
    const sess = verifyPayload(cookieValue(res.cookies, SESSION_COOKIE)!, SESSION_KEY, NOW)!;
    expect(sess["ap"]).toEqual(expect.any(String));
  });

  it("sessions from before the policy (or another policy) are not accepted", async () => {
    const deps = await makeDeps();
    const handler = createHandler(ALLOW_ENV, deps);
    const old = issueSessionCookie(
      { sub: "u1", email: "x@gmail.com" },
      "cognito",
      SESSION_KEY,
      NOW,
    ).split(";")[0]!;
    const api = await handler(makeEvent({ headers: { cookie: old, accept: "application/json" } }));
    expect(api.statusCode).toBe(401);
    const nav = await handler(makeEvent({ headers: { cookie: old, accept: "text/html" } }));
    expect(nav.statusCode).toBe(302);
    expect(nav.headers!.location).toContain("/__flareon/auth/login");
    expect(deps.invocations).toHaveLength(0);
  });

  it("a session issued under the current policy reaches the app", async () => {
    const { res, handler, deps } = await signInWith(ALLOW_ENV, {
      email: "alice@example.com",
      email_verified: true,
      "custom:hd": "example.com",
    });
    const cookie = `${SESSION_COOKIE}=${cookieValue(res.cookies, SESSION_COOKIE)}`;
    const r = await handler(makeEvent({ headers: { cookie, accept: "application/json" } }));
    expect(r.statusCode).toBe(200);
    expect(deps.invocations).toHaveLength(1);
  });

  it("without a policy, existing sessions keep working", async () => {
    const deps = await makeDeps();
    const handler = createHandler(COGNITO_ENV, deps);
    const old = issueSessionCookie({ sub: "u1" }, "cognito", SESSION_KEY, NOW).split(";")[0]!;
    expect((await handler(makeEvent({ headers: { cookie: old } }))).statusCode).toBe(200);
  });
});
