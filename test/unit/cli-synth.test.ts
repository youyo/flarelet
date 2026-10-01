import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runPlan, runSynth, type SynthDeps } from "../../src/cli/synth.js";
import type { BuildOptions } from "../../src/constructs/index.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flareon-synth-"));
  await writeFile(
    join(dir, "flareon.yaml"),
    `version: 1
name: myapp
runtime: { language: python }
http: true
database: { main: {} }
git:
  production: { branch: "release/*", version: branch }
  preview: { branch: default }
`,
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function harness(
  git: { branch?: string; defaultBranch?: string; pr?: number } = {},
  env: Record<string, string> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const calls: BuildOptions[] = [];
  const deps: SynthDeps = {
    io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    detectGit: async () => git,
    env,
    synthesize: (o) => {
      calls.push(o);
      return {
        outdir: o.outdir,
        stacks: [
          { name: "flareon-myapp-prod", kind: "stage" },
          { name: "flareon-myapp-prod-v1", kind: "version" },
        ],
      };
    },
  };
  return { out, err, calls, deps };
}
const file = () => join(dir, "flareon.yaml");

describe("runSynth", () => {
  it("resolves the deployment from the Git branch and writes metadata", async () => {
    const h = harness({ branch: "release/v1", defaultBranch: "main" });
    expect(await runSynth({ file: file() }, h.deps)).toBe(0);
    const c = h.calls[0]!;
    expect(c.deployment).toEqual({ stage: "prod", version: "v1", lifecycle: "persistent" });
    expect(c.outdir).toBe(join(dir, ".flareon", "out"));
    expect(c.appDir).toBe(dir);
    expect(c.region).toBe("us-east-1");
    const meta = JSON.parse(await readFile(join(dir, ".flareon", "metadata.json"), "utf8"));
    expect(meta).toEqual({
      app: "myapp",
      stage: "prod",
      version: "v1",
      lifecycle: "persistent",
      region: "us-east-1",
      stacks: [
        { name: "flareon-myapp-prod", kind: "stage" },
        { name: "flareon-myapp-prod-v1", kind: "version" },
      ],
    });
    expect(h.out.join("\n")).toContain("flareon-myapp-prod-v1");
  });

  it("maps the default branch to preview/current and honours --branch / --default-branch", async () => {
    const h = harness();
    await runSynth({ file: file(), branch: "main", defaultBranch: "main" }, h.deps);
    expect(h.calls[0]!.deployment).toMatchObject({ stage: "preview", version: "current" });
  });

  it("resolves --pr to an ephemeral preview", async () => {
    const h = harness();
    await runSynth({ file: file(), pr: 42 }, h.deps);
    expect(h.calls[0]!.deployment).toEqual({
      stage: "preview",
      version: "pr-42",
      lifecycle: "ephemeral",
    });
  });

  it("uses the PR number detected from the environment", async () => {
    const h = harness({ pr: 7 });
    await runSynth({ file: file() }, h.deps);
    expect(h.calls[0]!.deployment.version).toBe("pr-7");
  });

  it("--stage/--version override Git entirely", async () => {
    const h = harness();
    expect(await runSynth({ file: file(), stage: "dev", version: "v9" }, h.deps)).toBe(0);
    expect(h.calls[0]!.deployment).toEqual({
      stage: "dev",
      version: "v9",
      lifecycle: "persistent",
    });
  });

  it("reports resolver errors with exit 1", async () => {
    const h = harness({ branch: "wip/x", defaultBranch: "main" });
    expect(await runSynth({ file: file() }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("does not match any deployment target");
    expect(h.calls).toHaveLength(0);
  });

  it("reports an invalid config", async () => {
    await writeFile(file(), "version: 1\nname: Bad_Name\nruntime: { language: ruby }\n");
    const h = harness();
    expect(await runSynth({ file: file(), stage: "prod", version: "v1" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("is invalid");
  });

  it("reports a missing config", async () => {
    await rm(file());
    const h = harness();
    expect(await runSynth({ file: file() }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/not found/);
  });

  it("takes the region from --region, then AWS_REGION, and skips bundling via env", async () => {
    const h = harness({}, { AWS_REGION: "eu-west-1", FLAREON_SKIP_BUNDLING: "1" });
    await runSynth({ file: file(), stage: "prod", version: "v1" }, h.deps);
    expect(h.calls[0]!.region).toBe("eu-west-1");
    expect(h.calls[0]!.skipBundling).toBe(true);
    const h2 = harness({}, { AWS_REGION: "eu-west-1" });
    await runSynth(
      { file: file(), stage: "prod", version: "v1", region: "ap-northeast-1" },
      h2.deps,
    );
    expect(h2.calls[0]!.region).toBe("ap-northeast-1");
    expect(h2.calls[0]!.skipBundling).toBe(false);
  });

  it("surfaces synthesis failures as errors with exit 1", async () => {
    const h = harness({}, {});
    h.deps.synthesize = () => {
      throw new Error("boom");
    };
    expect(await runSynth({ file: file(), stage: "prod", version: "v1" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("boom");
  });
});

describe("runPlan", () => {
  it("synthesizes and prints the plan in Flareon terms", async () => {
    const h = harness();
    await mkdir(join(dir, "app"), { recursive: true });
    expect(await runPlan({ file: file(), stage: "prod", version: "v2" }, h.deps)).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("Flareon will create myapp (prod/v2)");
    expect(text).toContain("+ application version v2");
    expect(text).toContain("+ database.main");
    expect(text).toContain("flareon deploy --stage prod --version v2");
    expect(h.calls).toHaveLength(1);
  });
});
