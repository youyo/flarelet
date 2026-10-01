// 実 AWS E2E（FLAREON_E2E_AWS=1）の共通処理。テスト専用アプリ名のリソースだけを作成・削除する。
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
  ListStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import {
  CognitoIdentityProviderClient,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DescribeTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DeleteParameterCommand, GetParametersByPathCommand, SSMClient } from "@aws-sdk/client-ssm";
import { awsCloud } from "../../../src/aws/real.js";

export const ENABLED = process.env.FLAREON_E2E_AWS === "1";
export const REGION = "ap-northeast-1";
/** deploy を含むテスト・フックのタイムアウト。 */
export const LONG = 30 * 60_000;

const CLI = resolve(import.meta.dirname, "../../../dist/cli/index.js");
const FIXTURES = resolve(import.meta.dirname, "fixtures");

const ENV: NodeJS.ProcessEnv = {
  ...process.env,
  AWS_REGION: REGION,
  FLAREON_OFFLINE: "",
  FLAREON_SKIP_BUNDLING: "",
};

export const log = (msg: string): void => {
  console.log(`[e2e ${new Date().toISOString().slice(11, 19)}] ${msg}`);
};

/** テスト専用のアプリ名（Cognito の禁止語を含まず、24 文字以内）。 */
export const uniqueName = (kind: string): string =>
  `fe2e-${kind}-${randomBytes(3).toString("hex")}`;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export function cli(args: string[], cwd: string, input?: string): Promise<CliResult> {
  const t0 = Date.now();
  return new Promise((res) => {
    const child = execFile(
      process.execPath,
      [CLI, ...args, "--region", REGION],
      { cwd, env: ENV, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        res({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout,
          stderr,
          ms: Date.now() - t0,
        });
      },
    );
    child.stdin?.end(input ?? "");
  });
}

/** 長時間動くコマンド（logs --follow）。stdout を逐次受け取る。 */
export function cliStream(
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
): ChildProcess {
  const child = spawn(process.execPath, [CLI, ...args, "--region", REGION], { cwd, env: ENV });
  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
  return child;
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd }, (e, _o, se) => (e ? rej(new Error(`${cmd}: ${se}`)) : res()));
  });
}

/** フィクスチャをテンポラリにコピーし、flareon.yaml を書く。TypeScript なら依存を入れる。 */
export async function prepareApp(fixture: "python" | "typescript", yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `flareon-aws-${fixture}-`));
  await cp(join(FIXTURES, fixture), dir, { recursive: true });
  await writeFile(join(dir, "flareon.yaml"), yaml);
  if (fixture === "typescript") {
    await run("npm", ["install", "--no-audit", "--no-fund", "--silent"], join(dir, "app"));
  }
  return dir;
}

export const removeDir = (dir: string | undefined) =>
  dir ? rm(dir, { recursive: true, force: true }) : Promise.resolve();

export const urlFrom = (out: string): string => {
  const m = /URL\s+(https:\/\/\S+)/.exec(out);
  if (!m) throw new Error(`no URL in deploy output:\n${out}`);
  return m[1]!;
};

