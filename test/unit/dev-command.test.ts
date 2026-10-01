import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEnv, devCommand, newDevSecret } from "../../src/dev/session.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flarelet-devcmd-"));
  await mkdir(join(dir, "app"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("devCommand: python", () => {
  it("runs uvicorn on main:app from app/ with the PATH python", async () => {
    await writeFile(join(dir, "app", "main.py"), "app = None\n");
    const c = await devCommand("python", dir, 4567, {
      which: (n) => (n === "python" ? "/x/python" : undefined),
    });
    expect(c).toEqual({
      cmd: "/x/python",
      args: ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", "4567"],
      cwd: join(dir, "app"),
      // .pyc を書かせない。.pyc の検証は mtime（秒）+ サイズなので、同じ秒に同じサイズで書き換えると
      // 古いバイトコードが使われ、再起動しても変更が反映されない
      env: { PYTHONDONTWRITEBYTECODE: "1" },
    });
  });

  it("falls back to python3", async () => {
    await writeFile(join(dir, "app", "main.py"), "app = None\n");
    const c = await devCommand("python", dir, 1, {
      which: (n) => (n === "python3" ? "/x/python3" : undefined),
    });
    expect(c.cmd).toBe("/x/python3");
  });

  it("explains a missing interpreter or main.py", async () => {
    await expect(devCommand("python", dir, 1, { which: () => "/x/python" })).rejects.toThrow(
      /main\.py not found/,
    );
    await writeFile(join(dir, "app", "main.py"), "app = None\n");
    await expect(devCommand("python", dir, 1, { which: () => undefined })).rejects.toThrow(
      /python.*not found on PATH/,
    );
  });
});

describe("devCommand: typescript", () => {
  it("bundles app/index.ts (with its imports) and runs it with this Node", async () => {
    await writeFile(
      join(dir, "app", "util.ts"),
      "export const greet = (n: string): string => `hi ${n}`;\n",
    );
    await writeFile(
      join(dir, "app", "index.ts"),
      'import { greet } from "./util";\nconst x: number = 1;\nconsole.log(greet("dev"), x, process.env.PORT);\n',
    );
    const c = await devCommand("typescript", dir, 4321, { which: () => undefined });
    expect(c.cmd).toBe(process.execPath);
    expect(c.cwd).toBe(join(dir, "app"));
    expect(c.args).toEqual([join(dir, ".flarelet", "dev", "app", "index.mjs")]);
    const out = await new Promise<string>((res, rej) =>
      execFile(c.cmd, c.args, { cwd: c.cwd, env: { ...process.env, PORT: "4321" } }, (e, so) =>
        e ? rej(e) : res(so),
      ),
    );
    expect(out.trim()).toBe("hi dev 1 4321");
  });

  it("reports bundling errors", async () => {
    await writeFile(
      join(dir, "app", "index.ts"),
      "import { x } from './missing';\nconsole.log(x);\n",
    );
    await expect(devCommand("typescript", dir, 1, { which: () => undefined })).rejects.toThrow(
      /missing/,
    );
  });
});

describe("appEnv", () => {
  it("binds the app to loopback and hands it the per-session dev secret", () => {
    const env = appEnv({ HOST: "0.0.0.0", PORT: "1", A: "b" }, 4567, "sekrit");
    expect(env).toEqual({ A: "b", PORT: "4567", HOST: "127.0.0.1", FLARELET_DEV_SECRET: "sekrit" });
  });

  it("newDevSecret is random and long enough", () => {
    const a = newDevSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newDevSecret()).not.toBe(a);
  });
});
