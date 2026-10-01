/* eslint-disable @typescript-eslint/no-explicit-any -- 生成された JSON/YAML を緩く検査する */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GITHUB_OIDC_URL,
  PROVIDER_STACK,
  parseRepo,
  providerArn,
  roleName,
  roleStackName,
  synthGithubBootstrap,
} from "../../src/bootstrap/github.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("parseRepo", () => {
  it("accepts owner/name", () => {
    expect(parseRepo("youyo/flareon")).toEqual({ owner: "youyo", name: "flareon" });
    expect(parseRepo("a-b/c_d.e")).toEqual({ owner: "a-b", name: "c_d.e" });
  });
  it("rejects anything that could widen the trust condition", () => {
    for (const bad of [
      "",
      "x",
      "a/b/c",
      "a/*",
      "*/b",
      "a/b*",
      "a /b",
      "a/b:*",
      "a/b?",
      "/b",
      "a/",
    ]) {
      expect(() => parseRepo(bad), bad).toThrow(/owner\/name/);
    }
  });
});

describe("names", () => {
  it("derives stack and role names", () => {
    expect(roleStackName({ owner: "youyo", name: "my.repo_x" })).toBe(
      "flareon-bootstrap-github-youyo-my-repo-x",
    );
    expect(providerArn("123456789012")).toBe(
      "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
    );
    expect(GITHUB_OIDC_URL).toBe("https://token.actions.githubusercontent.com");
  });
  it("keeps the IAM role name within 64 chars and unique", () => {
    const a = roleName({ owner: "o".repeat(39), name: "n".repeat(60) });
    const b = roleName({ owner: "o".repeat(39), name: "n".repeat(59) + "m" });
    expect(a.length).toBeLessThanOrEqual(64);
    expect(a).not.toBe(b);
  });
});

async function synth(createProvider: boolean) {
  dir = await mkdtemp(join(tmpdir(), "flareon-bs-"));
  const r = synthGithubBootstrap({
    repo: { owner: "youyo", name: "flareon" },
    account: "123456789012",
    region: "ap-northeast-1",
    qualifier: "hnb659fds",
    createProvider,
    outdir: dir,
  });
  const tpl = async (name: string) =>
    JSON.parse(await readFile(join(dir!, `${name}.template.json`), "utf8")) as {
      Resources: Record<string, any>;
      Outputs: Record<string, any>;
    };
  return { r, tpl };
}

const byType = (t: { Resources: Record<string, any> }, type: string) =>
  Object.values(t.Resources).filter((x) => x.Type === type);

