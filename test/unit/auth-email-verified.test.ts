// F1: 未検証の email をアプリが検証済みと誤認しないよう、email_verified をセッションに持ち、
// x-flarelet-user-email-verified としてアプリに渡す。
import { describe, expect, it } from "vitest";
import { FLOW_COOKIE } from "../../src/auth/cognito.js";
import { buildAppEvent } from "../../src/auth/proxy.js";
import { createHandler } from "../../src/auth/router.js";
import { issueSessionCookie, readSession, SESSION_COOKIE } from "../../src/auth/session.js";
import {
  COGNITO_ENV,
  cookieValue,
  makeDeps,
  makeEvent,
  NOW,
  SESSION_KEY,
} from "./auth-fixtures.js";

/** login → callback を通し、発行されたセッションで app に届くヘッダを返す。 */
async function appHeadersAfterSignIn(
  env: Record<string, string>,
  claims: Record<string, unknown>,
): Promise<Record<string, string>> {
  const deps = await makeDeps();
  const handler = createHandler(env, deps);
  const login = await handler(makeEvent({ rawPath: "/__flarelet/auth/login" }));
  const loc = new URL(login.headers!.location!);
  const flow = cookieValue(login.cookies, FLOW_COOKIE)!;
  const idToken = await deps.signIdToken({
    sub: "u1",
    nonce: loc.searchParams.get("nonce"),
    ...claims,
  });
  deps.setFetch(async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 }));
  const cb = await handler(
    makeEvent({
      rawPath: "/__flarelet/auth/callback",
      rawQueryString: `code=C&state=${loc.searchParams.get("state")}`,
      cookies: [`${FLOW_COOKIE}=${flow}`],
    }),
  );
  expect(cb.statusCode).toBe(302);
  const session = cookieValue(cb.cookies, SESSION_COOKIE)!;
  await handler(makeEvent({ rawPath: "/me", cookies: [`${SESSION_COOKIE}=${session}`] }));
  const sent = JSON.parse(deps.invocations.at(-1)!.payload) as {
    headers: Record<string, string>;
  };
  return sent.headers;
}

describe("email_verified reaches the app", () => {
  it.each([
    ["cognito", true, "true"],
    ["cognito", "true", "true"],
    ["cognito", false, "false"],
    ["cognito", "false", "false"],
    ["cognito", undefined, "false"],
    ["oidc", true, "true"],
    ["oidc", undefined, "false"],
    ["google", true, "true"],
    ["google", "false", "false"],
  ] as const)("%s: email_verified=%s → %s", async (provider, claim, header) => {
    const h = await appHeadersAfterSignIn(
      { ...COGNITO_ENV, FLARELET_AUTH_PROVIDER: provider },
      { email: "a@example.com", ...(claim === undefined ? {} : { email_verified: claim }) },
    );
    expect(h["x-flarelet-user-email"]).toBe("a@example.com");
    expect(h["x-flarelet-user-email-verified"]).toBe(header);
  });

  it("entra: Entra ID tokens carry no email_verified, so the email is never marked verified", async () => {
    const h = await appHeadersAfterSignIn(
      { ...COGNITO_ENV, FLARELET_AUTH_PROVIDER: "entra" },
      // Cognito 経由で email_verified が付いていても entra では信用しない
      { email: "a@example.com", email_verified: true },
    );
    expect(h["x-flarelet-user-email"]).toBe("a@example.com");
    expect(h["x-flarelet-user-email-verified"]).toBe("false");
  });

  it("a client cannot forge x-flarelet-user-email-verified", () => {
    const ev = buildAppEvent(
      makeEvent({ headers: { "x-flarelet-user-email-verified": "true" } }),
      { sub: "u1", email: "a@example.com", emailVerified: false },
      "cognito",
    );
    expect(ev.headers["x-flarelet-user-email-verified"]).toBe("false");
  });

  it("identities without an email (preview) are sent as not verified", () => {
    const ev = buildAppEvent(makeEvent(), { sub: "preview" }, "preview");
    expect(ev.headers["x-flarelet-user-email"]).toBeUndefined();
    expect(ev.headers["x-flarelet-user-email-verified"]).toBe("false");
  });
});

describe("session cookie keeps emailVerified", () => {
  it("round-trips emailVerified; older sessions without it read as not verified", () => {
    const yes = issueSessionCookie(
      { sub: "u1", email: "a@b.c", emailVerified: true },
      "cognito",
      SESSION_KEY,
      NOW,
    ).split(";")[0]!;
    expect(readSession(makeEvent({ cookies: [yes] }), SESSION_KEY, "cognito", NOW)).toMatchObject({
      emailVerified: true,
    });
    const old = issueSessionCookie(
      { sub: "u1", email: "a@b.c" },
      "cognito",
      SESSION_KEY,
      NOW,
    ).split(";")[0]!;
    expect(readSession(makeEvent({ cookies: [old] }), SESSION_KEY, "cognito", NOW)).toMatchObject({
      emailVerified: false,
    });
  });
});
