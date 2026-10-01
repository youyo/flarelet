import { describe, expect, it } from "vitest";
import { handler } from "../../src/auth/handler.js";
import { createHandler } from "../../src/auth/router.js";
import { issueSessionCookie } from "../../src/auth/session.js";
import {
  COGNITO_ENV,
  makeDeps,
  makeEvent,
  NOW,
  PREVIEW_ENV,
  SESSION_KEY,
} from "./auth-fixtures.js";

const sessionCookie = (mode: "cognito" | "preview") =>
  // epoch 1 = テスト用 deps の現在のセッション世代
  issueSessionCookie({ sub: "u1", email: "a@b.c", epoch: 1 }, mode, SESSION_KEY, NOW).split(
    ";",
  )[0]!;

describe("router (cognito)", () => {
  it("未認証ブラウザは login へ 302 (return_to 付き)", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      COGNITO_ENV,
      deps,
    )(makeEvent({ rawPath: "/a/b", rawQueryString: "x=1", headers: { accept: "text/html" } }));
    expect(res.statusCode).toBe(302);
    expect(res.headers!.location).toBe(
      `/__flareon/auth/login?return_to=${encodeURIComponent("/a/b?x=1")}`,
    );
    expect(deps.invocations).toHaveLength(0);
  });
  it("未認証の非ブラウザ（API / POST）は 401 JSON", async () => {
    const deps = await makeDeps();
    const h = createHandler(COGNITO_ENV, deps);
    const a = await h(makeEvent({ headers: { accept: "application/json" } }));
    expect(a.statusCode).toBe(401);
    expect(a.headers!["content-type"]).toContain("application/json");
    const b = await h(makeEvent({ method: "POST", headers: { accept: "text/html" } }));
    expect(b.statusCode).toBe(401);
  });
  it("認証済みは app へ Invoke し応答を返す（x-flareon-* 偽装は無効）", async () => {
    const deps = await makeDeps();
    deps.setInvoke(async () => ({
      payload: JSON.stringify({ statusCode: 200, body: "hi", cookies: ["c=1"] }),
    }));
    const res = await createHandler(
      COGNITO_ENV,
      deps,
    )(
      makeEvent({
        cookies: [sessionCookie("cognito")],
        headers: { "x-flareon-user-sub": "evil" },
      }),
    );
    expect(res).toEqual({ statusCode: 200, body: "hi", cookies: ["c=1"] });
    const sent = JSON.parse(deps.invocations[0]!.payload);
    expect(sent.headers["x-flareon-user-sub"]).toBe("u1");
    expect(sent.headers["x-flareon-auth-mode"]).toBe("cognito");
  });
  it("preview モードのセッションは cognito では無効", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      COGNITO_ENV,
      deps,
    )(makeEvent({ cookies: [sessionCookie("preview")], headers: { accept: "application/json" } }));
    expect(res.statusCode).toBe(401);
  });
  it("未知の /__flareon/auth/* は 404 で app へ流さない", async () => {
    const deps = await makeDeps();
    const res = await createHandler(
      COGNITO_ENV,
      deps,
    )(makeEvent({ rawPath: "/__flareon/auth/unknown", cookies: [sessionCookie("cognito")] }));
    expect(res.statusCode).toBe(404);
    expect(deps.invocations).toHaveLength(0);
  });
  it("secret は取得後キャッシュされる", async () => {
    const deps = await makeDeps();
    const h = createHandler(COGNITO_ENV, deps);
    const ev = makeEvent({ cookies: [sessionCookie("cognito")] });
    await h(ev);
    await h(ev);
    expect(deps.secretCalls.filter((a) => a === "arn:session")).toHaveLength(1);
  });
  it("設定不備は作成時に例外", async () => {
    const deps = await makeDeps();
    expect(() => createHandler({}, deps)).toThrow();
  });
});

describe("router (preview)", () => {
  it("認証済みは app へ Invoke し auth-mode=preview", async () => {
    const deps = await makeDeps();
    await createHandler(PREVIEW_ENV, deps)(makeEvent({ cookies: [sessionCookie("preview")] }));
    const sent = JSON.parse(deps.invocations[0]!.payload);
    expect(sent.headers["x-flareon-auth-mode"]).toBe("preview");
  });
});

describe("handler export", () => {
  it("関数としてエクスポートされている", () => {
    expect(typeof handler).toBe("function");
  });
});