describe("synthGithubBootstrap", () => {
  it("creates only the role stack when the OIDC provider already exists", async () => {
    const { r, tpl } = await synth(false);
    expect(r.stacks).toEqual([{ name: "flareon-bootstrap-github-youyo-flareon", kind: "role" }]);
    const t = await tpl("flareon-bootstrap-github-youyo-flareon");
    expect(byType(t, "AWS::IAM::OIDCProvider")).toHaveLength(0);
    const [role] = byType(t, "AWS::IAM::Role");
    const stmt = role.Properties.AssumeRolePolicyDocument.Statement[0];
    expect(stmt.Action).toBe("sts:AssumeRoleWithWebIdentity");
    expect(stmt.Principal.Federated).toBe(
      "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com",
    );
    expect(stmt.Condition).toEqual({
      StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      StringLike: { "token.actions.githubusercontent.com:sub": "repo:youyo/flareon:*" },
    });
    expect(role.Properties.MaxSessionDuration).toBe(3600);
    expect(t.Outputs.RoleArn).toBeDefined();
  });

  it("also creates the OIDC provider stack (and orders it first) when none exists", async () => {
    const { r, tpl } = await synth(true);
    expect(r.stacks).toEqual([
      { name: PROVIDER_STACK, kind: "provider" },
      { name: "flareon-bootstrap-github-youyo-flareon", kind: "role" },
    ]);
    const p = await tpl(PROVIDER_STACK);
    const [prov] = byType(p, "AWS::IAM::OIDCProvider");
    expect(prov.Properties.Url).toBe("https://token.actions.githubusercontent.com");
    expect(prov.Properties.ClientIdList).toEqual(["sts.amazonaws.com"]);
    const manifest = JSON.parse(await readFile(join(dir!, "manifest.json"), "utf8"));
    expect(manifest.artifacts["flareon-bootstrap-github-youyo-flareon"].dependencies).toContain(
      PROVIDER_STACK,
    );
  });

  it("grants least-privilege permissions", async () => {
    const { tpl } = await synth(false);
    const t = await tpl("flareon-bootstrap-github-youyo-flareon");
    const [policy] = byType(t, "AWS::IAM::Policy");
    const stmts: any[] = policy.Properties.PolicyDocument.Statement;
    const allows = stmts.filter((s) => s.Effect === "Allow");
    const actions = allows.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    // ワイルドカードのアクション（iam:*, s3:* など）を持たない
    expect(actions.filter((a: string) => a.includes("*"))).toEqual([]);
    expect(actions).toEqual(
      expect.arrayContaining([
        "sts:AssumeRole",
        "cloudformation:DescribeStacks",
        "cloudformation:DeleteStack",
        "ssm:GetParametersByPath",
        "secretsmanager:GetSecretValue",
        "logs:FilterLogEvents",
        "logs:StartLiveTail",
        "iam:PassRole",
      ]),
    );
    expect(actions).not.toContain("ssm:PutParameter");
    expect(actions).not.toContain("secretsmanager:DeleteSecret");
    const assume = allows.find((s) => s.Action === "sts:AssumeRole");
    expect(JSON.stringify(assume.Resource)).toContain(
      "cdk-hnb659fds-deploy-role-123456789012-ap-northeast-1",
    );
    expect(JSON.stringify(assume.Resource)).toContain("file-publishing-role");
    const pass = allows.find((s) => s.Action === "iam:PassRole");
    expect(pass.Condition.StringEquals["iam:PassedToService"]).toBe("cloudformation.amazonaws.com");
    // bootstrap スタック自身は削除・変更できない
    const deny = stmts.find((s) => s.Effect === "Deny");
    expect(deny.Action).toContain("cloudformation:DeleteStack");
    expect(JSON.stringify(deny.Resource)).toContain("stack/flareon-bootstrap-*/*");
    // CI が消すのは PR preview だけ（destroy --ci は PR closed のみ）。永続 stage / version は消せない
    const del = allows.find((s) => s.Action === "cloudformation:DeleteStack");
    expect(del.Resource).toEqual(
      "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/flareon-*-preview-pr-*/*",
    );
  });

  it("reads only PR preview secrets (never a persistent stage's cookie signing key)", async () => {
    const { tpl } = await synth(false);
    const t = await tpl("flareon-bootstrap-github-youyo-flareon");
    const [policy] = byType(t, "AWS::IAM::Policy");
    const stmts: any[] = policy.Properties.PolicyDocument.Statement;
    const read = stmts.find((s) => s.Sid === "ReadPreviewTokens");
    expect(read.Action).toBe("secretsmanager:GetSecretValue");
    expect(read.Condition).toEqual({
      StringEquals: {
        "aws:ResourceTag/flareon:stage": "preview",
        "aws:ResourceTag/flareon:lifecycle": "ephemeral",
      },
    });
  });

  it("reads only Flareon's Lambda log groups", async () => {
    const { tpl } = await synth(false);
    const t = await tpl("flareon-bootstrap-github-youyo-flareon");
    const [policy] = byType(t, "AWS::IAM::Policy");
    const stmts: any[] = policy.Properties.PolicyDocument.Statement;
    const logs = stmts.find((s) => s.Sid === "ReadLogs");
    // ロググループ名は CloudFormation の自動命名（スタック名 = flareon-<app>-... から始まる）
    expect(logs.Resource).toEqual([
      "arn:aws:logs:ap-northeast-1:123456789012:log-group:flareon-*",
      "arn:aws:logs:ap-northeast-1:123456789012:log-group:flareon-*:*",
    ]);
  });

  it("tags the stacks so they can be found and owned", async () => {
    const { r } = await synth(true);
    const manifest = JSON.parse(await readFile(join(dir!, "manifest.json"), "utf8"));
    const tags = manifest.artifacts["flareon-bootstrap-github-youyo-flareon"].properties.tags;
    expect(tags).toMatchObject({
      "flareon:bootstrap": "github-role",
      "flareon:repo": "youyo/flareon",
    });
    expect(manifest.artifacts[PROVIDER_STACK].properties.tags).toMatchObject({
      "flareon:bootstrap": "github-oidc-provider",
    });
    expect(r.stacks).toHaveLength(2);
  });
});
