import { describe, expect, it } from "vitest";
import { createHandler } from "../../src/auth/router.js";
import { SESSION_COOKIE, verifyPayload } from "../../src/auth/session.js";
import {
  cookieValue,
  makeDeps,
  makeEvent,
  NOW,
  PREVIEW_ENV,
  PREVIEW_TOKEN,
  SESSION_KEY,
} from "./auth-fixtures.js";

const P = "/__flareon/auth/preview";

describe("preview auth", () => {
  it("正しいトークンの GET でセッション発行し / へ 302", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      PREVIEW_ENV,
      deps,
    )(makeEvent({ rawPath: P, rawQueryString: `token=${PREVIEW_TOKEN}` }));
    expect(res.statusCode).toBe(302);
    expect(res.headers!.location).toBe("/");
    const sess = cookieValue(res.cookies, SESSION_COOKIE)!;
    expect(verifyPayload(sess, SESSION_KEY, NOW)).toMatchObject({
      sub: "preview",
      mode: "preview",
    });
  });
  it("誤ったトークンは 401 でセッション無し", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      PREVIEW_ENV,
      deps,
    )(makeEvent({ rawPath: P, rawQueryString: "token=nope" }));
    expect(res.statusCode).toBe(401);
    expect(cookieValue(res.cookies, SESSION_COOKIE)).toBeUndefined();
  });
  it("長さの違うトークンでも落ちない", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      PREVIEW_ENV,
      deps,
    )(makeEvent({ rawPath: P, rawQueryString: "token=a" }));
    expect(res.statusCode).toBe(401);
  });
  it("token 未指定の GET はフォーム HTML", async () => {
    const deps = await makeDeps();
    const res = await createHandler(PREVIEW_ENV, deps)(makeEvent({ rawPath: P }));
    expect(res.headers!["content-type"]).toContain("text/html");
    expect(res.body).toContain('<form method="post"');
    expect(res.body).toContain('name="token"');
  });
  it("POST (form-urlencoded) で受け付ける", async () => {
    const deps = await makeDeps();
    const h = createHandler(PREVIEW_ENV, deps);
    const ok = await h(
      makeEvent({
        method: "POST",
        rawPath: P,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${PREVIEW_TOKEN}`,
      }),
    );
    expect(ok.statusCode).toBe(302);
    expect(cookieValue(ok.cookies, SESSION_COOKIE)).toBeDefined();
    const b64 = await h(
      makeEvent({
        method: "POST",
        rawPath: P,
        body: Buffer.from(`token=${PREVIEW_TOKEN}`).toString("base64"),
        isBase64Encoded: true,
      }),
    );
    expect(b64.statusCode).toBe(302);
    const bad = await h(makeEvent({ method: "POST", rawPath: P, body: "token=bad" }));
    expect(bad.statusCode).toBe(401);
    expect(bad.body).toContain("<form");
  });
  it("未認証ブラウザにはフォーム、API には 401 JSON", async () => {
    const deps = await makeDeps();
    const h = createHandler(PREVIEW_ENV, deps);
    const br = await h(makeEvent({ rawPath: "/x", headers: { accept: "text/html,*/*" } }));
    expect(br.statusCode).toBe(401);
    expect(br.body).toContain("<form");
    const api = await h(makeEvent({ rawPath: "/x", headers: { accept: "application/json" } }));
    expect(api.statusCode).toBe(401);
    expect(JSON.parse(api.body!)).toEqual({ error: "unauthorized" });
    expect(deps.invocations).toHaveLength(0);
  });
  it("logout でセッション削除し / へ", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      PREVIEW_ENV,
      deps,
    )(makeEvent({ rawPath: "/__flareon/auth/logout" }));
    expect(res.statusCode).toBe(302);
    expect(res.headers!.location).toBe("/");
    expect(res.cookies!.some((c) => c.startsWith(`${SESSION_COOKIE}=;`))).toBe(true);
  });
});
