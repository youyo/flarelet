// flarelet bootstrap aws / deploy の自動 bootstrap。未 bootstrap のリージョン（us-west-2）で
// 「deploy が止まる → deploy --bootstrap で bootstrap＋デプロイ → bootstrap aws は何もしない」を確かめ、
// 最後に CDKToolkit スタック・ステージング用バケット・ECR リポジトリ・SSM パラメータまで消す。
// 開始時に既に bootstrap 済みなら中止し、既存の CDKToolkit には一切触れない。
import {
  CloudFormationClient,
  DescribeStacksCommand,
  UpdateTerminationProtectionCommand,
} from "@aws-sdk/client-cloudformation";
import { DeleteRepositoryCommand, ECRClient } from "@aws-sdk/client-ecr";
import { HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { awsCloud } from "../../../src/aws/real.js";
import {
  cli,
  ENABLED,
  forceCleanup,
  get,
  leftoversSettled,
  log,
  LONG,
  newTracked,
  prepareApp,
  removeDir,
  track,
  uniqueName,
  urlFrom,
} from "./helpers.js";

const REGION = "us-west-2";
const QUALIFIER = "hnb659fds";
const PARAM = `/cdk-bootstrap/${QUALIFIER}/version`;
const TOOLKIT = "CDKToolkit";

const cfn = new CloudFormationClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const ecr = new ECRClient({ region: REGION });

const errText = (e: unknown): string => (e instanceof Error ? `${e.name} ${e.message}` : String(e));

async function bootstrapParam(): Promise<string | undefined> {
  try {
    return (await ssm.send(new GetParameterCommand({ Name: PARAM }))).Parameter?.Value;
  } catch (e) {
    if (/ParameterNotFound/.test(errText(e))) return undefined;
    throw e;
  }
}

async function toolkitStatus(): Promise<string | undefined> {
  try {
    const s = (await cfn.send(new DescribeStacksCommand({ StackName: TOOLKIT }))).Stacks?.[0];
    return s?.StackStatus === "DELETE_COMPLETE" ? undefined : s?.StackStatus;
  } catch (e) {
    if (/does not exist/.test(errText(e))) return undefined;
    throw e;
  }
}

async function bucketExists(bucket: string): Promise<boolean> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (e) {
    if (/NotFound|NoSuchBucket|404/.test(errText(e))) return false;
    throw e;
  }
}

