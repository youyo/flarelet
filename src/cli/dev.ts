import { dirname, join } from "node:path";
import type { Cloud } from "../aws/cloud.js";
import type { DevBuildOptions } from "../constructs/dev.js";
import type { SynthResult } from "../constructs/index.js";
import { secretsPath, stackNames } from "../constructs/names.js";
import { aiBindingEnv, bindingEntries, pickBindingEnv } from "../dev/bindings.js";
import { devVersion } from "../dev/user.js";
import type { FlareonIR, RuntimeLanguage } from "../ir/index.js";
import type { Deployment } from "../resolver/index.js";
import { ResolveError, resolveDeployment } from "../resolver/index.js";
import { progressPrinter } from "./deploy.js";
import { loadIR } from "./load.js";
import { errorMessage, isOffline, type OpsDeps } from "./ops.js";
import { regionOf } from "./synth.js";

export const DEFAULT_DEV_PORT = 8787;

export interface DevArgs {
  file: string;
  stage?: string;
  version?: string;
  region?: string;
  port?: number;
  /** 擬似 identity（`x-flareon-user-email` 等）を付ける。 */
  as?: string;
}

export interface LocalOptions {
  /** flareon.yaml のあるディレクトリ（アプリは `<appDir>/app`）。 */
  appDir: string;
  language: RuntimeLanguage;
  /** アプリに渡す環境変数（PORT はローカル側が決める）。 */
  env: Record<string, string>;
  port: number;
  as?: string;
  log: (line: string) => void;
}

export interface LocalSession {
  url: string;
  stop(): Promise<void>;
}

/** `flareon dev` の依存。ローカル起動・停止待ちも差し替え可能。 */
export interface DevDeps extends OpsDeps {
  username: () => string;
  synthesizeDev: (o: DevBuildOptions & { outdir: string }) => SynthResult;
  startLocal: (o: LocalOptions) => Promise<LocalSession>;
  /** Ctrl-C 等で停止するまで待つ。 */
  untilStopped: () => Promise<void>;
}

type Status = "connected" | "offline" | "not deployed";

interface Resolved {
  bindings: Record<string, string>;
  secrets: Record<string, string>;
  /** 既定モードで dev スタックを作ったか。 */
  devStack: boolean;
  offline: boolean;
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
}

async function localBindings(
  ir: FlareonIR,
  d: Deployment,
  region: string,
  appDir: string,
  cloud: Cloud,
  deps: DevDeps,
): Promise<Record<string, string> | null> {
  const { io } = deps;
  const bindings = aiBindingEnv(ir, region);
  if (ir.databases.length + ir.storages.length === 0) return bindings;
  const account = await cloud.account();
  const outdir = join(appDir, ".flareon", "dev", "out");
  let result: SynthResult;
  try {
    result = deps.synthesizeDev({ ir, deployment: d, region, account, outdir });
  } catch (e) {
    io.stderr(`Error: synthesis failed: ${errorMessage(e)}`);
    return null;
  }
  io.stdout(`Preparing dev resources in ${account}/${region}`);
  let stacks;
  try {
    stacks = await deps
      .deployer(region)
      .deploy(outdir, progressPrinter({ result, deployment: d }, io.stdout, io.stderr, deps.now));
  } catch (e) {
    io.stderr("");
    io.stderr(`Error: cannot create the dev resources: ${errorMessage(e)}`);
    return null;
  }
  io.stdout("");
  const raw = stacks.find((s) => s.name === result.stacks[0]?.name)?.outputs.Bindings;
  return { ...bindings, ...(raw ? (JSON.parse(raw) as Record<string, string>) : {}) };
}

async function connectBindings(
  ir: FlareonIR,
  d: Deployment,
  cloud: Cloud,
  io: DevDeps["io"],
): Promise<Record<string, string> | null> {
  const stack = await cloud.describeStack(stackNames(ir.name, d).version);
  const fn = stack?.outputs.AppFunctionName;
  if (!stack || !fn) {
    io.stderr(`Error: ${ir.name} (${d.stage}/${d.version}) is not deployed`);
    return null;
  }
  return pickBindingEnv(await cloud.getFunctionEnv(fn));
}

