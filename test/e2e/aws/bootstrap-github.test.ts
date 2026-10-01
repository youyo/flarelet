// flareon bootstrap github: テスト用リポジトリ名でロールを作成 → 信頼ポリシーと権限を検証 → 削除。
// アカウントに既存の GitHub OIDC プロバイダ（他用途）は作り直さない・消さない・変更しない。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  IAMClient,
  ListOpenIDConnectProvidersCommand,
  ListRolePoliciesCommand,
  GetRolePolicyCommand,
  SimulatePrincipalPolicyCommand,
  type ContextEntry,
} from "@aws-sdk/client-iam";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, ENABLED, log, LONG, REGION, stackOutputs } from "./helpers.js";
import { awsCloud } from "../../../src/aws/real.js";
import {
  PROVIDER_STACK,
  parseRepo,
  roleName,
  roleStackName,
} from "../../../src/bootstrap/github.js";

const iam = new IAMClient({ region: REGION });
const HOST = "token.actions.githubusercontent.com";

/** IAM ポリシーシミュレータでロールの判定（allowed / implicitDeny / explicitDeny）を得る。 */
async function decide(
  roleArn: string,
  action: string,
  resource: string,
  tags: Record<string, string> = {},
): Promise<string | undefined> {
  const ContextEntries: ContextEntry[] = Object.entries(tags).map(([k, v]) => ({
    ContextKeyName: `aws:ResourceTag/${k}`,
    ContextKeyType: "string",
    ContextKeyValues: [v],
  }));
  const out = await iam.send(
    new SimulatePrincipalPolicyCommand({
      PolicySourceArn: roleArn,
      ActionNames: [action],
      ResourceArns: [resource],
      ContextEntries,
    }),
  );
  return out.EvaluationResults?.[0]?.EvalDecision;
}

async function providerSnapshot() {
  const list = await iam.send(new ListOpenIDConnectProvidersCommand({}));
  const arn = list.OpenIDConnectProviderList?.find((p) => p.Arn?.endsWith(`/${HOST}`))?.Arn;
  if (!arn) return undefined;
  const p = await iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: arn }));
  return {
    arn,
    url: p.Url,
    clients: [...(p.ClientIDList ?? [])].sort(),
    thumbprints: [...(p.ThumbprintList ?? [])].sort(),
    created: p.CreateDate?.toISOString(),
  };
}

