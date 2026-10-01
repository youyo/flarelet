import type { Cloud, Deployer } from "../aws/cloud.js";
import { errorMessage, formatDuration, type OpsDeps } from "./ops.js";
import { regionOf } from "./synth.js";
import type { Io } from "./validate.js";

/** CDK の既定 qualifier。Flarelet のアプリスタックはこれを使う。 */
export const DEFAULT_QUALIFIER = "hnb659fds";
/** CDK bootstrap のスタック名（toolkit-lib の既定）。 */
export const TOOLKIT_STACK = "CDKToolkit";

/** 未 bootstrap のときに案内する 1 行。 */
export function notBootstrappedMessage(
  account: string,
  region: string,
  qualifier = DEFAULT_QUALIFIER,
): string {
  const q = qualifier === DEFAULT_QUALIFIER ? "" : ` --qualifier ${qualifier}`;
  return `Error: ${account}/${region} is not bootstrapped for Flarelet. Run: flarelet bootstrap aws --region ${region}${q}`;
}

interface TtyLike {
  isTTY?: boolean;
}

/** stdin と stdout の両方が端末なら対話的とみなす。 */
export const isInteractive = (stdin: TtyLike, stdout: TtyLike): boolean =>
  stdin.isTTY === true && stdout.isTTY === true;

/**
 * deploy / dev で未 bootstrap のとき自動で bootstrap してよいか。
 * `--bootstrap` / `--no-bootstrap`（flag）が最優先。指定が無ければ対話端末かつ `--ci` でないときだけ。
 */
export function autoBootstrapAllowed(o: {
  flag: boolean | undefined;
  ci: boolean;
  interactive: boolean;
}): boolean {
  if (o.flag !== undefined) return o.flag;
  return o.interactive && !o.ci;
}

/**
 * CDKToolkit スタックを新規作成し、作成後のバージョンを返す。
 * 既存の CDKToolkit（別 qualifier など）は更新しない。
 */
async function createToolkitStack(
  cloud: Cloud,
  deployer: Deployer,
  target: { account: string; region: string; qualifier: string },
  onStackEvent: (e: "start" | "end") => void = () => {},
): Promise<number | undefined> {
  const existing = await cloud.describeStack(TOOLKIT_STACK);
  if (existing) {
    throw new Error(
      `stack ${TOOLKIT_STACK} already exists in ${target.account}/${target.region} (${existing.status}) but /cdk-bootstrap/${target.qualifier}/version is missing; it may use another qualifier (pass --qualifier). Flarelet does not modify an existing ${TOOLKIT_STACK} stack`,
    );
  }
  onStackEvent("start");
  // 生の CloudFormation イベント・警告は表示しない（進捗はスタック単位で呼び出し側が出す）
  await deployer.bootstrap(target, () => {});
  onStackEvent("end");
  return cloud.bootstrapVersion(target.qualifier);
}

const versionText = (v: number | undefined): string => (v === undefined ? "" : ` (version ${v})`);

/**
 * deploy / dev の事前チェック。bootstrap 済みなら true。
 * 未 bootstrap なら、許可されていれば自動で bootstrap して true、そうでなければ案内を出して false。
 * 状態を読めない（権限不足など）ときは警告だけ出して続行する（CDK 側のエラーに任せる）。
 */
export async function ensureBootstrapped(o: {
  cloud: Cloud;
  deployer: Deployer;
  account: string;
  region: string;
  io: Io;
  auto: boolean;
  /** 自動 bootstrap しないときに `--bootstrap` を案内するか。 */
  hintFlag: boolean;
}): Promise<boolean> {
  const { cloud, io, account, region } = o;
  let version: number | undefined;
  try {
    version = await cloud.bootstrapVersion(DEFAULT_QUALIFIER);
  } catch (e) {
    io.stderr(`Warning: cannot check the CDK bootstrap (${errorMessage(e)}); continuing`);
    return true;
  }
  if (version !== undefined) return true;
  if (!o.auto) {
    io.stderr(notBootstrappedMessage(account, region));
    if (o.hintFlag) io.stderr("  (or pass --bootstrap to do it as part of this command)");
    return false;
  }
  io.stdout(`Bootstrapping ${account}/${region} for Flarelet (one-time)...`);
  try {
    const v = await createToolkitStack(cloud, o.deployer, {
      account,
      region,
      qualifier: DEFAULT_QUALIFIER,
    });
    io.stdout(`Bootstrapped${versionText(v)}`);
    io.stdout("");
    return true;
  } catch (e) {
    io.stderr(`Error: bootstrap failed: ${errorMessage(e)}`);
    return false;
  }
}

/** bootstrap github 等、自動実行しない操作の事前チェック。未 bootstrap なら案内を出して false。 */
export async function requireBootstrapped(
  cloud: Cloud,
  account: string,
  region: string,
  qualifier: string,
  io: Io,
): Promise<boolean> {
  if ((await cloud.bootstrapVersion(qualifier)) !== undefined) return true;
  io.stderr(notBootstrappedMessage(account, region, qualifier));
  return false;
}

/** plan 用。未 bootstrap なら警告文を返す（読めなければ何も言わない）。 */
export async function bootstrapWarning(
  cloud: Cloud,
  account: string,
  region: string,
): Promise<string | undefined> {
  try {
    if ((await cloud.bootstrapVersion(DEFAULT_QUALIFIER)) !== undefined) return undefined;
  } catch {
    return undefined;
  }
  return `Warning: ${account}/${region} is not bootstrapped for Flarelet; deploy will bootstrap it (or run: flarelet bootstrap aws --region ${region})`;
}

export interface BootstrapAwsArgs {
  region?: string;
  qualifier?: string;
}

/** `flarelet bootstrap aws`。未 bootstrap のときだけ CDKToolkit を作る（既存は更新しない）。 */
export async function runBootstrapAws(args: BootstrapAwsArgs, deps: OpsDeps): Promise<number> {
  const { io } = deps;
  const region = regionOf(args, deps.env);
  const qualifier = args.qualifier ?? DEFAULT_QUALIFIER;
  const cloud = deps.cloud(region);
  let account: string;
  try {
    account = await cloud.account();
  } catch (e) {
    io.stderr(`Error: cannot reach AWS: ${errorMessage(e)}`);
    return 1;
  }
  try {
    const current = await cloud.bootstrapVersion(qualifier);
    if (current !== undefined) {
      io.stdout(`${account}/${region} is already bootstrapped (version ${current})`);
      return 0;
    }
    io.stdout(`Bootstrapping ${account}/${region} for Flarelet (qualifier ${qualifier})`);
    io.stdout("");
    let t0 = deps.now();
    const v = await createToolkitStack(
      cloud,
      deps.deployer(region),
      { account, region, qualifier },
      (e) => {
        if (e === "start") {
          t0 = deps.now();
          io.stdout(`  deploying ${TOOLKIT_STACK}`);
        } else io.stdout(`    done (${formatDuration(deps.now() - t0)})`);
      },
    );
    io.stdout("");
    io.stdout(`Bootstrapped ${account}/${region}${versionText(v)}`);
    return 0;
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
