// F1: cognito ネイティブの User Pool は email 変更を検証完了まで反映しない（keepOriginal）。
// F4: セッション世代の SSM パラメータと、front Lambda がそれだけを読める権限。
import type { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { conceptOf } from "../../src/aws/concepts.js";
import { parseConfig } from "../../src/config/index.js";
import { buildApp, sessionEpochParam } from "../../src/constructs/index.js";
import { toIR } from "../../src/ir/index.js";
import type { Deployment } from "../../src/resolver/index.js";

const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};
const prod: Deployment = { stage: "prod", version: "v1", lifecycle: "persistent" };
const pr: Deployment = { stage: "preview", version: "pr-7", lifecycle: "ephemeral" };
const build = (yaml: string, d: Deployment) =>
  buildApp({
    ir: ir(yaml),
    deployment: d,
    region: "ap-northeast-1",
    code: {
      app: lambda.Code.fromInline("def handler(e, c): pass"),
      front: lambda.Code.fromInline("exports.handler = async () => ({})"),
    },
  });

const base = "version: 1\nname: myapp\nruntime: { language: python }\n";
const COGNITO = `${base}http: true\n`;
const GOOGLE = `${base}http:\n  auth:\n    provider: google\n`;
const OIDC = `${base}http:\n  auth:\n    provider: oidc\n    issuer: https://idp.example.com\n`;
const ENTRA = `${base}http:\n  auth:\n    provider: entra\n    tenant: 72f988bf-86f1-41af-91ab-2d7cd011db47\n`;
const PUBLIC = `${base}http:\n  auth: false\ndatabase: { main: {} }\n`;

const pool = (stage: Stack) =>
  Object.values(Template.fromStack(stage).findResources("AWS::Cognito::UserPool"))[0]!
    .Properties as Record<string, unknown>;

const front = (version: Stack) => {
  const fns = Template.fromStack(version).findResources("AWS::Lambda::Function");
  return Object.values(fns).find((f) => JSON.stringify(f).includes("FLARELET_AUTH_MODE")) as {
    Properties: { Environment: { Variables: Record<string, unknown> } };
  };
};

/** FrontRole / AppRole に付いたポリシー文。 */
const statements = (version: Stack, role: "FrontRole" | "AppRole") => {
  const policies = Template.fromStack(version).findResources("AWS::IAM::Policy");
  return Object.values(policies)
    .filter((p) => JSON.stringify(p.Properties.Roles).includes(role))
    .flatMap((p) => p.Properties.PolicyDocument.Statement as Record<string, unknown>[]);
};

describe("F1: cognito-native pools keep the original email until the new one is verified", () => {
  it("cognito: AttributesRequireVerificationBeforeUpdate=email (email is auto-verified)", () => {
    const p = pool(build(COGNITO, prod).stage!);
    expect(p.UserAttributeUpdateSettings).toEqual({
      AttributesRequireVerificationBeforeUpdate: ["email"],
    });
    expect(p.AutoVerifiedAttributes).toEqual(["email"]);
  });

  it.each([
    ["google", GOOGLE],
    ["oidc", OIDC],
    ["entra", ENTRA],
  ])("%s: federated pools are unchanged (the IdP owns the email)", (_n, yaml) => {
    expect(pool(build(yaml, prod).stage!)).not.toHaveProperty("UserAttributeUpdateSettings");
  });
});

describe("F4: session epoch parameter", () => {
  it("names are stage scoped for persistent stages and version scoped for PR previews", () => {
    expect(sessionEpochParam("myapp", prod)).toBe("/flarelet/myapp/prod/auth/session-epoch");
    expect(sessionEpochParam("myapp", pr)).toBe("/flarelet/myapp/preview/auth/pr-7/session-epoch");
    // 永続 stage の secrets（アプリが GetParametersByPath で読むパス）とは別
    expect(sessionEpochParam("myapp", prod)).not.toContain("/secrets/");
  });

  it("persistent: the stage stack owns a String parameter, and only the front can read it", () => {
    const { stage, version } = build(COGNITO, prod);
    Template.fromStack(stage!).hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/flarelet/myapp/prod/auth/session-epoch",
      Type: "String",
    });
    Template.fromStack(stage!).hasResource("AWS::SSM::Parameter", { DeletionPolicy: "Delete" });
    Template.fromStack(version).resourceCountIs("AWS::SSM::Parameter", 0);
    // 名前はリテラルで渡す（クロススタック Export を作らない）
    expect(front(version).Properties.Environment.Variables.FLARELET_SESSION_EPOCH_PARAM).toBe(
      "/flarelet/myapp/prod/auth/session-epoch",
    );
    const ssm = statements(version, "FrontRole").filter((s) =>
      JSON.stringify(s.Action).includes("ssm:"),
    );
    expect(ssm).toHaveLength(1);
    expect(ssm[0]!.Action).toBe("ssm:GetParameter");
    expect(JSON.stringify(ssm[0]!.Resource)).toContain(
      ":parameter/flarelet/myapp/prod/auth/session-epoch",
    );
    expect(JSON.stringify(statements(version, "AppRole"))).not.toContain("session-epoch");
  });

  it("PR preview: the preview stack owns its own parameter", () => {
    const { stage, version } = build(COGNITO, pr);
    expect(stage).toBeUndefined();
    Template.fromStack(version).hasResourceProperties("AWS::SSM::Parameter", {
      Name: "/flarelet/myapp/preview/auth/pr-7/session-epoch",
      Type: "String",
    });
    expect(front(version).Properties.Environment.Variables.FLARELET_SESSION_EPOCH_PARAM).toBe(
      "/flarelet/myapp/preview/auth/pr-7/session-epoch",
    );
  });

  it("public persistent stages (auth: false) have no parameter", () => {
    const { stage, version } = build(PUBLIC, prod);
    Template.fromStack(stage!).resourceCountIs("AWS::SSM::Parameter", 0);
    Template.fromStack(version).resourceCountIs("AWS::SSM::Parameter", 0);
  });

  it("is reported as authentication in plan / deploy", () => {
    expect(conceptOf("flarelet-a-prod/SessionEpoch/Resource")).toBe("authentication");
  });
});
