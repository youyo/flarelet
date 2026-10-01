import { afterEach, describe, expect, it } from "vitest";
import { runDestroy } from "../../src/cli/destroy.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
database: { main: {} }
storage: { files: {} }
secrets: [API_KEY]
`;

let h: Harness;
afterEach(async () => h?.cleanup());

const tags = (stage: string, version?: string) => ({
  "flareon:app": "myapp",
  "flareon:stage": stage,
  ...(version ? { "flareon:version": version } : {}),
});

async function prodWith(...versions: string[]) {
  h = await harness(YAML);
  h.cloud.addStack({ name: "flareon-myapp-prod", tags: tags("prod") });
  for (const v of versions) {
    h.cloud.addStack({ name: `flareon-myapp-prod-${v}`, tags: tags("prod", v) });
  }
  h.cloud.resources.set("flareon-myapp-prod", [
    { logicalId: "T", physicalId: "tbl", type: "AWS::DynamoDB::Table" },
    { logicalId: "B", physicalId: "bkt", type: "AWS::S3::Bucket" },
    { logicalId: "P", physicalId: "pool", type: "AWS::Cognito::UserPool" },
    { logicalId: "S", physicalId: "arn:secret", type: "AWS::SecretsManager::Secret" },
    { logicalId: "D", physicalId: "dom", type: "AWS::Cognito::UserPoolDomain" },
  ]);
  h.cloud.params.set("/flareon/myapp/prod/secrets/API_KEY", {
    value: "x",
    lastModified: new Date(0),
  });
}

describe("runDestroy", () => {
  it("removes only the version stack of a persistent stage by default", async () => {
    await prodWith("v1");
    expect(await runDestroy({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(h.cloud.calls).toContain("deleteStack:flareon-myapp-prod-v1");
    expect(h.cloud.calls).not.toContain("deleteStack:flareon-myapp-prod");
    expect(h.cloud.deleted).toEqual([]);
    expect(h.out.join("\n")).toMatch(/kept.*--stage-resources/s);
  });

  it("refuses --stage-resources without --yes", async () => {
    await prodWith("v1");
    expect(
      await runDestroy(
        { file: h.file, stage: "prod", version: "v1", stageResources: true },
        h.deps,
      ),
    ).toBe(1);
    expect(h.err.join("\n")).toContain("--yes");
    expect(h.cloud.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  });

  it("refuses to delete stage resources while other versions are deployed", async () => {
    await prodWith("v1", "v2");
    expect(
      await runDestroy(
        { file: h.file, stage: "prod", version: "v1", stageResources: true, yes: true },
        h.deps,
      ),
    ).toBe(1);
    expect(h.err.join("\n")).toContain("v2");
    expect(h.cloud.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  });

  it("deletes the stage stack, its retained resources and the stage secrets with --stage-resources --yes", async () => {
    await prodWith("v1");
    expect(
      await runDestroy(
        { file: h.file, stage: "prod", version: "v1", stageResources: true, yes: true },
        h.deps,
      ),
    ).toBe(0);
    const order = h.cloud.calls.filter((c) => c.startsWith("delete"));
    expect(order.slice(0, 2)).toEqual([
      "deleteStack:flareon-myapp-prod-v1",
      "deleteStack:flareon-myapp-prod",
    ]);
    expect(h.cloud.deleted.map((r) => r.type).sort()).toEqual([
      "AWS::Cognito::UserPool",
      "AWS::DynamoDB::Table",
      "AWS::S3::Bucket",
      "AWS::SecretsManager::Secret",
    ]);
    expect(h.cloud.calls).toContain("deleteParameter:/flareon/myapp/prod/secrets/API_KEY");
  });

  it("deletes the whole PR preview stack", async () => {
    h = await harness(YAML);
    h.cloud.addStack({ name: "flareon-myapp-preview-pr-5", tags: tags("preview", "pr-5") });
    expect(await runDestroy({ file: h.file, pr: 5 }, h.deps)).toBe(0);
    expect(h.cloud.calls).toContain("deleteStack:flareon-myapp-preview-pr-5");
    expect(h.out.join("\n")).toContain("preview/pr-5");
  });

  it("is a no-op when nothing is deployed", async () => {
    h = await harness(YAML);
    expect(await runDestroy({ file: h.file, stage: "prod", version: "v9" }, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("not deployed");
    expect(h.cloud.calls.filter((c) => c.startsWith("delete"))).toEqual([]);
  });
});
