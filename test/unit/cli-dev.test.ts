import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runDev, type DevDeps, type LocalOptions } from "../../src/cli/dev.js";
import { runDestroy } from "../../src/cli/destroy.js";
import type { DevBuildOptions } from "../../src/constructs/dev.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python, version: "3.13" }
http: true
database: { main: {} }
storage: { files: {} }
ai: { models: [haiku] }
secrets: [API_KEY, OTHER_KEY]
`;

const DEV_STACK = "flareon-myapp-preview-local-naoto";

interface DevHarness extends Harness {
  dev: DevDeps;
  devSynth: (DevBuildOptions & { outdir: string })[];
  started: LocalOptions[];
  stopped: number;
}

let h: DevHarness;
afterEach(async () => h?.cleanup());

async function devHarness(yaml = YAML, env: Record<string, string> = {}): Promise<DevHarness> {
  const base = await harness(yaml, { AWS_REGION: "ap-northeast-1", ...env });
  const d = base as DevHarness;
  d.devSynth = [];
  d.started = [];
  d.stopped = 0;
  d.dev = {
    ...base.deps,
    username: () => "Naoto",
    synthesizeDev: (o) => {
      d.devSynth.push(o);
      return { outdir: o.outdir, stacks: [{ name: DEV_STACK, kind: "dev" }] };
    },
    startLocal: async (o) => {
      d.started.push(o);
      return {
        url: `http://localhost:${o.port}`,
        stop: async () => {
          d.stopped++;
        },
      };
    },
    untilStopped: async () => {},
  };
  return d;
}

const devOutputs = {
  Bindings: JSON.stringify({
    FLAREON_DATABASE_MAIN_TABLE: "dev-table",
    FLAREON_STORAGE_FILES_BUCKET: "dev-bucket",
  }),
};

describe("flareon dev (default: preview/local-<user>)", () => {
  it("deploys a stateful-only dev stack and starts the app connected to it", async () => {
    h = await devHarness();
    h.deployer.result = [{ name: DEV_STACK, outputs: devOutputs }];
    h.cloud.params.set("/flareon/myapp/preview/secrets/API_KEY", {
      value: "s3cr3t-value",
      lastModified: new Date(0),
    });

    expect(await runDev({ file: h.file }, h.dev)).toBe(0);

    expect(h.devSynth).toHaveLength(1);
    expect(h.devSynth[0]).toMatchObject({
      deployment: { stage: "preview", version: "local-naoto" },
      region: "ap-northeast-1",
      account: "123456789012",
      outdir: join(h.dir, ".flareon", "dev", "out"),
    });
    expect(h.deployer.outdirs).toEqual([join(h.dir, ".flareon", "dev", "out")]);
    expect(h.synthCalls).toHaveLength(0); // 通常の app スタックは作らない

    const s = h.started[0]!;
    expect(s).toMatchObject({ appDir: h.dir, language: "python", port: 8787 });
    expect(s.env).toMatchObject({
      AWS_REGION: "ap-northeast-1",
      FLAREON_APP: "myapp",
      FLAREON_STAGE: "preview",
      FLAREON_VERSION: "local-naoto",
      FLAREON_DATABASE_MAIN_TABLE: "dev-table",
      FLAREON_STORAGE_FILES_BUCKET: "dev-bucket",
      API_KEY: "s3cr3t-value",
    });
    expect(s.env.FLAREON_AI_HAIKU_MODEL_ID).toMatch(/haiku/);
    expect(s.env.OTHER_KEY).toBeUndefined();
    expect(h.stopped).toBe(1);
  });

  it("prints the startup screen without secret values", async () => {
    h = await devHarness();
    h.deployer.result = [{ name: DEV_STACK, outputs: devOutputs }];
    h.cloud.params.set("/flareon/myapp/preview/secrets/API_KEY", {
      value: "s3cr3t-value",
      lastModified: new Date(0),
    });
    await runDev({ file: h.file }, h.dev);
    const out = h.out.join("\n");
    expect(out).toContain("Flareon dev");
    expect(out).toMatch(/App\s+myapp/);
    expect(out).toMatch(/Stage\s+preview/);
    expect(out).toMatch(/Version\s+local-naoto/);
    expect(out).toMatch(/Runtime\s+python 3\.13/);
    expect(out).toMatch(/URL\s+http:\/\/localhost:8787/);
    expect(out).toMatch(/database\.main\s+connected/);
    expect(out).toMatch(/storage\.files\s+connected/);
    expect(out).toMatch(/ai\.haiku\s+connected/);
    expect(out).toMatch(/secrets\.API_KEY\s+loaded/);
    expect(out).toMatch(/secrets\.OTHER_KEY\s+not set/);
    expect(out).toContain("Watching...");
    expect(out).toContain("flareon destroy --stage preview --version local-naoto");
    expect([...h.out, ...h.err].join("\n")).not.toContain("s3cr3t-value");
  });

  it("skips the AWS stack when the app has no database or storage", async () => {
    h = await devHarness(
      "version: 1\nname: myapp\nruntime: { language: typescript }\nhttp: true\n",
    );
    expect(await runDev({ file: h.file }, h.dev)).toBe(0);
    expect(h.devSynth).toHaveLength(0);
    expect(h.deployer.outdirs).toHaveLength(0);
    expect(h.started[0]!.language).toBe("typescript");
  });

  it("honours --port and --as", async () => {
    h = await devHarness();
    h.deployer.result = [{ name: DEV_STACK, outputs: devOutputs }];
    await runDev({ file: h.file, port: 9000, as: "alice@example.com" }, h.dev);
    expect(h.started[0]).toMatchObject({ port: 9000, as: "alice@example.com" });
    expect(h.out.join("\n")).toMatch(/Identity\s+alice@example\.com/);
  });

  it("fails without starting the app when the dev stack cannot be deployed", async () => {
    h = await devHarness();
    h.deployer.error = new Error("boom");
    expect(await runDev({ file: h.file }, h.dev)).toBe(1);
    expect(h.err.join("\n")).toMatch(/boom/);
    expect(h.started).toHaveLength(0);
  });

  it("reports when AWS is unreachable", async () => {
    h = await devHarness();
    h.cloud.failAccount = new Error("no credentials");
    expect(await runDev({ file: h.file }, h.dev)).toBe(1);
    expect(h.err.join("\n")).toMatch(/cannot reach AWS.*no credentials/);
    expect(h.err.join("\n")).toMatch(/FLAREON_OFFLINE=1/);
  });

  it("reports a local startup failure (e.g. port in use)", async () => {
    h = await devHarness("version: 1\nname: myapp\nruntime: { language: typescript }\n");
    h.dev.startLocal = async () => {
      throw new Error("port 8787 is in use; pass --port to use another one");
    };
    expect(await runDev({ file: h.file }, h.dev)).toBe(1);
    expect(h.err.join("\n")).toMatch(/port 8787 is in use/);
  });

  it("the dev environment is removed by the normal destroy", async () => {
    h = await devHarness();
    h.cloud.addStack({
      name: DEV_STACK,
      tags: {
        "flareon:app": "myapp",
        "flareon:stage": "preview",
        "flareon:version": "local-naoto",
      },
    });
    expect(
      await runDestroy({ file: h.file, stage: "preview", version: "local-naoto" }, h.deps),
    ).toBe(0);
    expect(h.cloud.calls).toContain(`deleteStack:${DEV_STACK}`);
  });
});