async function resolve(
  ir: FlareonIR,
  d: Deployment,
  connect: boolean,
  region: string,
  appDir: string,
  deps: DevDeps,
): Promise<Resolved | null> {
  if (isOffline(deps.env)) return { bindings: {}, secrets: {}, devStack: false, offline: true };
  const cloud = deps.cloud(region);
  let bindings: Record<string, string> | null;
  try {
    if (!connect) await cloud.account();
  } catch (e) {
    deps.io.stderr(`Error: cannot reach AWS: ${errorMessage(e)}`);
    deps.io.stderr("  (to run the app without AWS resources, set FLAREON_OFFLINE=1)");
    return null;
  }
  try {
    bindings = connect
      ? await connectBindings(ir, d, cloud, deps.io)
      : await localBindings(ir, d, region, appDir, cloud, deps);
    if (!bindings) return null;
    const stored = ir.secrets.length
      ? await cloud.getParameterValues(secretsPath(ir.name, d.stage))
      : {};
    const secrets = Object.fromEntries(
      ir.secrets.filter((n) => stored[n] !== undefined).map((n) => [n, stored[n]!]),
    );
    const devStack = !connect && ir.databases.length + ir.storages.length > 0;
    return { bindings, secrets, devStack, offline: false };
  } catch (e) {
    deps.io.stderr(`Error: ${errorMessage(e)}`);
    return null;
  }
}

function screen(
  ir: FlareonIR,
  d: Deployment,
  url: string,
  r: Resolved,
  as: string | undefined,
): string[] {
  const lines = [
    "",
    `App       ${ir.name}`,
    `Stage     ${d.stage}`,
    `Version   ${d.version}`,
    `Runtime   ${ir.runtime.language} ${ir.runtime.version}`,
    `URL       ${url}`,
  ];
  if (as) lines.push(`Identity  ${as} (simulated)`);
  const rows: [string, string][] = bindingEntries(ir).map((b) => {
    const status: Status = r.offline
      ? "offline"
      : r.bindings[b.env] !== undefined
        ? "connected"
        : "not deployed";
    return [b.label, status];
  });
  for (const n of ir.secrets) {
    rows.push([
      `secrets.${n}`,
      r.offline ? "offline" : r.secrets[n] !== undefined ? "loaded" : "not set",
    ]);
  }
  if (rows.length) {
    const w = Math.max(...rows.map(([l]) => l.length));
    lines.push("", "Bindings", ...rows.map(([l, s]) => `  ${l.padEnd(w)}    ${s}`));
  }
  lines.push("", "Watching...");
  return lines;
}

export async function runDev(args: DevArgs, deps: DevDeps): Promise<number> {
  const { io } = deps;
  const ir = await loadIR(args.file, io);
  if (!ir) return 1;
  const connect = args.stage !== undefined || args.version !== undefined;
  if (connect && (args.stage === undefined || args.version === undefined)) {
    io.stderr("Error: pass --stage and --version together to connect to an existing environment");
    return 1;
  }
  let d: Deployment;
  try {
    d = resolveDeployment({
      git: ir.git,
      stage: args.stage ?? "preview",
      version: args.version ?? devVersion(deps.username()),
    });
  } catch (e) {
    if (e instanceof ResolveError) {
      io.stderr(`Error: ${e.message}`);
      return 1;
    }
    throw e;
  }
  const region = regionOf(args, deps.env);
  const appDir = dirname(args.file);
  const port = args.port ?? DEFAULT_DEV_PORT;

  io.stdout("Flareon dev");
  io.stdout("");
  const r = await resolve(ir, d, connect, region, appDir, deps);
  if (!r) return 1;

  const env: Record<string, string> = {
    ...definedEnv(deps.env),
    AWS_REGION: region,
    FLAREON_DEV: "1",
    // ローカルのプロキシは常にクライアント由来の x-flareon-* を剥がす（Lambda の front auth と同じ扱い）
    FLAREON_AUTH_ENABLED: "true",
    FLAREON_APP: ir.name,
    FLAREON_STAGE: d.stage,
    FLAREON_VERSION: d.version,
    ...r.bindings,
    ...r.secrets,
  };
  let session: LocalSession;
  try {
    session = await deps.startLocal({
      appDir,
      language: ir.runtime.language,
      env,
      port,
      ...(args.as ? { as: args.as } : {}),
      log: io.stdout,
    });
  } catch (e) {
    io.stderr(`Error: cannot start the app: ${errorMessage(e)}`);
    return 1;
  }
  for (const l of screen(ir, d, session.url, r, args.as)) io.stdout(l);

  await deps.untilStopped();
  await session.stop();
  io.stdout("");
  io.stdout("Stopped.");
  if (r.devStack) {
    io.stdout(
      `The dev resources are kept for next time. Remove them with: flareon destroy --stage ${d.stage} --version ${d.version}`,
    );
  }
  return 0;
}
