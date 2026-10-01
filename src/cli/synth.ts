import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Cloud } from "../aws/cloud.js";
import { diffTemplates, type CfnTemplate } from "../aws/concepts.js";
import { dirname, join, relative } from "node:path";
import { synthesize, type SynthResult, type BuildOptions } from "../constructs/index.js";
import { detectGit, gitExec, type GitInfo } from "../git/index.js";
import { buildPlan, renderPlan, type PlanState } from "../planner/index.js";
import { errorMessage, isOffline } from "./ops.js";
import {
  resolveDeployment,
  ResolveError,
  type Deployment,
  type GitRef,
} from "../resolver/index.js";
import type { FlareonIR } from "../ir/index.js";
import { idpSecretState, needsIdpSecrets } from "./idp.js";
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
  /** 外部 IdP の資格情報のバージョン ID（deploy / plan が AWS から取得して渡す）。 */
  idpSecretVersions?: Record<string, string>;
  /** GitHub Actions 向け（イベントに応じた実行可否の判定）。deploy / destroy で使う。 */
  ci?: boolean;
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
  ir: FlareonIR,
): Promise<{ deployment: Deployment; source: string | undefined }> {
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
  const deployment = resolveDeployment({
    git: ir.git,
    ...(ref ? { ref } : {}),
    ...(defaultBranch !== undefined ? { defaultBranch } : {}),
    ...(args.stage !== undefined ? { stage: args.stage } : {}),
    ...(args.version !== undefined ? { version: args.version } : {}),
  });
  return { deployment, source: args.branch ?? (args.pr === undefined ? info.branch : undefined) };
}

export const regionOf = (
  args: Pick<SynthArgs, "region">,
  env: Record<string, string | undefined>,
): string =>
  args.region ??
  env.AWS_REGION ??
  env.AWS_DEFAULT_REGION ??
  env.CDK_DEFAULT_REGION ??
  DEFAULT_REGION;

/** flareon.yaml を読み、Git / 引数からデプロイ先（stage/version）とリージョンを決める。 */
export interface Target {
  ir: FlareonIR;
  deployment: Deployment;
  region: string;
  appDir: string;
  /** 解決に使った Git ブランチ（分かれば）。 */
  source: string | undefined;
}

export async function resolveTarget(
  args: SynthArgs,
  deps: Pick<SynthDeps, "io" | "detectGit" | "env">,
): Promise<Target | null> {
  const { io } = deps;
  const ir = await loadIR(args.file, io);
  if (!ir) return null;
  let resolved;
  try {
    resolved = await deploymentFor(args, deps.detectGit, ir);
  } catch (e) {
    if (e instanceof ResolveError) {
      io.stderr(`Error: ${e.message}`);
      return null;
    }
    throw e;
  }
  return { ir, ...resolved, region: regionOf(args, deps.env), appDir: dirname(args.file) };
}

export interface Synthesized {
  region: string;
  appName: string;
  deployment: Deployment;
  result: SynthResult;
  ir: FlareonIR;
  outdir: string;
  appDir: string;
}

export async function synthAll(
  args: SynthArgs,
  deps: SynthDeps,
  target?: Target,
): Promise<Synthesized | null> {
  const { io } = deps;
  const t = target ?? (await resolveTarget(args, deps));
  if (!t) return null;
  const { ir, deployment, region, appDir } = t;
  const outdir = join(appDir, ".flareon", "out");
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
      ...(t.source !== undefined ? { source: t.source } : {}),
      ...(args.idpSecretVersions ? { idpSecretVersions: args.idpSecretVersions } : {}),
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
  return { appName: ir.name, deployment, result, ir, outdir, appDir, region };
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

/** plan は OpsDeps（cloud あり）なら AWS のデプロイ済みテンプレートと比較する。 */
export async function runPlan(
  args: SynthArgs,
  deps: SynthDeps & { cloud?: (region: string) => Cloud },
): Promise<number> {
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const online = deps.cloud !== undefined && !isOffline(deps.env);
  let cloud: Cloud | undefined;
  let account: string | undefined;
  if (online && deps.cloud) {
    try {
      cloud = deps.cloud(t.region);
      account = await cloud.account();
    } catch (e) {
      cloud = undefined;
      deps.io.stderr(
        `Warning: cannot reach AWS (${errorMessage(e)}); showing the plan as a new deployment`,
      );
    }
  }
  let idpSecretVersions: Record<string, string> | undefined;
  if (cloud && needsIdpSecrets(t.ir, t.deployment)) {
    try {
      const st = await idpSecretState(cloud, t.ir, t.deployment);
      if (st.missing.length) {
        deps.io.stderr(
          `Warning: ${st.missing.join(", ")} not set for ${t.deployment.stage}; deploy will fail until set (flareon secret set <name> --stage ${t.deployment.stage})`,
        );
      } else idpSecretVersions = st.versions;
    } catch (e) {
      deps.io.stderr(`Warning: cannot read the sign-in credentials (${errorMessage(e)})`);
    }
  }
  const s = await synthAll(
    {
      ...args,
      ...(account ? { account } : {}),
      ...(idpSecretVersions ? { idpSecretVersions } : {}),
    },
    deps,
    t,
  );
  if (!s) return 1;

  let state: PlanState | undefined;
  if (cloud) {
    try {
      const pairs = await Promise.all(
        s.result.stacks.map(async (st) => ({
          next: JSON.parse(
            await readFile(join(s.outdir, `${st.name}.template.json`), "utf8"),
          ) as CfnTemplate,
          prev: await cloud.getTemplate(st.name),
        })),
      );
      const diff = diffTemplates(pairs);
      // 認証なしの公開エンドポイントは専用リソースを持たない。application があれば存在扱い。
      if (s.ir.http && !s.ir.http.auth.enabled && diff.existing.has("application")) {
        diff.existing.add("authentication");
        diff.removed.delete("authentication");
      }
      state = diff;
    } catch (e) {
      deps.io.stderr(
        `Warning: cannot read the deployed state (${errorMessage(e)}); showing the plan as a new deployment`,
      );
    }
  }
  deps.io.stdout(renderPlan(buildPlan(s.ir, s.deployment, state)).trimEnd());
  return 0;
}
