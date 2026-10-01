import { createHash } from "node:crypto";
import { App, CfnOutput, Duration, Stack } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";

/** GitHub Actions の OIDC プロバイダ。 */
export const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
export const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;
/** プロバイダを Flareon が作った場合だけ存在するスタック（役割ごとのスタックとは別に所有を分ける）。 */
export const PROVIDER_STACK = "flareon-bootstrap-github-provider";

export interface Repo {
  owner: string;
  name: string;
}

/** owner/name。信頼ポリシーの sub 条件に埋め込むので、ワイルドカード等が入る形は拒否する。 */
export function parseRepo(s: string): Repo {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  if (!m) throw new Error(`invalid repository "${s}" (use owner/name, e.g. youyo/myapp)`);
  return { owner: m[1]!, name: m[2]! };
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export const providerArn = (account: string): string =>
  `arn:aws:iam::${account}:oidc-provider/${GITHUB_OIDC_HOST}`;

export const roleStackName = (r: Repo): string =>
  `flareon-bootstrap-github-${slug(r.owner)}-${slug(r.name)}`;

/** IAM ロール名（64 文字以内）。長い場合は末尾にハッシュを付けて一意にする。 */
export function roleName(r: Repo): string {
  const base = `flareon-github-${slug(r.owner)}-${slug(r.name)}`;
  if (base.length <= 64) return base;
  const hash = createHash("sha256").update(`${r.owner}/${r.name}`).digest("hex").slice(0, 8);
  return `${base.slice(0, 55).replace(/-+$/, "")}-${hash}`;
}

export interface GithubBootstrapSpec {
  repo: Repo;
  account: string;
  region: string;
  /** CDK bootstrap のクオリファイア。 */
  qualifier: string;
  /** アカウントに GitHub OIDC プロバイダが無いときだけ true（別スタックで作る）。 */
  createProvider: boolean;
  outdir: string;
}

export interface BootstrapStack {
  name: string;
  kind: "provider" | "role";
}

/** CI ロールの権限。CDK bootstrap ロールの assume と、flareon CLI が直接呼ぶ読み取り系 API に絞る。 */
function rolePolicy(account: string, region: string, qualifier: string): iam.PolicyStatement[] {
  const cdkRole = (kind: string): string =>
    `arn:aws:iam::${account}:role/cdk-${qualifier}-${kind}-role-${account}-${region}`;
  const stack = (pattern: string): string =>
    `arn:aws:cloudformation:${region}:${account}:stack/${pattern}/*`;
  return [
    // デプロイは CDK bootstrap のロールに委譲する
    new iam.PolicyStatement({
      sid: "AssumeCdkBootstrapRoles",
      actions: ["sts:AssumeRole"],
      resources: ["deploy", "file-publishing", "image-publishing", "lookup"].map(cdkRole),
    }),
    new iam.PolicyStatement({
      sid: "PassCdkCloudFormationExecutionRole",
      actions: ["iam:PassRole"],
      resources: [cdkRole("cfn-exec")],
      conditions: { StringEquals: { "iam:PassedToService": "cloudformation.amazonaws.com" } },
    }),
    // CLI が参照する CloudFormation（env list / logs / plan / env url など）。読み取りのみ
    new iam.PolicyStatement({
      sid: "ReadCloudFormation",
      actions: [
        "cloudformation:DescribeStacks",
        "cloudformation:DescribeStackEvents",
        "cloudformation:DescribeStackResources",
        "cloudformation:GetTemplate",
        "cloudformation:GetTemplateSummary",
        "cloudformation:ListStackResources",
      ],
      resources: ["*"],
      conditions: { StringEquals: { "aws:RequestedRegion": region } },
    }),
    // destroy（PR プレビューの削除）。Flareon のアプリスタックだけ
    new iam.PolicyStatement({
      sid: "DeleteFlareonStacks",
      actions: ["cloudformation:DeleteStack"],
      resources: [stack("flareon-*")],
    }),
    new iam.PolicyStatement({
      sid: "ProtectBootstrapStacks",
      effect: iam.Effect.DENY,
      actions: ["cloudformation:DeleteStack", "cloudformation:UpdateStack"],
      resources: [stack("flareon-bootstrap-*")],
    }),
    // secrets は読み取りのみ（値の書き込みは人が flareon secret set で行う）
    new iam.PolicyStatement({
      sid: "ReadFlareonSecrets",
      actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:GetParametersByPath"],
      resources: [
        `arn:aws:ssm:${region}:${account}:parameter/flareon/*`,
        `arn:aws:ssm:${region}:${account}:parameter/cdk-bootstrap/${qualifier}/version`,
      ],
    }),
    // PR プレビューの Preview Auth トークン（flareon:app タグ付きのシークレットだけ）
    new iam.PolicyStatement({
      sid: "ReadPreviewTokens",
      actions: ["secretsmanager:GetSecretValue"],
      resources: [`arn:aws:secretsmanager:${region}:${account}:secret:*`],
      conditions: { Null: { "aws:ResourceTag/flareon:app": "false" } },
    }),
    // flareon logs
    new iam.PolicyStatement({
      sid: "ReadLogs",
      actions: ["logs:FilterLogEvents", "logs:GetLogEvents", "logs:StartLiveTail"],
      resources: [
        `arn:aws:logs:${region}:${account}:log-group:*`,
        `arn:aws:logs:${region}:${account}:log-group:*:*`,
      ],
    }),
  ];
}

/** GitHub OIDC 用 CI ロール（と、必要ならプロバイダ）の Cloud Assembly を outdir に書き出す。 */
export function synthGithubBootstrap(spec: GithubBootstrapSpec): {
  outdir: string;
  stacks: BootstrapStack[];
} {
  const { repo, account, region, qualifier } = spec;
  const app = new App({ outdir: spec.outdir, analyticsReporting: false });
  const env = { account, region };
  const stacks: BootstrapStack[] = [];

  let providerStack: Stack | undefined;
  if (spec.createProvider) {
    providerStack = new Stack(app, PROVIDER_STACK, {
      env,
      description: "Flareon: GitHub Actions OIDC provider (created because the account had none)",
      tags: { "flareon:bootstrap": "github-oidc-provider" },
    });
    new iam.CfnOIDCProvider(providerStack, "GithubOidc", {
      url: GITHUB_OIDC_URL,
      clientIdList: ["sts.amazonaws.com"],
    });
    stacks.push({ name: PROVIDER_STACK, kind: "provider" });
  }

  const name = roleStackName(repo);
  const stack = new Stack(app, name, {
    env,
    description: `Flareon: CI role assumable by GitHub Actions of ${repo.owner}/${repo.name}`,
    tags: {
      "flareon:bootstrap": "github-role",
      "flareon:repo": `${repo.owner}/${repo.name}`,
    },
  });
  if (providerStack) stack.addDependency(providerStack);
  const role = new iam.Role(stack, "Role", {
    roleName: roleName(repo),
    description: `Flareon CI role for GitHub repository ${repo.owner}/${repo.name}`,
    maxSessionDuration: Duration.hours(1),
    assumedBy: new iam.WebIdentityPrincipal(providerArn(account), {
      StringEquals: { [`${GITHUB_OIDC_HOST}:aud`]: "sts.amazonaws.com" },
      StringLike: { [`${GITHUB_OIDC_HOST}:sub`]: `repo:${repo.owner}/${repo.name}:*` },
    }),
  });
  for (const s of rolePolicy(account, region, qualifier)) role.addToPolicy(s);
  new CfnOutput(stack, "RoleArn", { value: role.roleArn });
  new CfnOutput(stack, "RoleName", { value: role.roleName });
  stacks.push({ name, kind: "role" });

  app.synth();
  return { outdir: spec.outdir, stacks };
}
