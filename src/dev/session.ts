import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, watch } from "node:fs";
import { createServer } from "node:net";
import { delimiter, join } from "node:path";
import { bundleDevApp } from "../constructs/packaging.js";
import type { LocalOptions, LocalSession } from "../cli/dev.js";
import type { RuntimeLanguage } from "../ir/index.js";
import { startProxy } from "./proxy.js";
import { createSupervisor, type AppCommand, type SupervisorDeps } from "./supervisor.js";

/** PATH 上の実行ファイル。 */
export function which(name: string, path = process.env.PATH ?? ""): string | undefined {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // 次の候補
    }
  }
  return undefined;
}

/**
 * ローカルでアプリを起動するコマンド。
 * - python: `python -m uvicorn main:app`（app/ を cwd、PATH 上の python。無ければ python3）
 * - typescript: app/index.ts を esbuild でバンドルし、この Node で実行する（追加の依存なし）
 * 再起動はファイル監視（supervisor）が行うので、各ツールのリロード機能は使わない。
 */
export async function devCommand(
  language: RuntimeLanguage,
  appDir: string,
  port: number,
  deps: { which: (name: string) => string | undefined } = { which: (n) => which(n) },
): Promise<AppCommand> {
  const src = join(appDir, "app");
  if (language === "python") {
    if (!existsSync(join(src, "main.py"))) {
      throw new Error(
        `${join(src, "main.py")} not found (python apps expose \`app\` in app/main.py)`,
      );
    }
    const python = deps.which("python") ?? deps.which("python3");
    if (!python) throw new Error("python (or python3) was not found on PATH");
    return {
      cmd: python,
      args: ["-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", String(port)],
      cwd: src,
    };
  }
  const entry = join(src, "index.ts");
  if (!existsSync(entry)) {
    throw new Error(`${entry} not found (typescript apps listen on $PORT from app/index.ts)`);
  }
  const outfile = join(appDir, ".flareon", "dev", "app", "index.mjs");
  try {
    bundleDevApp(entry, outfile);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`failed to build ${entry}: ${msg}`, { cause: e });
  }
  return { cmd: process.execPath, args: [outfile], cwd: src };
}

/** 空いている TCP ポート（アプリ用。利用者に見せるのはプロキシのポート）。 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const realSupervisorDeps: SupervisorDeps = {
  spawn: (cmd, args, opts) =>
    spawn(cmd, args, { ...opts, stdio: ["ignore", "inherit", "inherit"] }),
  watch: (dir, onChange) => {
    const w = watch(dir, { recursive: true }, (_ev, file) => {
      if (file) onChange(String(file));
    });
    return { close: () => w.close() };
  },
};

/** プロキシ（利用者のポート）→ アプリ（内部ポート）。アプリはファイル変更で再起動する。 */
export async function startLocal(o: LocalOptions): Promise<LocalSession> {
  const appPort = await freePort();
  const proxy = await startProxy({
    port: o.port,
    targetPort: appPort,
    ...(o.as ? { identity: o.as } : {}),
  });
  const supervisor = createSupervisor(
    {
      watchDir: join(o.appDir, "app"),
      command: () => devCommand(o.language, o.appDir, appPort),
      env: { ...o.env, PORT: String(appPort) },
      log: o.log,
    },
    realSupervisorDeps,
  );
  try {
    await supervisor.start();
  } catch (e) {
    await proxy.close();
    throw e;
  }
  return {
    url: `http://localhost:${proxy.port}`,
    stop: async () => {
      await supervisor.stop();
      await proxy.close();
    },
  };
}
