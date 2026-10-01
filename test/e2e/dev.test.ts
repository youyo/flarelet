// `flareon dev` をビルド済み CLI で実際に起動し、起動画面・ローカルアプリの応答・ホットリロード・停止を検証する。
// FLAREON_OFFLINE=1 なので AWS には接続しない（バインディングは offline 表示）。
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");
const ENV = {
  ...process.env,
  FLAREON_OFFLINE: "1",
  AWS_REGION: "ap-northeast-1",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "invalid",
  AWS_SESSION_TOKEN: "",
  AWS_PROFILE: "",
  AWS_ENDPOINT_URL: "http://127.0.0.1:9",
  AWS_MAX_ATTEMPTS: "1",
};

const appSource = (marker: string) => `import { createServer } from "node:http";
const marker: string = ${JSON.stringify(marker)};
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({
    marker,
    path: req.url,
    version: process.env.FLAREON_VERSION ?? null,
    stage: process.env.FLAREON_STAGE ?? null,
    dev: process.env.FLAREON_DEV ?? null,
    email: req.headers["x-flareon-user-email"] ?? null,
    mode: req.headers["x-flareon-auth-mode"] ?? null,
    host: process.env.HOST ?? null,
    secret: process.env.FLAREON_DEV_SECRET ?? null,
    secretHeader: req.headers["x-flareon-dev-secret"] ?? null,
  }));
}).listen(Number(process.env.PORT), process.env.HOST);
`;

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

interface Running {
  child: ChildProcess;
  out: () => string;
  exited: Promise<number | null>;
}

/** fastapi / uvicorn 入りのテスト用 venv（mise run test:e2e:python-env が作る）。 */
const PY_VENV_BIN = resolve(import.meta.dirname, "../../.flareon/e2e-python/bin");

