import { describe, expect, it } from "vitest";
import { conceptOf, diffTemplates, type CfnTemplate } from "../../src/aws/concepts.js";

describe("conceptOf", () => {
  it("maps CDK construct paths to Flarelet concepts", () => {
    expect(conceptOf("flarelet-a-prod/Data/Database-main/Resource")).toBe("database.main");
    expect(conceptOf("/flarelet-a-prod/Data/Storage-files/Resource")).toBe("storage.files");
    expect(conceptOf("/flarelet-a-prod/Data/Storage-files/Policy/Resource")).toBe("storage.files");
    expect(conceptOf("flarelet-a-prod/UserPool/Resource")).toBe("authentication");
    expect(conceptOf("flarelet-a-prod/UserPool/Domain/Resource")).toBe("authentication");
    expect(conceptOf("flarelet-a-prod/SessionSecret/Resource")).toBe("authentication");
    expect(conceptOf("flarelet-a-prod-v1/Client/Resource")).toBe("authentication");
    expect(conceptOf("flarelet-a-prod-v1/Branding")).toBe("authentication");
    expect(conceptOf("flarelet-a-preview-pr-1/PreviewToken/Resource")).toBe("authentication");
    for (const p of [
      "AppFunction/Resource",
      "AppFunction/ServiceRole/Resource",
      "AppLogs/Resource",
      "Api/Resource",
      "DefaultRoute/Resource",
      "FrontAuthFunction/Resource",
      "FrontLogs/Resource",
    ]) {
      expect(conceptOf(`flarelet-a-prod-v1/${p}`)).toBe("application");
    }
    expect(conceptOf("flarelet-a-prod-v1/CDKMetadata/Default")).toBeUndefined();
  });

  it("also accepts stack-relative paths (as toolkit-lib reports them)", () => {
    expect(conceptOf("AppFunction")).toBe("application");
    expect(conceptOf("Data/Database-main")).toBe("database.main");
    expect(conceptOf("UserPool/Domain")).toBe("authentication");
    expect(conceptOf("CDKMetadata")).toBeUndefined();
    expect(
      conceptOf("flarelet-a-preview-pr-1/Custom::S3AutoDeleteObjectsCustomResourceProvider/Role"),
    ).toBeUndefined();
  });
});

const res = (path: string, props: unknown, type = "AWS::X::Y") => ({
  Type: type,
  Properties: props,
  Metadata: { "aws:cdk:path": path },
});

const appFn = (env: Record<string, string>, key = "k1") =>
  res(
    "flarelet-a-prod-v1/AppFunction/Resource",
    { Code: { S3Key: key }, Environment: { Variables: env } },
    "AWS::Lambda::Function",
  );

describe("diffTemplates", () => {
  const stageNew: CfnTemplate = {
    Resources: {
      T1: res("flarelet-a-prod/Data/Database-main/Resource", { a: 1 }),
      B1: res("flarelet-a-prod/Data/Storage-files/Resource", { b: 1 }),
    },
  };
  const verNew: CfnTemplate = {
    Resources: {
      Fn: appFn({ FLARELET_AI_HAIKU_MODEL_ID: "x", FLARELET_SECRETS_PATH: "/p" }, "k2"),
    },
  };

  it("treats missing stacks as nothing deployed", () => {
    const s = diffTemplates([
      { next: stageNew, prev: undefined },
      { next: verNew, prev: undefined },
    ]);
    expect([...s.existing]).toEqual([]);
  });

  it("classifies unchanged, changed and removed concepts", () => {
    const stagePrev: CfnTemplate = {
      Resources: {
        T1: res("flarelet-a-prod/Data/Database-main/Resource", { a: 1 }, "AWS::X::Y"),
        T0: res("flarelet-a-prod/Data/Database-legacy/Resource", { a: 0 }),
        B1: {
          ...res("flarelet-a-prod/Data/Storage-files/Resource", { b: 1 }),
          Metadata: { other: 1 },
        },
      },
    };
    const verPrev: CfnTemplate = {
      Resources: {
        Fn: appFn({ FLARELET_AI_NOVA_MICRO_MODEL_ID: "y", FLARELET_SECRETS_PATH: "/p" }, "k1"),
      },
    };
    const s = diffTemplates([
      { next: stageNew, prev: stagePrev },
      { next: verNew, prev: verPrev },
    ]);
    expect([...s.existing].sort()).toEqual(
      [
        "application",
        "database.main",
        "database.legacy",
        "storage.files",
        "secrets",
        "ai.nova-micro",
      ].sort(),
    );
    // 旧テンプレートにパスが無いリソースは同じ論理 ID の新リソースのパスで分類し、Metadata は比較しない
    expect(s.changed.has("storage.files")).toBe(false);
    expect(s.changed.has("application")).toBe(true);
    expect(s.changed.has("database.main")).toBe(false);
    expect([...s.removed].sort()).toEqual(["ai.nova-micro", "database.legacy"]);
  });

  it("detects a property change on a stateful resource", () => {
    const prev: CfnTemplate = {
      Resources: { T1: res("flarelet-a-prod/Data/Database-main/Resource", { a: 2 }) },
    };
    const s = diffTemplates([{ next: stageNew, prev }]);
    expect(s.changed.has("database.main")).toBe(true);
    expect(s.existing.has("storage.files")).toBe(false);
  });
});
