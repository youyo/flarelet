import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DockerImage, type BundlingOptions } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { buildSync } from "esbuild";
import type { RuntimeLanguage } from "../ir/index.js";
import { launcherFiles } from "./launcher.js";

const IGNORED = new Set([
  "__pycache__",
  ".venv",
  "venv",
  ".git",
  "node_modules",
  ".pytest_cache",
  ".mypy_cache",
  ".flareon",
]);

export interface StageAppOptions {
  appDir: string;
  language: RuntimeLanguage;
  /** 空に初期化してから書き出す作業ディレクトリ。 */
  stagingDir: string;
  /** true のとき依存解決・バンドルを行わず、ソースをそのまま詰める（テスト/E2E 用）。 */
  skipBundling: boolean;
}

function writeLauncher(dir: string, language: RuntimeLanguage): void {
  for (const [name, f] of Object.entries(launcherFiles(language))) {
    writeFileSync(join(dir, name), f.content, { mode: f.mode });
  }
}

const nodeBanner =
  "import { createRequire as __flareonCreateRequire } from 'node:module';const require = __flareonCreateRequire(import.meta.url);";

/** Lambda 向け: AWS SDK v3 はランタイム同梱なので外部扱い。 */
function esbuildToMjs(entry: string, outfile: string, external: string[] = ["@aws-sdk/*"]): void {
  buildSync({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    external,
    banner: { js: nodeBanner },
    legalComments: "none",
    logLevel: "silent",
  });
}

/** アプリのソースをランチャー付きで stagingDir に配置する。 */
export function stageAppSource(o: StageAppOptions): void {
  rmSync(o.stagingDir, { recursive: true, force: true });
  mkdirSync(o.stagingDir, { recursive: true });

  if (o.language === "python") {
    if (!existsSync(join(o.appDir, "main.py"))) {
      throw new Error(
        `${join(o.appDir, "main.py")} not found (python apps expose \`app\` in app/main.py)`,
      );
    }
    if (!existsSync(join(o.appDir, "requirements.txt"))) {
      throw new Error(
        `${join(o.appDir, "requirements.txt")} not found (list uvicorn and your framework in it)`,
      );
    }
    cpSync(o.appDir, o.stagingDir, {
      recursive: true,
      filter: (src) => !IGNORED.has(src.split("/").pop() ?? ""),
    });
  } else {
    const entry = join(o.appDir, "index.ts");
    if (!existsSync(entry)) {
      throw new Error(`${entry} not found (typescript apps listen on $PORT from app/index.ts)`);
    }
    if (o.skipBundling) {
      cpSync(entry, join(o.stagingDir, "index.ts"));
    } else {
      try {
        esbuildToMjs(entry, join(o.stagingDir, "index.mjs"));
      } catch (e) {
        throw new Error(
          `failed to bundle ${entry} (did you run \`npm install\` in the app directory?): ${
            e instanceof Error ? e.message.split("\n")[0] : String(e)
          }`,
          { cause: e },
        );
      }
    }
  }
  writeLauncher(o.stagingDir, o.language);
}

/** Python 依存は Lambda と同じ arm64 の SAM ビルドイメージで pip install する。 */
export function pythonBundling(version: string): BundlingOptions {
  return {
    image: DockerImage.fromRegistry(`public.ecr.aws/sam/build-python${version}:latest`),
    platform: "linux/arm64",
    command: [
      "bash",
      "-c",
      "pip install --quiet --disable-pip-version-check -r requirements.txt -t /asset-output && cp -au . /asset-output",
    ],
  };
}

export interface AppCodeOptions extends Omit<StageAppOptions, "stagingDir"> {
  runtimeVersion: string;
  cacheDir: string;
}

export function appCode(o: AppCodeOptions): lambda.Code {
  const stagingDir = join(o.cacheDir, "app");
  stageAppSource({ ...o, stagingDir });
  return lambda.Code.fromAsset(
    stagingDir,
    o.language === "python" && !o.skipBundling
      ? { bundling: pythonBundling(o.runtimeVersion) }
      : {},
  );
}

/** front auth Lambda のエントリ（src/auth/handler.ts、ビルド後は dist/auth/handler.js）。 */
export function frontAuthEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const f of ["../auth/handler.ts", "../auth/handler.js"]) {
    const p = join(here, f);
    if (existsSync(p)) return p;
  }
  throw new Error("front auth Lambda entry (auth/handler) not found");
}

export function bundleFrontAuth(outDir: string, entry: string = frontAuthEntry()): void {
  mkdirSync(outDir, { recursive: true });
  esbuildToMjs(entry, join(outDir, "index.mjs"));
}

export function frontAuthCode(cacheDir: string): lambda.Code {
  const dir = join(cacheDir, "front-auth");
  rmSync(dir, { recursive: true, force: true });
  bundleFrontAuth(dir);
  return lambda.Code.fromAsset(dir);
}

/**
 * `flareon dev` 向け: app/index.ts を依存ごと 1 ファイルにバンドルする（本番と同じ esbuild 経路）。
 * ローカルには AWS SDK が同梱されていないので、アプリの node_modules から取り込む。
 */
export function bundleDevApp(entry: string, outfile: string): void {
  mkdirSync(dirname(outfile), { recursive: true });
  esbuildToMjs(entry, outfile, []);
}
