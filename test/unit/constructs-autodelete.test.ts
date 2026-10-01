// lifetime=destroy のバケット（PR プレビュー / flarelet dev）は CDK の autoDeleteObjects カスタムリソースを使う。
// そのプロバイダ Lambda のロググループが暗黙作成されてスタック削除後に残らないよう、スタック内で明示的に作る。
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { buildApp } from "../../src/constructs/index.js";
import { toIR } from "../../src/ir/index.js";

const YAML =
  "version: 1\nname: myapp\nruntime: { language: python }\nhttp: true\nstorage: { files: {}, more: {} }\n";

function previewTemplate(yaml = YAML) {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  const { version } = buildApp({
    ir: toIR(r.config),
    deployment: { stage: "preview", version: "pr-1", lifecycle: "ephemeral" },
    region: "ap-northeast-1",
    code: { app: lambda.Code.fromInline("x"), front: lambda.Code.fromInline("x") },
  });
  return Template.fromStack(version).toJSON() as {
    Resources: Record<
      string,
      {
        Type: string;
        Properties: Record<string, unknown>;
        DeletionPolicy?: string;
        Metadata?: Record<string, string>;
      }
    >;
  };
}

const byPath = (t: ReturnType<typeof previewTemplate>, suffix: string) =>
  Object.entries(t.Resources).find(([, r]) => r.Metadata?.["aws:cdk:path"]?.endsWith(suffix));

describe("autoDeleteObjects provider logs", () => {
  it("sends the provider Lambda's logs to a log group that is deleted with the stack", () => {
    const t = previewTemplate();
    const [, handler] = byPath(t, "Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler")!;
    const ref = (handler.Properties.LoggingConfig as { LogGroup: { Ref: string } }).LogGroup.Ref;
    const lg = t.Resources[ref]!;
    expect(lg.Type).toBe("AWS::Logs::LogGroup");
    expect(lg.DeletionPolicy).toBe("Delete");
    expect(lg.Properties.RetentionInDays).toEqual(expect.any(Number));
    expect(Object.values(t.Resources).filter((r) => r.Type === "AWS::Logs::LogGroup")).toHaveLength(
      3,
    );
  });

  it("does not let the provider re-create log groups after deletion (no logs:CreateLogGroup)", () => {
    const t = previewTemplate();
    const [, role] = byPath(t, "Custom::S3AutoDeleteObjectsCustomResourceProvider/Role")!;
    const json = JSON.stringify(role.Properties);
    expect(json).not.toContain("AWSLambdaBasicExecutionRole");
    expect(json).not.toContain("logs:CreateLogGroup");
    expect(json).toContain("logs:PutLogEvents");
  });

  it("is not added when there is no auto-deleted bucket", () => {
    const t = previewTemplate(
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp: true\n",
    );
    expect(byPath(t, "Custom::S3AutoDeleteObjectsCustomResourceProvider/Handler")).toBeUndefined();
  });
});
