// opt-in の CloudWatch アラーム（alerts.topicArn）。永続 stage のみ。未指定ならテンプレートは変わらない
import type { Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { buildApp } from "../../src/constructs/index.js";
import { buildDevApp } from "../../src/constructs/dev.js";
import { toIR } from "../../src/ir/index.js";
import type { Deployment } from "../../src/resolver/index.js";

const TOPIC = "arn:aws:sns:ap-northeast-1:123456789012:ops-alerts";
const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};
const prod: Deployment = { stage: "prod", version: "v1", lifecycle: "persistent" };
const pr: Deployment = { stage: "preview", version: "pr-7", lifecycle: "ephemeral" };
const build = (yaml: string, d: Deployment, region = "ap-northeast-1") =>
  buildApp({
    ir: ir(yaml),
    deployment: d,
    region,
    account: "123456789012",
    code: {
      app: lambda.Code.fromInline("def handler(e, c): pass"),
      front: lambda.Code.fromInline("exports.handler = async () => ({})"),
    },
  });

const base = "version: 1\nname: myapp\nruntime: { language: python }\n";
const data = "database: { main: {} }\nstorage: { files: {} }\n";
const alerts = `alerts: { topicArn: ${TOPIC} }\n`;
const YAML = `${base}http: true\n${data}`;
const t = (s: Stack) => Template.fromStack(s);
const alarms = (s: Stack) => t(s).findResources("AWS::CloudWatch::Alarm");
const byName = (s: Stack) =>
  Object.fromEntries(
    Object.values(alarms(s)).map((a) => [a.Properties.AlarmName as string, a.Properties]),
  );

const common = {
  AlarmActions: [TOPIC],
  OKActions: [TOPIC],
  TreatMissingData: "notBreaching",
  EvaluationPeriods: 1,
  ComparisonOperator: "GreaterThanOrEqualToThreshold",
};

describe("alerts unspecified: no alarms, template unchanged", () => {
  it("persistent: 0 alarms in both stacks, no topic reference", () => {
    const { stage, version } = build(YAML, prod);
    expect(Object.keys(alarms(stage!))).toHaveLength(0);
    expect(Object.keys(alarms(version))).toHaveLength(0);
    expect(JSON.stringify(t(stage!).toJSON())).not.toContain("ops-alerts");
  });
  it("PR preview: 0 alarms", () => {
    expect(Object.keys(alarms(build(YAML, pr).version))).toHaveLength(0);
  });
});

