import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { isValidVersion, parseConfig } from "../../src/config/index.js";
import { buildDevApp } from "../../src/constructs/dev.js";
import { bindingEntries, pickBindingEnv } from "../../src/dev/bindings.js";
import { devVersion } from "../../src/dev/user.js";
import { toIR } from "../../src/ir/index.js";

const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};

const FULL = `version: 1
name: myapp
runtime: { language: python }
http: true
database: { main: {}, user-sessions: {} }
storage: { files: {} }
ai: { models: [haiku] }
secrets: [API_KEY]
`;

describe("devVersion", () => {
  it.each([
    ["naoto", "local-naoto"],
    ["Naoto.Sato", "local-naoto-sato"],
    ["DOMAIN\\User_Name", "local-domain-user-name"],
    ["--x--", "local-x"],
    ["", "local-dev"],
    ["日本語", "local-dev"],
  ])("%j -> %s", (user, v) => {
    expect(devVersion(user)).toBe(v);
  });

  it("always yields a valid version (max 32 chars)", () => {
    const v = devVersion("a-very-long-user-name-that-keeps-going-on-and-on");
    expect(v.length).toBeLessThanOrEqual(32);
    expect(isValidVersion(v)).toBe(true);
    expect(v.endsWith("-")).toBe(false);
  });
});

describe("bindings", () => {
  it("lists the app's bindings with their environment variable names", () => {
    expect(bindingEntries(ir(FULL))).toEqual([
      { label: "database.main", env: "FLARELET_DATABASE_MAIN_TABLE", stateful: true },
      {
        label: "database.user-sessions",
        env: "FLARELET_DATABASE_USER_SESSIONS_TABLE",
        stateful: true,
      },
      { label: "storage.files", env: "FLARELET_STORAGE_FILES_BUCKET", stateful: true },
      { label: "ai.haiku", env: "FLARELET_AI_HAIKU_MODEL_ID", stateful: false },
    ]);
  });

  it("picks only binding variables from a deployed function's environment", () => {
    expect(
      pickBindingEnv({
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
        PORT: "8080",
        FLARELET_APP: "myapp",
        FLARELET_SECRETS_PATH: "/x/",
        FLARELET_DATABASE_MAIN_TABLE: "t",
        FLARELET_STORAGE_FILES_BUCKET: "b",
        FLARELET_AI_HAIKU_MODEL_ID: "m",
      }),
    ).toEqual({
      FLARELET_DATABASE_MAIN_TABLE: "t",
      FLARELET_STORAGE_FILES_BUCKET: "b",
      FLARELET_AI_HAIKU_MODEL_ID: "m",
    });
  });
});

describe("buildDevApp", () => {
  const d = { stage: "preview", version: "local-naoto", lifecycle: "persistent" as const };

  it("creates one stack with only the stateful bindings, deleted with the stack", () => {
    const { app, stack } = buildDevApp({ ir: ir(FULL), deployment: d, region: "ap-northeast-1" });
    expect(stack.stackName).toBe("flarelet-myapp-preview-local-naoto");
    expect(app.node.children.filter((c) => c.node.id.startsWith("flarelet-"))).toHaveLength(1);
    const t = Template.fromStack(stack);
    t.resourceCountIs("AWS::DynamoDB::Table", 2);
    t.resourceCountIs("AWS::S3::Bucket", 1);
    t.resourceCountIs("AWS::Cognito::UserPool", 0);
    t.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    t.resourceCountIs("AWS::Lambda::Function", 1); // S3 autoDeleteObjects のカスタムリソースのみ
    for (const r of Object.values(t.findResources("AWS::DynamoDB::Table"))) {
      expect(r.DeletionPolicy).toBe("Delete");
    }
    for (const r of Object.values(t.findResources("AWS::S3::Bucket"))) {
      expect(r.DeletionPolicy).toBe("Delete");
    }
  });

  it("outputs the binding values as JSON and tags the stack for env list / destroy", () => {
    const { stack } = buildDevApp({ ir: ir(FULL), deployment: d, region: "ap-northeast-1" });
    const t = Template.fromStack(stack);
    const out = t.findOutputs("Bindings");
    expect(Object.keys(out)).toHaveLength(1);
    const json = JSON.stringify(out);
    for (const k of [
      "FLARELET_DATABASE_MAIN_TABLE",
      "FLARELET_DATABASE_USER_SESSIONS_TABLE",
      "FLARELET_STORAGE_FILES_BUCKET",
    ]) {
      expect(json).toContain(k);
    }
    const tags = Object.fromEntries(
      (stack.tags.renderTags() as { Key: string; Value: string }[]).map((x) => [x.Key, x.Value]),
    );
    expect(tags).toMatchObject({
      "flarelet:app": "myapp",
      "flarelet:stage": "preview",
      "flarelet:version": "local-naoto",
      "flarelet:lifecycle": "dev",
    });
  });
});