describe.runIf(ENABLED)("real AWS: bootstrap aws in an unbootstrapped region", () => {
  const app = uniqueName("boot");
  const tracked = newTracked();
  let dir: string | undefined;
  let account = "";
  /** 開始時に未 bootstrap だと確認できたときだけ、CDKToolkit 一式を消してよい。 */
  let ownsToolkit = false;

  const bucket = () => `cdk-${QUALIFIER}-assets-${account}-${REGION}`;
  const repo = () => `cdk-${QUALIFIER}-container-assets-${account}-${REGION}`;

  beforeAll(async () => {
    account = await awsCloud(REGION).account();
    const param = await bootstrapParam();
    const status = await toolkitStatus();
    if (param !== undefined || status !== undefined) {
      throw new Error(
        `${account}/${REGION} is already bootstrapped (${PARAM}=${param ?? "-"}, ${TOOLKIT}=${status ?? "-"}); aborting without touching it`,
      );
    }
    ownsToolkit = true;
    dir = await prepareApp(
      "typescript",
      `version: 1
name: ${app}
runtime: { language: typescript }
http: { auth: false }
`,
    );
  }, LONG);

  afterAll(async () => {
    const problems: string[] = [];
    // 1. アプリのスタック（CDKToolkit の cfn-exec ロールで作られているので、先に消す）
    try {
      if (dir) {
        await track(app, tracked, REGION).catch(() => {});
        const r = await cli(
          ["destroy", "--stage", "prod", "--version", "current"],
          dir,
          "",
          REGION,
        );
        log(`destroy ${app}: exit ${r.code} (${r.ms}ms)`);
      }
    } catch (e) {
      problems.push(`destroy: ${errText(e)}`);
    }
    let appLeft: string[] = [];
    try {
      await forceCleanup(app, tracked, REGION);
      appLeft = await leftoversSettled(app, tracked, REGION);
    } catch (e) {
      problems.push(`app cleanup: ${errText(e)}`);
    }
    if (appLeft.length) problems.push(`leftover app resources: ${appLeft.join(", ")}`);

    // 2. CDKToolkit 一式（このテストが作ったものだけ。アプリが残っているとロールが必要なので消さない）
    if (ownsToolkit && !appLeft.length) {
      try {
        if (await toolkitStatus()) {
          await cfn.send(
            new UpdateTerminationProtectionCommand({
              StackName: TOOLKIT,
              EnableTerminationProtection: false,
            }),
          );
          log(`deleting ${TOOLKIT} in ${REGION}`);
          await awsCloud(REGION).deleteStack(TOOLKIT, (s) => log(`  ${TOOLKIT}: ${s}`));
        }
      } catch (e) {
        problems.push(`${TOOLKIT}: ${errText(e)}`);
      }
      try {
        // RETAIN で残るステージング用バケット（中身ごと）
        await awsCloud(REGION).deleteRetained({
          logicalId: "StagingBucket",
          physicalId: bucket(),
          type: "AWS::S3::Bucket",
        });
      } catch (e) {
        problems.push(`bucket: ${errText(e)}`);
      }
      try {
        await ecr.send(new DeleteRepositoryCommand({ repositoryName: repo(), force: true }));
        log(`deleted ECR repository ${repo()}`);
      } catch (e) {
        if (!/RepositoryNotFound/.test(errText(e))) problems.push(`ecr: ${errText(e)}`);
      }
      try {
        if (await toolkitStatus()) problems.push(`${TOOLKIT} still exists`);
        if (await bucketExists(bucket())) problems.push(`bucket ${bucket()} still exists`);
        if ((await bootstrapParam()) !== undefined) problems.push(`${PARAM} still exists`);
      } catch (e) {
        problems.push(`final check: ${errText(e)}`);
      }
    }
    await removeDir(dir);
    expect(problems, `cleanup in ${REGION}`).toEqual([]);
  }, LONG);

  it(
    "deploy stops before CloudFormation when the region is not bootstrapped (non-interactive)",
    async () => {
      const r = await cli(["deploy", "--stage", "prod", "--version", "current"], dir!, "", REGION);
      log(`deploy (not bootstrapped): exit ${r.code} in ${r.ms}ms`);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(
        `Error: ${account}/${REGION} is not bootstrapped for Flarelet. Run: flarelet bootstrap aws --region ${REGION}`,
      );
      expect(r.stdout).not.toContain("Deploying");
      expect(await toolkitStatus()).toBeUndefined();
      expect(await stackExists(`flarelet-${app}-prod`)).toBe(false);
    },
    LONG,
  );

  it(
    "deploy --bootstrap bootstraps the region, deploys and serves HTTP 200",
    async () => {
      const r = await cli(
        ["deploy", "--stage", "prod", "--version", "current", "--bootstrap"],
        dir!,
        "",
        REGION,
      );
      log(`deploy --bootstrap: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain(`Bootstrapping ${account}/${REGION} for Flarelet (one-time)...`);
      expect(r.stdout).toMatch(/Bootstrapped \(version \d+\)/);
      // 生の CloudFormation イベント・CDK の警告は出さない
      expect(r.stdout + r.stderr).not.toMatch(/AWS::|CREATE_IN_PROGRESS|AdministratorAccess/);
      await track(app, tracked, REGION);
      expect(await bootstrapParam()).toMatch(/^\d+$/);
      expect(await toolkitStatus()).toBe("CREATE_COMPLETE");

      const res = await get(`${urlFrom(r.stdout)}/`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ message: "hello from flarelet" });
    },
    LONG,
  );

  it(
    "bootstrap aws does nothing when already bootstrapped",
    async () => {
      const before = await bootstrapParam();
      const r = await cli(["bootstrap", "aws"], dir!, "", REGION);
      log(`bootstrap aws (again): exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(
        `${account}/${REGION} is already bootstrapped (version ${before})`,
      );
      expect(r.stdout).not.toContain("deploying CDKToolkit");
      expect(await toolkitStatus()).toBe("CREATE_COMPLETE");
    },
    LONG,
  );
});

async function stackExists(name: string): Promise<boolean> {
  try {
    const s = (await cfn.send(new DescribeStacksCommand({ StackName: name }))).Stacks?.[0];
    return s !== undefined && s.StackStatus !== "DELETE_COMPLETE";
  } catch (e) {
    if (/does not exist/.test(errText(e))) return false;
    throw e;
  }
}
