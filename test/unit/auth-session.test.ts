import { describe, expect, it } from "vitest";
import { parseAuthConfig } from "../../src/auth/config.js";
import {
  clearSessionCookie,
  issueSessionCookie,
  parseCookies,
  readSession,
  SESSION_COOKIE,
  signPayload,
  verifyPayload,
} from "../../src/auth/session.js";
import { COGNITO_ENV, makeEvent, NOW, PREVIEW_ENV, SESSION_KEY } from "./auth-fixtures.js";

describe("parseAuthConfig", () => {
  it("cognito 設定をパースする", () => {
    const c = parseAuthConfig(COGNITO_ENV);
    expect(c.mode).toBe("cognito");
    if (c.mode === "cognito") {
      expect(c.cognito.clientId).toBe("client123");
      expect(c.cognito.domain).toBe(COGNITO_ENV.FLAREON_COGNITO_DOMAIN);
    }
    expect(c.appFunctionName).toBe("app-fn");
  });
  it("preview 設定をパースする", () => {
    const c = parseAuthConfig(PREVIEW_ENV);
    expect(c.mode).toBe("preview");
    if (c.mode === "preview") expect(c.previewTokenSecretArn).toBe("arn:preview");
  });
  it("末尾スラッシュの cognito domain を正規化する", () => {
    const c = parseAuthConfig({
      ...COGNITO_ENV,
      FLAREON_COGNITO_DOMAIN: "https://x.auth.y.amazoncognito.com/",
    });
    if (c.mode === "cognito") expect(c.cognito.domain).toBe("https://x.auth.y.amazoncognito.com");
  });
  it("必須が欠けるとエラー", () => {
    expect(() => parseAuthConfig({})).toThrow(/FLAREON_AUTH_MODE/);
    expect(() => parseAuthConfig({ ...COGNITO_ENV, FLAREON_COGNITO_CLIENT_ID: undefined })).toThrow(
      /FLAREON_COGNITO_CLIENT_ID/,
    );
    expect(() =>
      parseAuthConfig({ ...PREVIEW_ENV, FLAREON_PREVIEW_TOKEN_SECRET_ARN: undefined }),
    ).toThrow(/FLAREON_PREVIEW_TOKEN_SECRET_ARN/);
    expect(() => parseAuthConfig({ ...PREVIEW_ENV, FLAREON_AUTH_MODE: "x" })).toThrow(
      /FLAREON_AUTH_MODE/,
    );
  });
});

describe("signPayload / verifyPayload", () => {
  it("署名して検証できる", () => {
    const t = signPayload({ a: 1, exp: NOW / 1000 + 10 }, SESSION_KEY);
    expect(verifyPayload(t, SESSION_KEY, NOW)).toMatchObject({ a: 1 });
  });
  it("改ざん・別鍵・期限切れ・不正形式は undefined", () => {
    const t = signPayload({ a: 1, exp: NOW / 1000 + 10 }, SESSION_KEY);
    const [p, s] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ a: 2, exp: NOW / 1000 + 10 })).toString(
      "base64url",
    );
    expect(verifyPayload(`${forged}.${s}`, SESSION_KEY, NOW)).toBeUndefined();
    expect(verifyPayload(`${p}.x${s}`, SESSION_KEY, NOW)).toBeUndefined();
    expect(verifyPayload(t, "other", NOW)).toBeUndefined();
    expect(verifyPayload(t, SESSION_KEY, NOW + 11_000)).toBeUndefined();
    expect(verifyPayload("garbage", SESSION_KEY, NOW)).toBeUndefined();
    expect(verifyPayload("", SESSION_KEY, NOW)).toBeUndefined();
  });
});

describe("session cookie", () => {
  it("属性付きの Set-Cookie を発行する", () => {
    const c = issueSessionCookie({ sub: "u1", email: "a@b.c" }, "cognito", SESSION_KEY, NOW);
    expect(c.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    // __Host- プレフィックス: Secure・Path=/・Domain なしをブラウザに強制させる（サブドメイン等からの上書きを防ぐ）
    expect(SESSION_COOKIE).toBe("__Host-flareon_session");
    expect(c).not.toMatch(/Domain=/i);
    expect(c).toMatch(/; Path=\/(;|$)/);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("Secure");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toContain("Max-Age=28800");
  });
  it("cookies 配列から読み出せる", () => {
    const c = issueSessionCookie({ sub: "u1", email: "a@b.c" }, "cognito", SESSION_KEY, NOW);
    const value = c.split(";")[0]!;
    const ev = makeEvent({ cookies: ["x=1", value] });
    expect(readSession(ev, SESSION_KEY, "cognito", NOW)).toEqual({
      sub: "u1",
      email: "a@b.c",
      emailVerified: false,
    });
  });
  it("cookie ヘッダからも読み出せる", () => {
    const c = issueSessionCookie({ sub: "u1" }, "preview", SESSION_KEY, NOW);
    const ev = makeEvent({ headers: { cookie: `a=b; ${c.split(";")[0]}` } });
    expect(parseCookies(ev)[SESSION_COOKIE]).toBeDefined();
    expect(readSession(ev, SESSION_KEY, "preview", NOW)).toEqual({
      sub: "u1",
      emailVerified: false,
    });
  });
  it("期限切れ・モード不一致・Cookie なしは未認証", () => {
    const c = issueSessionCookie({ sub: "u1" }, "cognito", SESSION_KEY, NOW);
    const ev = makeEvent({ cookies: [c.split(";")[0]!] });
    expect(readSession(ev, SESSION_KEY, "cognito", NOW + 8 * 3600 * 1000 + 1000)).toBeUndefined();
    expect(readSession(ev, SESSION_KEY, "preview", NOW)).toBeUndefined();
    expect(readSession(makeEvent(), SESSION_KEY, "cognito", NOW)).toBeUndefined();
  });
  it("別用途（flow）の署名値はセッションとして受理しない", () => {
    const t = signPayload(
      { t: "flow", sub: "evil", mode: "cognito", exp: NOW / 1000 + 100 },
      SESSION_KEY,
    );
    const ev = makeEvent({ cookies: [`${SESSION_COOKIE}=${t}`] });
    expect(readSession(ev, SESSION_KEY, "cognito", NOW)).toBeUndefined();
  });
  it("削除 Cookie", () => {
    const c = clearSessionCookie();
    expect(c).toContain(`${SESSION_COOKIE}=;`);
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Secure");
    expect(c).toMatch(/; Path=\/(;|$)/);
    expect(c).toContain("HttpOnly");
  });
});