function startDev(args: string[], cwd: string, env: NodeJS.ProcessEnv = ENV): Running {
  const child = spawn(process.execPath, [CLI, "dev", ...args], { cwd, env });
  let out = "";
  child.stdout!.setEncoding("utf8").on("data", (d: string) => (out += d));
  child.stderr!.setEncoding("utf8").on("data", (d: string) => (out += d));
  const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
  return { child, out: () => out, exited };
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out${last ? `: ${String(last)}` : ""}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** fetch では Host / Origin を自由に付けられないので node:http で送る。 */
function rawGet(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((res, rej) => {
    const req = request({ host: "127.0.0.1", port, path: "/", headers, setHost: false }, (r) => {
      r.resume();
      r.on("end", () => res(r.statusCode ?? 0));
    });
    req.on("error", rej);
    req.end();
  });
}

const getJson = async (url: string, headers: Record<string, string> = {}) =>
  (await (await fetch(url, { headers })).json()) as Record<string, string | null>;

let dir: string;
let running: Running | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flareon-e2e-dev-"));
  await writeFile(
    join(dir, "flareon.yaml"),
    `version: 1
name: devapp
runtime: { language: typescript }
http: true
database: { main: {} }
secrets: [API_KEY]
`,
  );
  await mkdir(join(dir, "app"));
  await writeFile(join(dir, "app", "index.ts"), appSource("v1"));
});
afterEach(async () => {
  if (running && running.child.exitCode === null) {
    running.child.kill("SIGKILL");
    await running.exited;
  }
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe("flareon dev (offline)", () => {
  it("shows the startup screen, serves the app, reloads on change and stops cleanly", async () => {
    const port = await freePort();
    running = startDev(["--port", String(port)], dir);
    const r = running;
    await until(() => (r.out().includes("Watching...") ? true : undefined));

    const screen = r.out();
    expect(screen).toContain("Flareon dev");
    expect(screen).toMatch(/App\s+devapp/);
    expect(screen).toMatch(/Stage\s+preview/);
    expect(screen).toMatch(/Version\s+local-[a-z0-9-]+/);
    expect(screen).toMatch(/Runtime\s+typescript 24/);
    expect(screen).toContain(`URL       http://localhost:${port}`);
    expect(screen).toMatch(/database\.main\s+offline/);
    expect(screen).toMatch(/secrets\.API_KEY\s+offline/);
    const version = /Version\s+(local-[a-z0-9-]+)/.exec(screen)![1]!;

    const url = `http://localhost:${port}`;
    const first = await until(() => getJson(`${url}/hello?x=1`));
    expect(first).toMatchObject({
      marker: "v1",
      path: "/hello?x=1",
      version,
      stage: "preview",
      dev: "1",
    });

    // 本番の front と同様、クライアント由来の identity ヘッダは届かない
    const spoofed = await getJson(url, { "x-flareon-user-email": "evil@example.com" });
    expect(spoofed.email).toBeNull();

    await writeFile(join(dir, "app", "index.ts"), appSource("v2"));
    const reloaded = await until(async () => {
      const j = await getJson(url);
      return j.marker === "v2" ? j : undefined;
    });
    expect(reloaded.marker).toBe("v2");
    expect(r.out()).toMatch(/Change detected \(index\.ts\), restarting/);

    r.child.kill("SIGINT");
    expect(await r.exited).toBe(0);
    expect(r.out()).toContain("Stopped.");
    await expect(fetch(url)).rejects.toThrow();
  }, 60_000);

  it("--as simulates a signed-in user", async () => {
    const port = await freePort();
    running = startDev(["--port", String(port), "--as", "alice@example.com"], dir);
    const r = running;
    await until(() => (r.out().includes("Watching...") ? true : undefined));
    expect(r.out()).toMatch(/Identity\s+alice@example\.com/);
    const j = await until(() => getJson(`http://localhost:${port}/`));
    expect(j).toMatchObject({ email: "alice@example.com", mode: "dev" });
  }, 60_000);

  it("binds the app to loopback and vouches for the proxy with a per-session secret", async () => {
    const port = await freePort();
    running = startDev(["--port", String(port), "--as", "alice@example.com"], dir);
    const r = running;
    await until(() => (r.out().includes("Watching...") ? true : undefined));
    const j = await until(() => getJson(`http://localhost:${port}/`));
    // TypeScript アプリには HOST=127.0.0.1 を渡す（全インターフェースで listen させない）
    expect(j.host).toBe("127.0.0.1");
    // プロキシ経由のリクエストにだけ、アプリの FLAREON_DEV_SECRET と同じ秘密ヘッダが付く
    expect(j.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(j.secretHeader).toBe(j.secret);
    expect(r.out()).not.toContain(j.secret!);
  }, 60_000);

  it("refuses requests whose Host is not loopback (DNS rebinding)", async () => {
    const port = await freePort();
    running = startDev(["--port", String(port)], dir);
    const r = running;
    await until(() => (r.out().includes("Watching...") ? true : undefined));
    await until(() => getJson(`http://localhost:${port}/`));
    expect(await rawGet(port, { host: "attacker.example.com" })).toBe(403);
    expect(await rawGet(port, { host: `attacker.example.com:${port}` })).toBe(403);
    expect(await rawGet(port, { host: `localhost:${port}` })).toBe(200);
  }, 60_000);

  it("--as refuses cross-site requests (CSRF)", async () => {
    const port = await freePort();
    running = startDev(["--port", String(port), "--as", "alice@example.com"], dir);
    const r = running;
    await until(() => (r.out().includes("Watching...") ? true : undefined));
    await until(() => getJson(`http://localhost:${port}/`));
    const host = `localhost:${port}`;
    expect(await rawGet(port, { host, origin: "https://attacker.example.com" })).toBe(403);
    expect(await rawGet(port, { host, "sec-fetch-site": "cross-site" })).toBe(403);
    expect(await rawGet(port, { host, origin: `http://${host}` })).toBe(200);
  }, 60_000);

  it("keeps running and recovers after a build error", async () => {
    const port = await freePort();
    running = startDev(["--port", String(port)], dir);
    const r = running;
    await until(() => (r.out().includes("Watching...") ? true : undefined));
    await writeFile(join(dir, "app", "index.ts"), "import { nope } from './missing';\nnope();\n");
    await until(() => (/failed to build/.test(r.out()) ? true : undefined));
    expect(r.child.exitCode).toBeNull();
    await writeFile(join(dir, "app", "index.ts"), appSource("v3"));
    const j = await until(async () => {
      const x = await getJson(`http://localhost:${port}/`);
      return x.marker === "v3" ? x : undefined;
    });
    expect(j.marker).toBe("v3");
  }, 60_000);

  it("fails clearly when the port is taken", async () => {
    const blocker = createServer();
    const port = await new Promise<number>((res) =>
      blocker.listen(0, "127.0.0.1", () => res((blocker.address() as { port: number }).port)),
    );
    try {
      running = startDev(["--port", String(port)], dir);
      expect(await running.exited).toBe(1);
      expect(running.out()).toMatch(new RegExp(`port ${port} is in use`));
    } finally {
      blocker.close();
    }
  }, 60_000);

  it("--stage without --version is rejected", async () => {
    running = startDev(["--stage", "prod"], dir);
    expect(await running.exited).toBe(1);
    expect(running.out()).toMatch(/--stage and --version/);
  });

  it("is listed in --help", async () => {
    const r = startDev(["--help"], dir);
    expect(await r.exited).toBe(0);
    for (const o of ["--port", "--stage", "--version", "--as"]) expect(r.out()).toContain(o);
  });
});

const pythonSource = (marker: string) => `import os

from fastapi import FastAPI, Request

app = FastAPI()
MARKER = ${JSON.stringify(marker)}


@app.get("/{path:path}")
def handle(path: str, request: Request):
    return {
        "marker": MARKER,
        "path": "/" + path,
        "stage": os.environ.get("FLAREON_STAGE"),
        "dev": os.environ.get("FLAREON_DEV"),
        "email": request.headers.get("x-flareon-user-email"),
    }
`;

describe("flareon dev (offline, python)", () => {
  it("runs a FastAPI app with uvicorn and restarts it when a file changes", async () => {
    expect(
      existsSync(join(PY_VENV_BIN, "python")),
      "python venv missing; run `mise run test:e2e:python-env`",
    ).toBe(true);
    await writeFile(
      join(dir, "flareon.yaml"),
      "version: 1\nname: devpy\nruntime: { language: python }\nhttp: true\n",
    );
    await rm(join(dir, "app"), { recursive: true, force: true });
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app", "main.py"), pythonSource("py1"));
    await writeFile(join(dir, "app", "requirements.txt"), "fastapi\nuvicorn\n");

    const port = await freePort();
    const env = { ...ENV, PATH: `${PY_VENV_BIN}${delimiter}${process.env.PATH ?? ""}` };
    running = startDev(["--port", String(port), "--as", "bob@example.com"], dir, env);
    const r = running;
    await until(() => (r.out().includes("Watching...") ? true : undefined));
    expect(r.out()).toMatch(/Runtime\s+python 3\.13/);

    const url = `http://localhost:${port}`;
    const first = await until(() => getJson(`${url}/hello`));
    expect(first).toMatchObject({
      marker: "py1",
      path: "/hello",
      stage: "preview",
      dev: "1",
      email: "bob@example.com",
    });

    await writeFile(join(dir, "app", "main.py"), pythonSource("py2"));
    const reloaded = await until(async () => {
      const j = await getJson(url);
      return j.marker === "py2" ? j : undefined;
    });
    expect(reloaded.marker).toBe("py2");
    expect(r.out()).toMatch(/Change detected \(main\.py\), restarting/);

    // 起動後に変更が無ければ再起動しない（__pycache__ 等の無視パスの書き込みで再起動ループにならない）
    const restarts = (r.out().match(/restarting/g) ?? []).length;
    await new Promise((res) => setTimeout(res, 1000));
    expect((r.out().match(/restarting/g) ?? []).length).toBe(restarts);

    r.child.kill("SIGINT");
    expect(await r.exited).toBe(0);
    await expect(fetch(url)).rejects.toThrow();
  }, 60_000);
});