describe("flareon dev --stage/--version (connect to an existing environment)", () => {
  it("reads the bindings from the deployed app function and creates nothing", async () => {
    h = await devHarness();
    h.cloud.addStack({
      name: "flareon-myapp-prod-v1",
      tags: { "flareon:app": "myapp", "flareon:stage": "prod", "flareon:version": "v1" },
      outputs: { AppFunctionName: "app-fn" },
    });
    h.cloud.functionEnv.set("app-fn", {
      PORT: "8080",
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
      FLAREON_DATABASE_MAIN_TABLE: "prod-table",
      FLAREON_STORAGE_FILES_BUCKET: "prod-bucket",
      FLAREON_AI_HAIKU_MODEL_ID: "prod-model",
    });
    h.cloud.params.set("/flareon/myapp/prod/secrets/API_KEY", {
      value: "prod-secret",
      lastModified: new Date(0),
    });
    expect(await runDev({ file: h.file, stage: "prod", version: "v1" }, h.dev)).toBe(0);
    expect(h.devSynth).toHaveLength(0);
    expect(h.deployer.outdirs).toHaveLength(0);
    const env = h.started[0]!.env;
    expect(env).toMatchObject({
      FLAREON_STAGE: "prod",
      FLAREON_VERSION: "v1",
      FLAREON_DATABASE_MAIN_TABLE: "prod-table",
      FLAREON_STORAGE_FILES_BUCKET: "prod-bucket",
      FLAREON_AI_HAIKU_MODEL_ID: "prod-model",
      API_KEY: "prod-secret",
    });
    expect(env.PORT).toBeUndefined();
    expect(env.AWS_LAMBDA_EXEC_WRAPPER).toBeUndefined();
    const out = h.out.join("\n");
    expect(out).toMatch(/Stage\s+prod/);
    expect(out).toMatch(/database\.main\s+connected/);
    expect(out).not.toContain("flareon destroy");
  });

  it("marks bindings missing from the deployed version", async () => {
    h = await devHarness();
    h.cloud.addStack({ name: "flareon-myapp-prod-v1", outputs: { AppFunctionName: "app-fn" } });
    h.cloud.functionEnv.set("app-fn", { FLAREON_DATABASE_MAIN_TABLE: "t" });
    expect(await runDev({ file: h.file, stage: "prod", version: "v1" }, h.dev)).toBe(0);
    expect(h.out.join("\n")).toMatch(/storage\.files\s+not deployed/);
  });

  it("fails when the environment is not deployed", async () => {
    h = await devHarness();
    expect(await runDev({ file: h.file, stage: "prod", version: "v9" }, h.dev)).toBe(1);
    expect(h.err.join("\n")).toMatch(/myapp \(prod\/v9\) is not deployed/);
    expect(h.started).toHaveLength(0);
  });

  it("requires --stage and --version together", async () => {
    h = await devHarness();
    expect(await runDev({ file: h.file, stage: "prod" }, h.dev)).toBe(1);
    expect(h.err.join("\n")).toMatch(/--stage and --version/);
  });
});

describe("flareon dev offline (FLAREON_OFFLINE=1)", () => {
  it("starts the app without touching AWS and shows bindings as offline", async () => {
    h = await devHarness(YAML, { FLAREON_OFFLINE: "1" });
    expect(await runDev({ file: h.file }, h.dev)).toBe(0);
    expect(h.cloud.calls).toEqual([]);
    expect(h.devSynth).toHaveLength(0);
    const out = h.out.join("\n");
    expect(out).toMatch(/database\.main\s+offline/);
    expect(out).toMatch(/secrets\.API_KEY\s+offline/);
    expect(h.started[0]!.env.FLAREON_DATABASE_MAIN_TABLE).toBeUndefined();
    expect(h.started[0]!.env.FLAREON_VERSION).toBe("local-naoto");
  });
});
