// deploy / logs / env / auth user 等の運用コマンドが依存するスタックの契約（Outputs・タグ・ロググループ）
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { buildApp, type BuildOptions } from "../../src/constructs/index.js";
import { toIR } from "../../src/ir/index.js";
import type { Deployment } from "../../src/resolver/index.js";

const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};

const FULL = `version: 1
name: myapp
runtime: { language: python, version: "3.13" }
http: true
database: { main: {} }
`;
const OPEN = `version: 1
name: myapp
runtime: { language: typescript }
http: { auth: false }
`;

const prod: Deployment = { stage: "prod", version: "v1", lifecycle: "persistent" };
const pr: Deployment = { stage: "preview", version: "pr-7", lifecycle: "ephemeral" };

function build(yaml: string, deployment: Deployment, extra: Partial<BuildOptions> = {}) {
  return buildApp({
    ir: ir(yaml),
    deployment,
    region: "ap-northeast-1",
    code: {
      app: lambda.Code.fromInline("def handler(e, c): pass"),
      front: lambda.Code.fromInline("exports.handler = async () => ({})"),
    },
    ...extra,
  });
}

describe("version stack tags", () => {
  it("records lifecycle and the Git source branch (sanitized for tag values)", () => {
    const { version } = build(FULL, prod, { source: "release/v1" });
    expect(version.tags.tagValues()).toMatchObject({
      "flarelet:lifecycle": "persistent",
      "flarelet:branch": "release/v1",
    });
    const odd = build(FULL, prod, { source: "feat/#12 a*b" }).version;
    expect(odd.tags.tagValues()["flarelet:branch"]).toBe("feat/-12 a-b");
  });

  it("marks PR previews as ephemeral and omits the branch tag when unknown", () => {
    const { version } = build(FULL, pr);
    expect(version.tags.tagValues()["flarelet:lifecycle"]).toBe("ephemeral");
    expect(version.tags.tagValues()).not.toHaveProperty("flarelet:branch");
  });

  it("does not put the branch tag on the shared stage stack", () => {
    const { stage } = build(FULL, prod, { source: "release/v1" });
    expect(stage!.tags.tagValues()).not.toHaveProperty("flarelet:branch");
    expect(stage!.tags.tagValues()).not.toHaveProperty("flarelet:version");
  });
});

describe("log groups", () => {
  it("creates deletable log groups for the app and front Lambdas and outputs them", () => {
    const t = Template.fromStack(build(FULL, prod).version);
    const groups = t.findResources("AWS::Logs::LogGroup");
    expect(Object.keys(groups)).toHaveLength(3); // app / front / API アクセスログ
    for (const g of Object.values(groups) as { DeletionPolicy?: string }[]) {
      expect(g.DeletionPolicy).toBe("Delete");
    }
    t.hasResourceProperties("AWS::Logs::LogGroup", { RetentionInDays: 30 });
    t.hasOutput("AppLogGroup", {});
    t.hasOutput("FrontLogGroup", {});
    t.hasOutput("AppFunctionName", {});
  });

  it("Lambda roles cannot re-create log groups after destroy (no logs:CreateLogGroup)", () => {
    for (const yaml of [FULL, OPEN]) {
      const t = Template.fromStack(build(yaml, prod).version);
      const json = JSON.stringify(t.toJSON());
      expect(json).not.toContain("logs:CreateLogGroup");
      expect(json).not.toContain("AWSLambdaBasicExecutionRole");
      // 自分のロググループへの書き込みだけは許可されている
      expect(json).toContain("logs:PutLogEvents");
    }
  });

  it("has only the app and API access log groups without auth", () => {
    const t = Template.fromStack(build(OPEN, prod).version);
    t.resourceCountIs("AWS::Logs::LogGroup", 2);
    t.hasOutput("AppLogGroup", {});
    expect(t.findOutputs("FrontLogGroup")).toEqual({});
  });
});

describe("auth outputs", () => {
  it("exposes the user pool id from the stage stack", () => {
    const { stage, version } = build(FULL, prod);
    Template.fromStack(stage!).hasOutput("UserPoolId", {});
    Template.fromStack(version).hasOutput("UserPoolId", {});
  });

  it("previews have no user pool output", () => {
    const t = Template.fromStack(build(FULL, pr).version);
    expect(t.findOutputs("UserPoolId")).toEqual({});
    t.hasOutput("PreviewTokenSecretArn", {});
  });
});

describe("construct path metadata", () => {
  it("records aws:cdk:path on every resource (plan diff and deploy progress map it to Flarelet concepts)", () => {
    const { stage, version } = build(FULL, prod);
    for (const s of [stage!, version]) {
      const resources = Template.fromStack(s).toJSON().Resources as Record<
        string,
        { Type: string; Metadata?: Record<string, unknown> }
      >;
      for (const [id, r] of Object.entries(resources)) {
        expect(r.Metadata?.["aws:cdk:path"], `${s.stackName}/${id}`).toEqual(expect.any(String));
      }
    }
  });
});
