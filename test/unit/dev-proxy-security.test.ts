// flareon dev のプロキシの防御: Host 検証（DNS rebinding, F3）、--as 時のクロスサイト拒否（F5）、
// セッションごとの秘密ヘッダ（F2 の多層防御）。
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startProxy, type DevProxy } from "../../src/dev/proxy.js";

let upstream: Server | undefined;
let proxy: DevProxy | undefined;
let hits = 0;

afterEach(async () => {
  await proxy?.close();
  await new Promise((r) => (upstream ? upstream.close(r) : r(undefined)));
  upstream = undefined;
  proxy = undefined;
  hits = 0;
});

async function echoApp(): Promise<number> {
  upstream = createServer((req: IncomingMessage, res) => {
    hits++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ headers: req.headers }));
  });
  await new Promise<void>((r) => upstream!.listen(0, "127.0.0.1", r));
  return (upstream.address() as AddressInfo).port;
}

/** fetch は Host を差し替えられないので node:http で送る。 */
function send(
  port: number,
  headers: Record<string, string>,
  method = "GET",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", method, headers, setHost: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8").on("data", (d: string) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("dev proxy: Host header (DNS rebinding)", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "LOCALHOST"])(
    "accepts %s with its port",
    async (h) => {
      proxy = await startProxy({ port: 0, targetPort: await echoApp() });
      const r = await send(proxy.port, { host: `${h}:${proxy.port}` });
      expect(r.status).toBe(200);
    },
  );

  it("accepts loopback hosts without a port", async () => {
    proxy = await startProxy({ port: 0, targetPort: await echoApp() });
    expect((await send(proxy.port, { host: "localhost" })).status).toBe(200);
  });

  it.each([
    "evil.example.com",
    "evil.example.com:8787",
    "localhost.evil.com",
    "127.0.0.1.nip.io",
    "10.0.0.5:8787",
    "localhost:80@evil.com",
  ])("refuses %s with 403 without reaching the app", async (h) => {
    proxy = await startProxy({ port: 0, targetPort: await echoApp() });
    const r = await send(proxy.port, { host: h });
    expect(r.status).toBe(403);
    expect(hits).toBe(0);
  });

  it("refuses requests without a Host header", async () => {
    proxy = await startProxy({ port: 0, targetPort: await echoApp() });
    const r = await send(proxy.port, {});
    // HTTP/1.1 で Host が無いと Node の http サーバー自身が 400 で拒否する（requireHostHeader）。
    // どちらでもアプリには届かないこと
    expect([400, 403]).toContain(r.status);
    expect(hits).toBe(0);
  });
});

describe("dev proxy: cross-site requests with --as (CSRF)", () => {
  const start = async () => {
    proxy = await startProxy({
      port: 0,
      targetPort: await echoApp(),
      identity: "alice@example.com",
    });
    return proxy.port;
  };

  it("refuses a foreign Origin", async () => {
    const port = await start();
    const r = await send(
      port,
      { host: `localhost:${port}`, origin: "https://evil.example.com" },
      "POST",
    );
    expect(r.status).toBe(403);
    expect(hits).toBe(0);
  });

  it("refuses another local origin (different port) and Origin: null", async () => {
    const port = await start();
    for (const origin of [`http://localhost:${port + 1}`, "null", `https://localhost:${port}`]) {
      const r = await send(port, { host: `localhost:${port}`, origin }, "POST");
      expect(r.status, origin).toBe(403);
    }
    expect(hits).toBe(0);
  });

  it("refuses Sec-Fetch-Site: cross-site even without Origin", async () => {
    const port = await start();
    const r = await send(port, { host: `localhost:${port}`, "sec-fetch-site": "cross-site" });
    expect(r.status).toBe(403);
    expect(hits).toBe(0);
  });

  it("allows same-origin, typed-in and non-browser requests", async () => {
    const port = await start();
    const ok = [
      { host: `localhost:${port}`, origin: `http://localhost:${port}` },
      {
        host: `127.0.0.1:${port}`,
        origin: `http://127.0.0.1:${port}`,
        "sec-fetch-site": "same-origin",
      },
      { host: `localhost:${port}`, "sec-fetch-site": "none" },
      { host: `localhost:${port}` },
    ];
    for (const h of ok) expect((await send(port, h, "POST")).status, JSON.stringify(h)).toBe(200);
  });

  it("without --as, cross-site requests are forwarded (there is no identity to abuse)", async () => {
    proxy = await startProxy({ port: 0, targetPort: await echoApp() });
    const r = await send(proxy.port, {
      host: `localhost:${proxy.port}`,
      origin: "https://evil.example.com",
    });
    expect(r.status).toBe(200);
  });
});

describe("dev proxy: per-session secret header", () => {
  it("adds x-flareon-dev-secret to forwarded requests and drops a client-supplied one", async () => {
    proxy = await startProxy({ port: 0, targetPort: await echoApp(), secret: "abc123" });
    const r = await send(proxy.port, {
      host: `localhost:${proxy.port}`,
      "x-flareon-dev-secret": "forged",
    });
    const j = JSON.parse(r.body) as { headers: Record<string, string> };
    expect(j.headers["x-flareon-dev-secret"]).toBe("abc123");
  });

  it("--as marks the simulated email as verified", async () => {
    proxy = await startProxy({
      port: 0,
      targetPort: await echoApp(),
      identity: "alice@example.com",
      secret: "abc123",
    });
    const r = await send(proxy.port, { host: `localhost:${proxy.port}` });
    const j = JSON.parse(r.body) as { headers: Record<string, string> };
    expect(j.headers["x-flareon-user-email-verified"]).toBe("true");
    expect(j.headers["x-flareon-dev-secret"]).toBe("abc123");
  });
});
