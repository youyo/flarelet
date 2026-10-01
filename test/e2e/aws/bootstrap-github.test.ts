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