describe.runIf(ENABLED)("real AWS: bootstrap github", () => {
  const slug = `flareon-e2e/r${randomBytes(3).toString("hex")}`;
  const repo = parseRepo(slug);
  const stack = roleStackName(repo);
  let dir: string;
  let before: Awaited<ReturnType<typeof providerSnapshot>>;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "flareon-bs-e2e-"));
    before = await providerSnapshot();
    log(`OIDC provider before: ${before ? before.arn : "none"}`);
  });

  afterAll(async () => {
    try {
      // 安全網: テスト用スタックだけを消す
      if (await stackOutputs(stack)) {
        log(`safety net: deleting ${stack}`);
        await awsCloud(REGION).deleteStack(stack, () => {});
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    expect(await stackOutputs(stack), "role stack left over").toBeUndefined();
    const after = await providerSnapshot();
    expect(after, "OIDC provider must be exactly as before").toEqual(before);
  }, LONG);

  it(
    "creates a role only that repository can assume, then removes it",
    async () => {
      const r = await cli(["bootstrap", "github", "--repo", slug], dir);
      log(`bootstrap ${slug}: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      const arn = /Role ARN: (\S+)/.exec(r.stdout)?.[1];
      expect(arn).toBeDefined();
      expect(r.stdout).toContain(
        `gh variable set FLAREON_AWS_ROLE_ARN --repo ${slug} --body ${arn}`,
      );
      if (before) {
        expect(r.stdout).toContain("reusing");
        // 既存プロバイダがある場合、Flareon のプロバイダスタックは作られない
        expect(await stackOutputs(PROVIDER_STACK)).toBeUndefined();
      }

      const role = await iam.send(new GetRoleCommand({ RoleName: roleName(repo) }));
      expect(role.Role?.Arn).toBe(arn);
      const trust = JSON.parse(decodeURIComponent(role.Role!.AssumeRolePolicyDocument as string));
      const st = trust.Statement[0];
      expect(st.Effect).toBe("Allow");
      expect(st.Action).toBe("sts:AssumeRoleWithWebIdentity");
      expect(st.Principal.Federated).toMatch(new RegExp(`oidc-provider/${HOST}$`));
      expect(st.Condition.StringEquals[`${HOST}:aud`]).toBe("sts.amazonaws.com");
      expect(st.Condition.StringLike[`${HOST}:sub`]).toBe(`repo:${slug}:*`);
      expect(trust.Statement).toHaveLength(1);
      expect(role.Role?.MaxSessionDuration).toBe(3600);

      const names = (await iam.send(new ListRolePoliciesCommand({ RoleName: roleName(repo) })))
        .PolicyNames!;
      expect(names).toHaveLength(1);
      const pol = await iam.send(
        new GetRolePolicyCommand({ RoleName: roleName(repo), PolicyName: names[0]! }),
      );
      const doc = JSON.parse(decodeURIComponent(pol.PolicyDocument as string));
      const actions: string[] = doc.Statement.filter(
        (s: { Effect: string }) => s.Effect === "Allow",
      ).flatMap((s: { Action: string | string[] }) =>
        Array.isArray(s.Action) ? s.Action : [s.Action],
      );
      expect(actions.some((a) => a.includes("*"))).toBe(false);
      expect(actions).toContain("sts:AssumeRole");
      log(`role policy actions: ${actions.join(", ")}`);

      // 実際の評価（IAM ポリシーシミュレータ）: PR preview のシークレット・スタック・Flareon のロググループだけ
      const acct = arn!.split(":")[4]!;
      const secret = `arn:aws:secretsmanager:${REGION}:${acct}:secret:SessionSecretX-AbCdEf`;
      const sm = "secretsmanager:GetSecretValue";
      expect(
        await decide(arn!, sm, secret, {
          "flareon:stage": "preview",
          "flareon:lifecycle": "ephemeral",
        }),
      ).toBe("allowed");
      // 永続 stage の Cookie 署名鍵（prod、preview/current）は読めない
      expect(await decide(arn!, sm, secret, { "flareon:stage": "prod" })).not.toBe("allowed");
      expect(await decide(arn!, sm, secret, { "flareon:stage": "preview" })).not.toBe("allowed");
      expect(await decide(arn!, sm, secret, { "flareon:app": "x" })).not.toBe("allowed");
      const stackArn = (n: string) =>
        `arn:aws:cloudformation:${REGION}:${acct}:stack/${n}/00000000-0000-0000-0000-000000000000`;
      const delStack = "cloudformation:DeleteStack";
      expect(await decide(arn!, delStack, stackArn("flareon-myapp-preview-pr-12"))).toBe("allowed");
      expect(await decide(arn!, delStack, stackArn("flareon-myapp-prod-current"))).not.toBe(
        "allowed",
      );
      expect(await decide(arn!, delStack, stackArn("flareon-myapp-prod"))).not.toBe("allowed");
      expect(await decide(arn!, delStack, stackArn("flareon-myapp-preview-current"))).not.toBe(
        "allowed",
      );
      expect(await decide(arn!, delStack, stackArn(stack))).not.toBe("allowed");
      const group = (n: string) => `arn:aws:logs:${REGION}:${acct}:log-group:${n}`;
      const lg = "flareon-myapp-prod-current-AppLogsABC-xyz";
      expect(await decide(arn!, "logs:StartLiveTail", group(lg))).toBe("allowed");
      expect(await decide(arn!, "logs:FilterLogEvents", `${group(lg)}:*`)).toBe("allowed");
      expect(await decide(arn!, "logs:StartLiveTail", group("/aws/lambda/other"))).not.toBe(
        "allowed",
      );
      expect(await decide(arn!, "logs:FilterLogEvents", `${group("other-app")}:*`)).not.toBe(
        "allowed",
      );

      // 再実行は冪等（変更なしで成功する）
      const again = await cli(["bootstrap", "github", "--repo", slug], dir);
      expect(again.code, again.stderr).toBe(0);

      const del = await cli(["bootstrap", "github", "--repo", slug, "--destroy"], dir);
      log(`bootstrap --destroy ${slug}: exit ${del.code} in ${del.ms}ms`);
      expect(del.code, del.stderr + del.stdout).toBe(0);
      expect(await stackOutputs(stack)).toBeUndefined();
      await expect(
        iam.send(new GetRoleCommand({ RoleName: roleName(repo) })),
      ).rejects.toMatchObject({ name: "NoSuchEntityException" });
      if (before) expect(del.stdout).not.toContain(PROVIDER_STACK);
    },
    LONG,
  );
});