/** 指定時間内に条件が真になるまで待つ。 */
export async function eventually<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  intervalMs = 1000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v !== undefined) return v;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs}ms${lastErr ? `: ${String(lastErr)}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

const cfn = new CloudFormationClient({ region: REGION });

export async function stackOutputs(name: string): Promise<Record<string, string> | undefined> {
  try {
    const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
    const s = out.Stacks?.[0];
    if (!s || s.StackStatus === "DELETE_COMPLETE") return undefined;
    return Object.fromEntries((s.Outputs ?? []).map((o) => [o.OutputKey!, o.OutputValue!]));
  } catch (e) {
    if (e instanceof Error && /does not exist/.test(e.message)) return undefined;
    throw e;
  }
}

async function appStacks(app: string): Promise<{ name: string; id: string }[]> {
  const out: { name: string; id: string }[] = [];
  let token: string | undefined;
  do {
    const page = await cfn.send(new DescribeStacksCommand({ NextToken: token }));
    for (const s of page.Stacks ?? []) {
      if (s.Tags?.some((t) => t.Key === "flareon:app" && t.Value === app)) {
        out.push({ name: s.StackName!, id: s.StackId! });
      }
    }
    token = page.NextToken;
  } while (token);
  return out;
}

/** 物理リソース（削除確認用）。 */
export interface Tracked {
  stacks: Set<string>;
  resources: Map<string, string>; // physicalId -> type
}

export const newTracked = (): Tracked => ({ stacks: new Set(), resources: new Map() });

const TRACK_TYPES = new Set([
  "AWS::DynamoDB::Table",
  "AWS::S3::Bucket",
  "AWS::Cognito::UserPool",
  "AWS::SecretsManager::Secret",
  "AWS::Logs::LogGroup",
]);

/** アプリのスタックとその中の状態を持つリソースを記録する（後で消えたことを確認する）。 */
export async function track(app: string, t: Tracked): Promise<void> {
  for (const s of await appStacks(app)) {
    t.stacks.add(s.name);
    let token: string | undefined;
    do {
      const page = await cfn.send(
        new ListStackResourcesCommand({ StackName: s.id, NextToken: token }),
      );
      for (const r of page.StackResourceSummaries ?? []) {
        if (r.PhysicalResourceId && TRACK_TYPES.has(r.ResourceType ?? "")) {
          t.resources.set(r.PhysicalResourceId, r.ResourceType!);
        }
      }
      token = page.NextToken;
    } while (token);
  }
}

/**
 * 後始末の安全網: CLI の destroy が失敗しても、テスト用アプリのスタック・RETAIN リソース・SSM を消す。
 * 対象は flareon:app タグ（テスト専用名）と記録済みの物理 ID に限る。
 */
export async function forceCleanup(app: string, t: Tracked): Promise<void> {
  await track(app, t).catch(() => {});
  const cloud = awsCloud(REGION);
  for (const s of await appStacks(app)) {
    // version スタックを先に（stage スタックの Export を参照しているため）
    if (!/-(prod|preview)$/.test(s.name)) {
      log(`safety net: deleting ${s.name}`);
      await cloud.deleteStack(s.name, () => {}).catch((e) => log(`  ${String(e)}`));
    }
  }
  for (const s of await appStacks(app)) {
    log(`safety net: deleting ${s.name}`);
    await cfn.send(new DeleteStackCommand({ StackName: s.id })).catch(() => {});
    await cloud.deleteStack(s.name, () => {}).catch((e) => log(`  ${String(e)}`));
  }
  for (const [id, type] of t.resources) {
    if (type === "AWS::Logs::LogGroup") continue;
    await cloud
      .deleteRetained({ logicalId: "", physicalId: id, type })
      .catch((e) => log(`safety net: ${type} ${id}: ${String(e)}`));
  }
  const ssm = new SSMClient({ region: REGION });
  const params = await ssm.send(
    new GetParametersByPathCommand({ Path: `/flareon/${app}`, Recursive: true }),
  );
  for (const p of params.Parameters ?? []) {
    await ssm.send(new DeleteParameterCommand({ Name: p.Name! }));
  }
}

const notFound = async (fn: () => Promise<unknown>, names: RegExp): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (e) {
    const n = e instanceof Error ? `${e.name} ${e.message}` : String(e);
    if (names.test(n)) return true;
    throw e;
  }
};

/** 記録したスタック・リソースと SSM パラメータが 1 つも残っていないことを確認し、残りを返す。 */
export async function leftovers(app: string, t: Tracked): Promise<string[]> {
  const left: string[] = [];
  for (const s of await appStacks(app)) left.push(`stack ${s.name}`);
  for (const name of t.stacks) {
    if (await stackOutputs(name)) left.push(`stack ${name}`);
  }
  const ddb = new DynamoDBClient({ region: REGION });
  const s3 = new S3Client({ region: REGION });
  const idp = new CognitoIdentityProviderClient({ region: REGION });
  const sm = new SecretsManagerClient({ region: REGION });
  const logs = new CloudWatchLogsClient({ region: REGION });
  for (const [id, type] of t.resources) {
    let gone = true;
    switch (type) {
      case "AWS::DynamoDB::Table":
        gone = await notFound(
          () => ddb.send(new DescribeTableCommand({ TableName: id })),
          /ResourceNotFound/,
        );
        break;
      case "AWS::S3::Bucket":
        gone = await notFound(
          () => s3.send(new HeadBucketCommand({ Bucket: id })),
          /NotFound|NoSuchBucket|404/,
        );
        break;
      case "AWS::Cognito::UserPool":
        gone = await notFound(
          () => idp.send(new DescribeUserPoolCommand({ UserPoolId: id })),
          /ResourceNotFound/,
        );
        break;
      case "AWS::SecretsManager::Secret":
        gone = await notFound(
          () => sm.send(new DescribeSecretCommand({ SecretId: id })),
          /ResourceNotFound/,
        );
        break;
      case "AWS::Logs::LogGroup": {
        const out = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: id }));
        gone = !(out.logGroups ?? []).some((g) => g.logGroupName === id);
        break;
      }
    }
    if (!gone) left.push(`${type} ${id}`);
  }
  const ssm = new SSMClient({ region: REGION });
  const params = await ssm.send(
    new GetParametersByPathCommand({ Path: `/flareon/${app}`, Recursive: true }),
  );
  for (const p of params.Parameters ?? []) left.push(`ssm ${p.Name}`);
  return left;
}

/** fetch（リダイレクトは追わない）。 */
export const get = (url: string, headers: Record<string, string> = {}) =>
  fetch(url, { redirect: "manual", headers });

/** DynamoDB / Secrets Manager の削除は非同期なので、残りが無くなるまで最大 3 分待ってから返す。 */
export async function leftoversSettled(app: string, t: Tracked): Promise<string[]> {
  const deadline = Date.now() + 3 * 60_000;
  for (;;) {
    const left = await leftovers(app, t);
    if (!left.length || Date.now() > deadline) return left;
    log(`waiting for deletion: ${left.join(", ")}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
