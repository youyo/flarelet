// H-4 永続データ保護 / H-1 アクセスログ + front JSON ログ / M-1 スロットリング既定値
import type { Stack } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { buildApp } from "../../src/constructs/index.js";
import { buildDevApp } from "../../src/constructs/dev.js";
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
const data = "database: { main: {} }\nstorage: { files: {} }\n";
const YAML = `${base}http: true\n${data}`;
const t = (s: Stack) => Template.fromStack(s);

describe("H-4: persistent data protection", () => {
  it("persistent stage: bucket versioned + lifecycle, table deletion protection", () => {
    const stage = build(YAML, prod).stage!;
    t(stage).hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: { Status: "Enabled" },
      LifecycleConfiguration: {
        Rules: [
          Match.objectLike({
            Status: "Enabled",
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          }),
        ],
      },
    });
    t(stage).hasResourceProperties("AWS::DynamoDB::Table", { DeletionProtectionEnabled: true });
  });

  it("PR preview: no versioning, no deletion protection", () => {
    const { version } = build(YAML, pr);
    t(version).hasResourceProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: Match.absent(),
    });
    t(version).hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: Match.absent(),
      LifecycleConfiguration: Match.absent(),
    });
  });

  it("dev stack: no versioning, no deletion protection", () => {
    const { stack } = buildDevApp({
      ir: ir(YAML),
      deployment: { stage: "preview", version: "local-x", lifecycle: "ephemeral" },
      region: "ap-northeast-1",
    } as never);
    t(stack).hasResourceProperties("AWS::DynamoDB::Table", {
      DeletionProtectionEnabled: Match.absent(),
    });
    t(stack).hasResourceProperties("AWS::S3::Bucket", {
      VersioningConfiguration: Match.absent(),
    });
  });
});

describe("H-1: HTTP API access logs and front JSON logs", () => {
  it.each([
    ["prod", prod],
    ["pr", pr],
  ] as const)("%s: access log destination + JSON format limited to safe fields", (_n, d) => {
    const v = build(YAML, d).version;
    const stages = Object.values(t(v).findResources("AWS::ApiGatewayV2::Stage"));
    expect(stages).toHaveLength(1);
    const als = stages[0]!.Properties.AccessLogSettings;
    expect(als.DestinationArn).toBeDefined();
    const fmt = JSON.parse(als.Format) as Record<string, string>;
    expect(Object.keys(fmt).sort()).toEqual(
      [
        "requestId",
        "ip",
        "requestTime",
        "httpMethod",
        "routeKey",
        "path",
        "status",
        "protocol",
        "responseLength",
        "responseLatency",
        "integrationLatency",
        "integrationErrorMessage",
      ].sort(),
    );
    expect(fmt.ip).toBe("$context.identity.sourceIp");
    expect(fmt.path).toBe("$context.path");
    expect(als.Format).not.toMatch(/authorizer|claims|header|querystring|cookie/i);
    // 宛先はこのスタックの ONE_MONTH / DESTROY のロググループ
    const groups = Object.values(t(v).findResources("AWS::Logs::LogGroup"));
    const access = groups.filter((g) => g.Properties.RetentionInDays === 30);
    expect(access.length).toBeGreaterThanOrEqual(3); // AppLogs, FrontLogs, ApiAccessLogs
    for (const g of groups) expect(g.DeletionPolicy).toBe("Delete");
    expect(JSON.stringify(als.DestinationArn)).toContain("ApiAccessLogs");
  });

  it("front Lambda logs JSON; app Lambda does not", () => {
    const v = build(YAML, prod).version;
    const fns = Object.values(t(v).findResources("AWS::Lambda::Function")) as {
      Properties: { Environment?: { Variables: Record<string, unknown> }; LoggingConfig?: unknown };
    }[];
    const frontFn = fns.find(
      (f) => "FLARELET_AUTH_MODE" in (f.Properties.Environment?.Variables ?? {}),
    )!;
    const appFn = fns.find(
      (f) => !("FLARELET_AUTH_MODE" in (f.Properties.Environment?.Variables ?? {})),
    )!;
    expect(frontFn.Properties.LoggingConfig).toMatchObject({ LogFormat: "JSON" });
    expect(JSON.stringify(appFn.Properties.LoggingConfig)).not.toContain("JSON");
  });
});

describe("M-1: HTTP API throttling", () => {
  const route = (v: Stack) =>
    Object.values(t(v).findResources("AWS::ApiGatewayV2::Stage"))[0]!.Properties
      .DefaultRouteSettings;

  it("persistent default 1000/2000", () => {
    expect(route(build(YAML, prod).version)).toEqual({
      ThrottlingRateLimit: 1000,
      ThrottlingBurstLimit: 2000,
    });
  });
  it("PR preview default 100/200", () => {
    expect(route(build(YAML, pr).version)).toEqual({
      ThrottlingRateLimit: 100,
      ThrottlingBurstLimit: 200,
    });
  });
  it("yaml override applies to both lifecycles", () => {
    const y = `${base}http: { throttle: { rate: 50, burst: 75 } }\n`;
    for (const d of [prod, pr]) {
      expect(route(build(y, d).version)).toEqual({
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 75,
      });
    }
  });
  it("throttle: false disables", () => {
    const y = `${base}http: { throttle: false }\n`;
    for (const d of [prod, pr]) expect(route(build(y, d).version)).toBeUndefined();
  });
});
