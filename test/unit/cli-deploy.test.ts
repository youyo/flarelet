import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDeploy } from "../../src/cli/deploy.js";
import { runPlan } from "../../src/cli/synth.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
database: { main: {} }
git:
  production: { branch: "release/*", version: branch }
  preview: { branch: default }
`;

let h: Harness;
afterEach(async () => h?.cleanup());

const res = (path: string, props: unknown) => ({
  Type: "AWS::X::Y",
  Properties: props,
  Metadata: { "aws:cdk:path": path },
});

describe("runDeploy", () => {
  it("synthesizes with the STS account, deploys and prints the URL", async () => {
    h = await harness(YAML, { AWS_REGION: "ap-northeast-1" });
    h.deployer.events = [
      { type: "assets" },
      { type: "stack-start", stack: "flareon-myapp-prod" },
      {
        type: "resource",
        stack: "flareon-myapp-prod",
        concept: "database.main",
        status: "CREATE_IN_PROGRESS",
      },
      {
        type: "resource",
        stack: "flareon-myapp-prod",
        concept: "database.main",
        status: "CREATE_COMPLETE",
      },
      { type: "stack-end", stack: "flareon-myapp-prod" },
      { type: "stack-start", stack: "flareon-myapp-prod-v1" },
      {
        type: "resource",
        stack: "flareon-myapp-prod-v1",
        concept: "application",
        status: "CREATE_IN_PROGRESS",
      },
      { type: "stack-end", stack: "flareon-myapp-prod-v1" },
    ];
    h.deployer.result = [
      { name: "flareon-myapp-prod", outputs: { UserPoolId: "pool-1" } },
      {
        name: "flareon-myapp-prod-v1",
        outputs: { ApiUrl: "https://abc.execute-api.ap-northeast-1.amazonaws.com" },
      },
    ];
    const code = await runDeploy({ file: h.file, branch: "release/v1" }, h.deps);
    expect(code, h.err.join("\n")).toBe(0);

    expect(h.synthCalls[0]!.account).toBe("123456789012");
    expect(h.synthCalls[0]!.region).toBe("ap-northeast-1");
    expect(h.synthCalls[0]!.source).toBe("release/v1");
    expect(h.deployer.outdirs).toEqual([join(h.dir, ".flareon", "out")]);

    const out = h.out.join("\n");
    expect(out).toContain("Deploying myapp (prod/v1)");
    expect(out).toContain("123456789012/ap-northeast-1");
    expect(out).toContain("stage resources");
    expect(out).toContain("version v1");
    // 同じ概念は 1 行に畳む・CFN の生ステータスや型は出さない
    expect(out.match(/database\.main/g)).toHaveLength(1);
    expect(out).not.toMatch(/AWS::|CREATE_IN_PROGRESS/);
    expect(out).toContain("https://abc.execute-api.ap-northeast-1.amazonaws.com");
    expect(out).toContain("flareon auth user add");

    const meta = JSON.parse(await readFile(join(h.dir, ".flareon", "metadata.json"), "utf8"));
    expect(meta).toMatchObject({
      app: "myapp",
      stage: "prod",
      version: "v1",
      account: "123456789012",
      url: "https://abc.execute-api.ap-northeast-1.amazonaws.com",
    });
    expect(typeof meta.deployedAt).toBe("string");
  });

  it("hints the magic link for previews", async () => {
    h = await harness(YAML);
    h.deployer.result = [
      { name: "flareon-myapp-preview-pr-3", outputs: { ApiUrl: "https://p.example" } },
    ];
    expect(await runDeploy({ file: h.file, pr: 3 }, h.deps)).toBe(0);
    const out = h.out.join("\n");
    expect(out).toContain("(preview/pr-3)");
    expect(out).toContain("flareon env url --pr 3 --with-token");
  });

  it("shows failures in Flareon terms and exits 1", async () => {
    h = await harness(YAML);
    h.deployer.events = [
      {
        type: "resource",
        stack: "flareon-myapp-prod",
        concept: "authentication",
        status: "CREATE_FAILED",
        reason: "Domain already exists",
      },
    ];
    h.deployer.error = new Error("The stack named flareon-myapp-prod failed creation");
    expect(await runDeploy({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toContain("authentication: Domain already exists");
    expect(err).toContain("Deployment failed");
  });

  it("fails clearly without AWS credentials", async () => {
    h = await harness(YAML);
    h.cloud.failAccount = new Error("Could not load credentials from any providers");
    expect(await runDeploy({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("Could not load credentials");
    expect(h.synthCalls).toHaveLength(0);
  });
});

describe("runPlan against AWS", () => {
  it("diffs the synthesized templates with the deployed ones", async () => {
    h = await harness(YAML);
    h.synthTemplates.set("flareon-myapp-prod", {
      Resources: { T: res("flareon-myapp-prod/Data/Database-main/Resource", { a: 1 }) },
    });
    h.synthTemplates.set("flareon-myapp-prod-v2", {
      Resources: { F: res("flareon-myapp-prod-v2/AppFunction/Resource", { k: 2 }) },
    });
    h.cloud.addStack({ name: "flareon-myapp-prod" });
    h.cloud.templates.set("flareon-myapp-prod", {
      Resources: {
        T: res("flareon-myapp-prod/Data/Database-main/Resource", { a: 1 }),
        S: res("flareon-myapp-prod/Data/Storage-old/Resource", {}),
      },
    });
    expect(await runPlan({ file: h.file, stage: "prod", version: "v2" }, h.deps)).toBe(0);
    const out = h.out.join("\n");
    expect(out).toContain("Flareon will update myapp (prod/v2)");
    expect(out).toContain("  + application version v2");
    expect(out).toContain("  = database.main");
    expect(out).toContain("  - storage.old");
    expect(h.synthCalls[0]!.account).toBe("123456789012");
  });

  it("treats the public endpoint as existing once the application is deployed", async () => {
    h = await harness(`version: 1
name: myapp
runtime: { language: python }
http: { auth: false }
`);
    const tpl = {
      Resources: { F: res("flareon-myapp-prod-v1/AppFunction/Resource", { k: 1 }) },
    };
    h.synthTemplates.set("flareon-myapp-prod-v1", tpl);
    h.cloud.addStack({ name: "flareon-myapp-prod-v1" });
    h.cloud.templates.set("flareon-myapp-prod-v1", tpl);
    expect(await runPlan({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    const out = h.out.join("\n");
    expect(out).toContain("  = application version v1");
    expect(out).toContain("  = public endpoint (no authentication)");
    expect(out).toContain("No changes");
  });

  it("falls back to an offline plan when AWS is unreachable", async () => {
    h = await harness(YAML);
    h.cloud.failAccount = new Error("no credentials");
    expect(await runPlan({ file: h.file, stage: "prod", version: "v2" }, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("Flareon will create myapp (prod/v2)");
    expect(h.err.join("\n")).toContain("no credentials");
  });

  it("does not touch AWS when FLAREON_OFFLINE=1", async () => {
    h = await harness(YAML, { FLAREON_OFFLINE: "1" });
    expect(await runPlan({ file: h.file, stage: "prod", version: "v2" }, h.deps)).toBe(0);
    expect(h.cloud.calls).toEqual([]);
    expect(h.err).toEqual([]);
  });
});