describe("alerts specified: persistent stage", () => {
  it("version stack: Lambda (app + front) and HTTP API alarms", () => {
    const names = byName(build(YAML + alerts, prod).version);
    expect(Object.keys(names).sort()).toEqual([
      "flarelet-myapp-prod-v1-api-5xx",
      "flarelet-myapp-prod-v1-app-errors",
      "flarelet-myapp-prod-v1-app-throttles",
      "flarelet-myapp-prod-v1-front-errors",
      "flarelet-myapp-prod-v1-front-throttles",
    ]);
    for (const p of Object.values(names)) expect(p).toMatchObject({ ...common, Period: 300 });
    expect(names["flarelet-myapp-prod-v1-app-errors"]).toMatchObject({
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
      Statistic: "Sum",
      Threshold: 5,
      Dimensions: [{ Name: "FunctionName", Value: expect.anything() }],
    });
    expect(names["flarelet-myapp-prod-v1-front-errors"]).toMatchObject({
      Namespace: "AWS/Lambda",
      MetricName: "Errors",
      Threshold: 5,
    });
    for (const n of ["app", "front"]) {
      expect(names[`flarelet-myapp-prod-v1-${n}-throttles`]).toMatchObject({
        Namespace: "AWS/Lambda",
        MetricName: "Throttles",
        Statistic: "Sum",
        Threshold: 1,
      });
    }
    expect(names["flarelet-myapp-prod-v1-api-5xx"]).toMatchObject({
      Namespace: "AWS/ApiGateway",
      MetricName: "5xx",
      Statistic: "Sum",
      Threshold: 5,
      Dimensions: [
        { Name: "ApiId", Value: expect.anything() },
        { Name: "Stage", Value: "$default" },
      ],
    });
  });

  it("alarm descriptions are one English sentence", () => {
    for (const p of Object.values(byName(build(YAML + alerts, prod).version))) {
      expect(p.AlarmDescription).toMatch(/^[A-Z][^\n]*\.$/);
    }
  });

  it("stage stack: DynamoDB alarms per table (none for S3)", () => {
    const stage = build(YAML + alerts, prod).stage!;
    const names = byName(stage);
    expect(Object.keys(names).sort()).toEqual([
      "flarelet-myapp-prod-database-main-system-errors",
      "flarelet-myapp-prod-database-main-throttles",
    ]);
    for (const p of Object.values(names)) {
      expect(p).toMatchObject(common);
      // 数式のアラームは Period が各 MetricStat に入る
      const periods = (p.Metrics as { MetricStat?: { Period: number } }[])
        .filter((m) => m.MetricStat)
        .map((m) => m.MetricStat!.Period);
      expect(periods.length).toBeGreaterThan(0);
      expect(new Set(periods)).toEqual(new Set([300]));
    }
    const sys = names["flarelet-myapp-prod-database-main-system-errors"]!;
    expect(sys.Threshold).toBe(1);
    const sysJson = JSON.stringify(sys.Metrics);
    expect(sysJson).toContain('"MetricName":"SystemErrors"');
    expect(sysJson).toContain('"Name":"Operation"');
    expect(sysJson).toContain('"Name":"TableName"');
    const thr = names["flarelet-myapp-prod-database-main-throttles"]!;
    expect(thr.Threshold).toBe(1);
    const thrJson = JSON.stringify(thr.Metrics);
    expect(thrJson).toContain('"MetricName":"ReadThrottleEvents"');
    expect(thrJson).toContain('"MetricName":"WriteThrottleEvents"');
    expect(thrJson).toContain('"Stat":"Sum"');
  });

  it("one pair of alarms per table", () => {
    const y = `${base}http: true\ndatabase: { a: {}, b: {} }\n${alerts}`;
    expect(Object.keys(alarms(build(y, prod).stage!))).toHaveLength(4);
  });

  it("auth: false (no front): no front alarms", () => {
    const names = Object.keys(
      byName(build(`${base}http: { auth: false }\n${data}${alerts}`, prod).version),
    ).sort();
    expect(names).toEqual([
      "flarelet-myapp-prod-v1-api-5xx",
      "flarelet-myapp-prod-v1-app-errors",
      "flarelet-myapp-prod-v1-app-throttles",
    ]);
  });

  it("no http: only app Lambda alarms, no API alarm", () => {
    const names = Object.keys(byName(build(`${base}${alerts}`, prod).version)).sort();
    expect(names).toEqual([
      "flarelet-myapp-prod-v1-app-errors",
      "flarelet-myapp-prod-v1-app-throttles",
    ]);
  });

  it("no database: no stage-stack alarms", () => {
    const { stage } = build(`${base}http: true\n${alerts}`, prod);
    expect(Object.keys(alarms(stage!))).toHaveLength(0);
  });

  it("does not create an SNS topic", () => {
    const { stage, version } = build(YAML + alerts, prod);
    expect(Object.keys(t(stage!).findResources("AWS::SNS::Topic"))).toHaveLength(0);
    expect(Object.keys(t(version).findResources("AWS::SNS::Topic"))).toHaveLength(0);
  });
});

describe("alerts specified: ephemeral and dev get nothing", () => {
  it("PR preview: 0 alarms and template identical to no alerts", () => {
    const withA = build(YAML + alerts, pr).version;
    expect(Object.keys(alarms(withA))).toHaveLength(0);
    expect(t(withA).toJSON()).toEqual(t(build(YAML, pr).version).toJSON());
  });

  it("flarelet dev stack: 0 alarms and template identical to no alerts", () => {
    const dev: Deployment = { stage: "preview", version: "local-me", lifecycle: "persistent" };
    const mk = (y: string) =>
      Template.fromStack(
        buildDevApp({ ir: ir(y), deployment: dev, region: "ap-northeast-1" }).stack,
      );
    expect(Object.keys(mk(YAML + alerts).findResources("AWS::CloudWatch::Alarm"))).toHaveLength(0);
    expect(mk(YAML + alerts).toJSON()).toEqual(mk(YAML).toJSON());
  });
});

describe("alerts: SNS topic region must match the deploy region", () => {
  it("throws when they differ", () => {
    expect(() => build(YAML + alerts, prod, "us-east-1")).toThrow(
      /ap-northeast-1.*us-east-1|us-east-1.*ap-northeast-1/,
    );
  });
  it("does not throw for PR preview (no alarms are created)", () => {
    expect(() => build(YAML + alerts, pr, "us-east-1")).not.toThrow();
  });
});
