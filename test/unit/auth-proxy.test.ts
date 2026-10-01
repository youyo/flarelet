import { describe, expect, it } from "vitest";
import { invokeApp } from "../../src/auth/proxy.js";
import { SESSION_COOKIE } from "../../src/auth/session.js";
import { makeDeps, makeEvent } from "./auth-fixtures.js";

const ident = { sub: "u1", email: "a@b.c" };

describe("invokeApp", () => {
  it("x-flareon-* を除去して identity ヘッダを付与し、応答をそのまま返す", async () => {
    const deps = await makeDeps();
    const res = {
      statusCode: 201,
      headers: { "content-type": "application/octet-stream" },
      cookies: ["a=1", "b=2"],
      body: "AAEC",
      isBase64Encoded: true,
    };
    deps.setInvoke(async () => ({ payload: JSON.stringify(res) }));
    const ev = makeEvent({
      rawPath: "/x",
      headers: { host: "h", "x-flareon-user-sub": "evil", "X-Flareon-Foo": "1", "x-other": "k" },
    });
    const out = await invokeApp(ev, ident, "cognito", { appFunctionName: "app-fn", deps });
    expect(out).toEqual(res);
    expect(deps.invocations).toHaveLength(1);
    const inv = deps.invocations[0]!;
    expect(inv.functionName).toBe("app-fn");
    const sent = JSON.parse(inv.payload);
    expect(sent.headers["x-flareon-user-sub"]).toBe("u1");
    expect(sent.headers["x-flareon-user-email"]).toBe("a@b.c");
    expect(sent.headers["x-flareon-auth-mode"]).toBe("cognito");
    expect(sent.headers["x-other"]).toBe("k");
    expect(
      Object.keys(sent.headers).filter((k: string) => k.toLowerCase() === "x-flareon-foo"),
    ).toEqual([]);
    expect(sent.rawPath).toBe("/x");
  });
  it("email が無ければ空文字ではなくヘッダを付けない", async () => {
    const deps = await makeDeps();
    await invokeApp(makeEvent(), { sub: "preview" }, "preview", { appFunctionName: "f", deps });
    const sent = JSON.parse(deps.invocations[0]!.payload);
    expect(sent.headers["x-flareon-user-sub"]).toBe("preview");
    expect(sent.headers["x-flareon-user-email"]).toBeUndefined();
    expect(sent.headers["x-flareon-auth-mode"]).toBe("preview");
  });
  it("セッション Cookie は app に渡さない", async () => {
    const deps = await makeDeps();
    const ev = makeEvent({
      cookies: [`${SESSION_COOKIE}=abc`, "keep=1"],
      headers: { cookie: `${SESSION_COOKIE}=abc; keep=1` },
    });
    await invokeApp(ev, ident, "cognito", { appFunctionName: "f", deps });
    const sent = JSON.parse(deps.invocations[0]!.payload);
    expect(sent.cookies).toEqual(["keep=1"]);
    expect(sent.headers.cookie).toBe("keep=1");
  });
  it("FunctionError は 502", async () => {
    const deps = await makeDeps();
    deps.setInvoke(async () => ({
      functionError: "Unhandled",
      payload: '{"errorMessage":"boom"}',
    }));
    const out = await invokeApp(makeEvent(), ident, "cognito", { appFunctionName: "f", deps });
    expect(out.statusCode).toBe(502);
  });
  it("Task timed out は 504", async () => {
    const deps = await makeDeps();
    deps.setInvoke(async () => ({
      functionError: "Unhandled",
      payload: '{"errorMessage":"2026 Task timed out after 10.00 seconds"}',
    }));
    const out = await invokeApp(makeEvent(), ident, "cognito", { appFunctionName: "f", deps });
    expect(out.statusCode).toBe(504);
  });
  it("Invoke の例外: タイムアウト系は 504、その他は 502", async () => {
    const deps = await makeDeps();
    deps.setInvoke(async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    });
    expect(
      (await invokeApp(makeEvent(), ident, "cognito", { appFunctionName: "f", deps })).statusCode,
    ).toBe(504);
    deps.setInvoke(async () => {
      throw Object.assign(new Error("t"), { name: "RequestTimeout" });
    });
    expect(
      (await invokeApp(makeEvent(), ident, "cognito", { appFunctionName: "f", deps })).statusCode,
    ).toBe(504);
    deps.setInvoke(async () => {
      throw new Error("AccessDenied");
    });
    expect(
      (await invokeApp(makeEvent(), ident, "cognito", { appFunctionName: "f", deps })).statusCode,
    ).toBe(502);
  });
  it("app の応答が v2 形式でなければ 502", async () => {
    const deps = await makeDeps();
    deps.setInvoke(async () => ({ payload: "not json" }));
    expect(
      (await invokeApp(makeEvent(), ident, "cognito", { appFunctionName: "f", deps })).statusCode,
    ).toBe(502);
    deps.setInvoke(async () => ({ payload: '{"foo":1}' }));
    expect(
      (await invokeApp(makeEvent(), ident, "cognito", { appFunctionName: "f", deps })).statusCode,
    ).toBe(502);
  });
});
