import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { synthesize, type SynthResult, type BuildOptions } from "../constructs/index.js";
import { detectGit, gitExec, type GitInfo } from "../git/index.js";
import { buildPlan, renderPlan } from "../planner/index.js";
import {
  resolveDeployment,
  ResolveError,
  type Deployment,
  type GitRef,
} from "../resolver/index.js";
import { loadIR } from "./load.js";
import type { Io } from "./validate.js";

export interface SynthArgs {
  file: string;
  stage?: string;
  version?: string;
  branch?: string;
  pr?: number;
  defaultBranch?: string;
  region?: string;
  account?: string;
}

export interface SynthDeps {
  io: Io;
  detectGit: () => Promise<GitInfo>;
  env: Record<string, string | undefined>;
  synthesize: (o: BuildOptions & { outdir: string }) => SynthResult;
}

export const defaultSynthDeps = (io: Io, cwd: string): SynthDeps => ({
  io,
  detectGit: () => detectGit({ exec: gitExec(cwd), env: process.env }),
  env: process.env,
  synthesize,
});

const DEFAULT_REGION = "us-east-1";

async function deploymentFor(
  args: SynthArgs,
  git: SynthDeps["detectGit"],
  ir: NonNullable<Awaited<ReturnType<typeof loadIR>>>,
): Promise<Deployment> {
  const explicit = args.stage !== undefined && args.version !== undefined;
  let info: GitInfo = {};
  const needGit =
    !explicit &&
    args.pr === undefined &&
    (args.branch === undefined || args.defaultBranch === undefined);
  if (needGit) {
    info = await git();
  }
  let ref: GitRef | undefined;
  if (args.pr !== undefined) ref = { type: "pr", number: args.pr };
  else if (args.branch !== undefined) ref = { type: "branch", name: args.branch };
  else if (info.pr !== undefined) ref = { type: "pr", number: info.pr };
  else if (info.branch !== undefined) ref = { type: "branch", name: info.branch };

  const defaultBranch = args.defaultBranch ?? info.defaultBranch;
  return resolveDeployment({
    git: ir.git,
    ...(ref ? { ref } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(args.stage !== undefined ? { stage: args.stage } : {}),
    ...(args.version !== undefined ? { version: args.version } : {}),
  });
}

interface Synthesized {
  appName: string;
  deployment: Deployment;
  result: SynthResult;
  ir: NonNullable<Awaited<ReturnType<typeof loadIR>>>;
  outdir: string;
  appDir: string;
}

async function synthAll(args: SynthArgs, deps: SynthDeps): Promise<Synthesized | null> {
  const { io } = deps;
  const ir = await loadIR(args.file, io);
  if (!ir) return null;

  let deployment: Deployment;
  try {
    deployment = await deploymentFor(args, deps.detectGit, ir);
  } catch (e) {
    if (e instanceof ResolveError) {
      io.stderr(`Error: ${e.message}`);
      return null;
    }
    throw e;
  }

  const appDir = dirname(args.file);
  const outdir = join(appDir, ".flareon", "out");
  const region =
    args.region ??
    deps.env.AWS_REGION ??
    deps.env.AWS_DEFAULT_REGION ??
    deps.env.CDK_DEFAULT_REGION ??
    DEFAULT_REGION;
  const account = args.account ?? deps.env.CDK_DEFAULT_ACCOUNT;
  const skipBundling = ["1", "true"].includes(deps.env.FLAREON_SKIP_BUNDLING ?? "");

  let result: SynthResult;
  try {
    result = deps.synthesize({
      ir,
      deployment,
      region,
      ...(account ? { account } : {}),
      outdir,
      appDir,
      skipBundling,
    });
  } catch (e) {
    io.stderr(`Error: synthesis failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }

  await mkdir(join(appDir, ".flareon"), { recursive: true });
  await writeFile(
    join(appDir, ".flareon", "metadata.json"),
    JSON.stringify(
      {
        app: ir.name,
        stage: deployment.stage,
        version: deployment.version,
        lifecycle: deployment.lifecycle,
        region,
        stacks: result.stacks,
      },
      null,
      2,
    ) + "\n",
  );
  return { appName: ir.name, deployment, result, ir, outdir, appDir };
}

export async function runSynth(args: SynthArgs, deps: SynthDeps): Promise<number> {
  const s = await synthAll(args, deps);
  if (!s) return 1;
  const { io } = deps;
  io.stdout(`Synthesized ${s.appName} (${s.deployment.stage}/${s.deployment.version})`);
  io.stdout("");
  for (const st of s.result.stacks) io.stdout(`  ${st.kind.padEnd(8)} ${st.name}`);
  io.stdout("");
  io.stdout(`Cloud Assembly: ${relative(process.cwd(), s.outdir) || s.outdir}`);
  return 0;
}

export async function runPlan(args: SynthArgs, deps: SynthDeps): Promise<number> {
  const s = await synthAll(args, deps);
  if (!s) return 1;
  // AWS 接続が無い段階では既存状態を知らないので、すべて新規作成として表示する。
  deps.io.stdout(renderPlan(buildPlan(s.ir, s.deployment)).trimEnd());
  return 0;
}
