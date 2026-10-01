import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startProxy, type DevProxy } from "../../src/dev/proxy.js";

let upstream: Server | undefined;
let proxy: DevProxy | undefined;

afterEach(async () => {
  await proxy?.close();
  await new Promise((r) => (upstream ? upstream.close(r) : r(undefined)));
  upstream = undefined;
  proxy = undefined;
});

/** 受け取ったリクエストをそのまま JSON で返すアプリ。 */
async function echoApp(port = 0): Promise<number> {
  upstream = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/json", "x-app": "yes" });
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        }),
      );
    });
  });
  await new Promise<void>((r) => upstream!.listen(port, "127.0.0.1", r));
  return (upstream.address() as AddressInfo).port;
}

describe("dev proxy", () => {
  it("forwards method, path, query, body and the app's response", async () => {
    const appPort = await echoApp();
    proxy = await startProxy({ port: 0, targetPort: appPort });
    const r = await fetch(`http://127.0.0.1:${proxy.port}/items?q=1`, {
      method: "PUT",
      body: '{"a":1}',
      headers: { "content-type": "application/json" },
    });
    expect(r.status).toBe(201);
    expect(r.headers.get("x-app")).toBe("yes");
    const j = (await r.json()) as { method: string; url: string; body: string };
    expect(j).toMatchObject({ method: "PUT", url: "/items?q=1", body: '{"a":1}' });
  });

  it("strips client-supplied x-flarelet-* headers (no identity locally by default)", async () => {
    const appPort = await echoApp();
    proxy = await startProxy({ port: 0, targetPort: appPort });
    const r = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      headers: { "x-flarelet-user-email": "evil@example.com", "X-Flarelet-Auth-Mode": "cognito" },
    });
    const j = (await r.json()) as { headers: Record<string, string> };
    expect(Object.keys(j.headers).filter((k) => k.startsWith("x-flarelet-"))).toEqual([]);
  });

  it("adds a simulated identity with --as", async () => {
    const appPort = await echoApp();
    proxy = await startProxy({ port: 0, targetPort: appPort, identity: "alice@example.com" });
    const r = await fetch(`http://127.0.0.1:${proxy.port}/`, {
      headers: { "x-flarelet-user-email": "evil@example.com" },
    });
    const j = (await r.json()) as { headers: Record<string, string> };
    expect(j.headers["x-flarelet-user-email"]).toBe("alice@example.com");
    expect(j.headers["x-flarelet-user-sub"]).toBe("dev:alice@example.com");
    expect(j.headers["x-flarelet-auth-mode"]).toBe("dev");
  });

  it("waits for an app that is (re)starting", async () => {
    const free = await echoApp();
    await new Promise((r) => upstream!.close(r));
    upstream = undefined;
    proxy = await startProxy({ port: 0, targetPort: free, waitMs: 5000 });
    const pending = fetch(`http://127.0.0.1:${proxy.port}/late`);
    await new Promise((r) => setTimeout(r, 300));
    await echoApp(free);
    const r = await pending;
    expect(r.status).toBe(201);
  });

  it("answers 502 when the app does not come up in time", async () => {
    const free = await echoApp();
    await new Promise((r) => upstream!.close(r));
    upstream = undefined;
    proxy = await startProxy({ port: 0, targetPort: free, waitMs: 300 });
    const r = await fetch(`http://127.0.0.1:${proxy.port}/`);
    expect(r.status).toBe(502);
    expect(await r.text()).toMatch(/not responding/);
  });

  it("fails clearly when the port is in use", async () => {
    const busy = await echoApp();
    await expect(startProxy({ port: busy, targetPort: 1 })).rejects.toThrow(
      new RegExp(`port ${busy} is in use.*--port`),
    );
  });
});
