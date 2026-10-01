import { describe, expect, it } from "vitest";
import { githubApi } from "../../src/github/api.js";

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | null;
}

function fakeFetch(responder: (c: Call) => { status?: number; json?: unknown }) {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const c: Call = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    };
    calls.push(c);
    const r = responder(c);
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), {
      status: r.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, calls };
}

describe("githubApi", () => {
  it("creates and updates comments with the bearer token", async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, json: {} }));
    const api = githubApi({ token: "tok", fetch: f });
    await api.createComment("o/r", 5, "hi");
    await api.updateComment("o/r", 9, "yo");
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.github.com/repos/o/r/issues/5/comments",
      body: { body: "hi" },
      auth: "Bearer tok",
    });
    expect(calls[1]).toMatchObject({
      method: "PATCH",
      url: "https://api.github.com/repos/o/r/issues/comments/9",
      body: { body: "yo" },
    });
  });

  it("lists comments across pages", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.url.endsWith("&page=1")
        ? {
            json: Array.from({ length: 100 }, (_, i) => ({
              id: i,
              body: "b",
              user: { type: "User" },
            })),
          }
        : { json: [{ id: 500, body: "m", user: { type: "Bot" } }] },
    );
    const api = githubApi({ token: "t", fetch: f });
    const list = await api.listComments("o/r", 5);
    expect(list).toHaveLength(101);
    expect(list.at(-1)).toEqual({ id: 500, body: "m", userType: "Bot" });
    expect(calls).toHaveLength(2);
  });

  it("creates a deployment and its status", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.url.endsWith("/deployments")
        ? { status: 201, json: { id: 77 } }
        : { status: 201, json: {} },
    );
    const api = githubApi({ token: "t", apiUrl: "https://ghe.example/api/v3", fetch: f });
    const id = await api.createDeployment("o/r", {
      ref: "abc",
      environment: "app/preview/pr-1",
      description: "d",
      transient: true,
      production: false,
    });
    expect(id).toBe(77);
    await api.createDeploymentStatus("o/r", 77, {
      state: "success",
      environmentUrl: "https://x",
      logUrl: "https://log",
    });
    expect(calls[0]).toMatchObject({
      url: "https://ghe.example/api/v3/repos/o/r/deployments",
      body: {
        ref: "abc",
        environment: "app/preview/pr-1",
        auto_merge: false,
        required_contexts: [],
        transient_environment: true,
        production_environment: false,
      },
    });
    expect(calls[1]).toMatchObject({
      url: "https://ghe.example/api/v3/repos/o/r/deployments/77/statuses",
      body: {
        state: "success",
        environment_url: "https://x",
        log_url: "https://log",
        auto_inactive: true,
      },
    });
  });

  it("reads repository visibility and lists deployments by environment", async () => {
    const { f, calls } = fakeFetch((c) =>
      c.url.includes("/deployments")
        ? { json: [{ id: 1 }, { id: 2 }] }
        : { json: { private: true } },
    );
    const api = githubApi({ token: "t", fetch: f });
    expect(await api.getRepo("o/r")).toEqual({ private: true });
    expect(await api.listDeployments("o/r", "a b/c")).toEqual([1, 2]);
    expect(calls[1]!.url).toContain("environment=a%20b%2Fc");
  });

  it("reports API errors without leaking the token", async () => {
    const { f } = fakeFetch(() => ({ status: 403, json: { message: "Resource not accessible" } }));
    const api = githubApi({ token: "sekret", fetch: f });
    const e = await api.createComment("o/r", 1, "x").catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/403.*Resource not accessible/);
    expect((e as Error).message).not.toContain("sekret");
  });
});
