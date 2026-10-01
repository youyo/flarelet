import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");
const EXAMPLES = resolve(import.meta.dirname, "../../examples");

// Docker / pip / npm を避けるため、既定ではバンドルをスキップする。
const BASE_ENV = {
  ...process.env,
  FLARELET_SKIP_BUNDLING: "1",
  FLARELET_OFFLINE: "1",
  AWS_REGION: "us-east-1",
};

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = BASE_ENV) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      res({ code, stdout, stderr });
    });
  });
}

function git(args: string[], cwd: string) {
  return new Promise<void>((res, rej) => {
    execFile(
      "git",
      ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd },
      (e) => (e ? rej(e) : res()),
    );
  });
}

// テンプレート JSON の最小限の型（テストで参照するフィールドのみ。存在は各テストが検証する）
interface Props {
  Runtime: string;
  Handler: string;
  Architectures: string[];
  Layers: string[];
  Environment: { Variables: Record<string, string> };
  PolicyDocument: { Statement: Statement[] };
}
interface Statement {
  Action: string | string[];
  Resource: unknown;
}
type Template = {
  Resources: Record<string, { Type: string; DeletionPolicy?: string; Properties: Props }>;
};
const readTemplate = async (dir: string, stack: string): Promise<Template> =>
  JSON.parse(await readFile(join(dir, ".flarelet", "out", `${stack}.template.json`), "utf8"));
const types = (t: Template) => Object.values(t.Resources).map((r) => r.Type);
const count = (t: Template, type: string) => types(t).filter((x) => x === type).length;
const fns = (t: Template) =>
  Object.values(t.Resources).filter((r) => r.Type === "AWS::Lambda::Function");
const statements = (t: Template) =>
  Object.values(t.Resources)
    .filter((r) => r.Type === "AWS::IAM::Policy")
    .flatMap((r) => r.Properties.PolicyDocument.Statement);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flarelet-e2e-synth-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("flarelet init -> synth (typescript)", () => {
  beforeEach(async () => {
    const r = await run(["init", "--runtime", "typescript", dir], tmpdir());
    expect(r.code).toBe(0);
  });

  it("produces a stage stack and a version stack for a persistent deployment", async () => {
    const r = await run(["synth", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);

    const meta = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    expect(meta.stage).toBe("prod");
    expect(meta.version).toBe("v1");
    expect(meta.stacks.map((s: { name: string }) => s.name)).toHaveLength(2);
    const [stageName, versionName] = meta.stacks.map((s: { name: string }) => s.name);
    expect(versionName).toBe(`${stageName}-v1`);

    const out = await readdir(join(dir, ".flarelet", "out"));
    expect(out).toContain("manifest.json");
    expect(out).toContain(`${stageName}.template.json`);

    const stage = await readTemplate(dir, stageName);
    expect(count(stage, "AWS::Cognito::UserPool")).toBe(1);
    expect(count(stage, "AWS::Cognito::UserPoolDomain")).toBe(1);
    expect(count(stage, "AWS::DynamoDB::Table")).toBe(1);
    expect(count(stage, "AWS::S3::Bucket")).toBe(1);
    expect(count(stage, "AWS::SecretsManager::Secret")).toBe(1);
    expect(fns(stage)).toHaveLength(0);
    for (const r of Object.values(stage.Resources)) {
      if (["AWS::DynamoDB::Table", "AWS::S3::Bucket", "AWS::Cognito::UserPool"].includes(r.Type)) {
        expect(r.DeletionPolicy).toBe("Retain");
      }
    }

    const version = await readTemplate(dir, versionName);
    expect(count(version, "AWS::ApiGatewayV2::Api")).toBe(1);
    expect(count(version, "AWS::Cognito::UserPoolClient")).toBe(1);
    expect(
      fns(version)
        .map((f) => f.Properties.Runtime)
        .sort(),
    ).toEqual(["nodejs24.x", "nodejs24.x"]);
    const app = fns(version).find((f) => f.Properties.Handler === "flarelet-launcher.sh")!;
    expect(app.Properties.Architectures).toEqual(["arm64"]);
    expect(app.Properties.Layers[0]).toMatch(/:753240598075:layer:LambdaAdapterLayerArm64:\d+$/);
    expect(app.Properties.Environment.Variables).toMatchObject({
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
      PORT: "8080",
      FLARELET_STAGE: "prod",
      FLARELET_VERSION: "v1",
    });
  });

  it("grants least-privilege IAM to the app Lambda", async () => {
    await run(["synth", "--stage", "prod", "--version", "v1"], dir);
    const meta = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    const version = await readTemplate(dir, meta.stacks[1].name);
    const all = statements(version);
    for (const s of all) {
      expect([s.Action].flat().every((a: string) => a !== "*" && !a.endsWith(":*"))).toBe(true);
      expect(s.Resource).not.toBe("*");
    }
    const bedrock = all.filter((s) =>
      [s.Action].flat().some((a: string) => a.startsWith("bedrock:")),
    );
    expect(bedrock).toHaveLength(1);
    expect(JSON.stringify(bedrock[0]?.Resource)).toContain("anthropic.claude-sonnet");
    expect(JSON.stringify(bedrock[0]?.Resource)).not.toContain("opus");
  });

  it("auth: false removes the front auth Lambda and Cognito client", async () => {
    const f = join(dir, "flarelet.yaml");
    await writeFile(
      f,
      (await readFile(f, "utf8")).replace("http:\n  auth: true", "http:\n  auth: false"),
    );
    const r = await run(["synth", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);
    const meta = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    const version = await readTemplate(dir, meta.stacks[1].name);
    expect(fns(version)).toHaveLength(1);
    expect(count(version, "AWS::Cognito::UserPoolClient")).toBe(0);
    expect(count(version, "AWS::ApiGatewayV2::Api")).toBe(1);
    const stage = await readTemplate(dir, meta.stacks[0].name);
    expect(count(stage, "AWS::Cognito::UserPool")).toBe(0);
  });

  it("--pr produces a single ephemeral stack with Preview Auth and disposable data", async () => {
    const r = await run(["synth", "--pr", "12"], dir);
    expect(r.code, r.stderr).toBe(0);
    const meta = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    expect(meta).toMatchObject({ stage: "preview", version: "pr-12", lifecycle: "ephemeral" });
    expect(meta.stacks).toHaveLength(1);
    const t = await readTemplate(dir, meta.stacks[0].name);
    expect(count(t, "AWS::Cognito::UserPool")).toBe(0);
    expect(count(t, "AWS::SecretsManager::Secret")).toBe(2);
    expect(count(t, "Custom::S3AutoDeleteObjects")).toBe(1);
    for (const r of Object.values(t.Resources)) {
      if (["AWS::DynamoDB::Table", "AWS::S3::Bucket"].includes(r.Type)) {
        expect(r.DeletionPolicy).toBe("Delete");
      }
    }
    const front = fns(t).find(
      (f) =>
        f.Properties.Handler === "index.handler" &&
        f.Properties.Environment?.Variables?.FLARELET_AUTH_MODE,
    );
    expect(front?.Properties.Environment.Variables.FLARELET_AUTH_MODE).toBe("preview");
  });

  it("auth: false does not make a PR preview public: Preview Auth is forced", async () => {
    const f = join(dir, "flarelet.yaml");
    await writeFile(
      f,
      (await readFile(f, "utf8")).replace("http:\n  auth: true", "http:\n  auth: false"),
    );
    const r = await run(["synth", "--pr", "7"], dir);
    expect(r.code, r.stderr).toBe(0);
    const meta = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    expect(meta).toMatchObject({ stage: "preview", version: "pr-7", lifecycle: "ephemeral" });
    const t = await readTemplate(dir, meta.stacks[0].name);
    // S3 自動削除のカスタムリソースも index.handler なので、環境変数を持つものを選ぶ
    const env = (h: string) =>
      fns(t).find((x) => x.Properties.Handler === h && x.Properties.Environment)?.Properties
        .Environment.Variables ?? {};
    expect(env("index.handler").FLARELET_AUTH_MODE).toBe("preview");
    expect(env("index.handler").FLARELET_PREVIEW_TOKEN_SECRET_ARN).toBeDefined();
    expect(env("flarelet-launcher.sh").FLARELET_AUTH_ENABLED).toBe("true");
    expect(count(t, "AWS::SecretsManager::Secret")).toBe(2);
    expect(count(t, "AWS::Lambda::Permission")).toBe(1);

    const plan = await run(["plan", "--pr", "7"], dir);
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain("+ preview authentication (forced for pull request previews)");
    expect(plan.stdout).not.toContain("public endpoint");

    // 永続 stage では従来どおり公開（front なし、identity() は常に null）
    const prod = await run(["plan", "--stage", "prod", "--version", "v1"], dir);
    expect(prod.stdout).toContain("+ public endpoint (no authentication)");
  });

  it("only preview/pr-N is ephemeral (explicit --stage preview --version pr-N included)", async () => {
    const explicit = await run(["synth", "--stage", "preview", "--version", "pr-8"], dir);
    expect(explicit.code, explicit.stderr).toBe(0);
    const meta1 = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    expect(meta1).toMatchObject({ stage: "preview", version: "pr-8", lifecycle: "ephemeral" });
    expect(meta1.stacks).toHaveLength(1);

    const prod = await run(["synth", "--stage", "prod", "--version", "pr-5"], dir);
    expect(prod.code, prod.stderr).toBe(0);
    const meta2 = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    expect(meta2).toMatchObject({ stage: "prod", version: "pr-5", lifecycle: "persistent" });
    expect(meta2.stacks).toHaveLength(2);
  });

  it("rejects an unresolvable branch with a helpful message", async () => {
    const r = await run(["synth", "--branch", "wip/x", "--default-branch", "main"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("does not match any deployment target");
  });

  it("plan prints the deployment in Flarelet terms", async () => {
    const r = await run(["plan", "--stage", "prod", "--version", "v2"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Flarelet will create");
    expect(r.stdout).toContain("(prod/v2)");
    expect(r.stdout).toContain("+ application version v2");
    expect(r.stdout).toContain("+ database.main");
    expect(r.stdout).toContain("+ storage.files");
    expect(r.stdout).toContain("+ authentication");
    expect(r.stdout).toContain("+ ai.sonnet");
    expect(r.stdout).toContain("flarelet deploy --stage prod --version v2");
    expect(r.stdout).not.toMatch(/AWS::/);
  });

  it("detects the Git branch (main -> prod/current)", async () => {
    await git(["init", "-b", "main"], dir);
    await git(["add", "."], dir);
    await git(["commit", "-m", "init"], dir);
    const r = await run(["synth"], dir);
    expect(r.code, r.stderr).toBe(0);
    const meta = JSON.parse(await readFile(join(dir, ".flarelet", "metadata.json"), "utf8"));
    expect(meta).toMatchObject({ stage: "prod", version: "current" });

    await git(["checkout", "-b", "feature/x"], dir);
    const r2 = await run(["synth"], dir);
    expect(r2.code).toBe(1);
    expect(r2.stderr).toContain('branch "feature/x"');
  });

  it("init refuses to overwrite and .gitignore ignores .flarelet/", async () => {
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".flarelet/");
    const r = await run(["init", "--runtime", "typescript", dir], tmpdir());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already exists");
  });
});

describe("real bundling (no skip)", () => {
  it("bundles a dependency-free typescript app and the front auth Lambda with esbuild", async () => {
    await writeFile(
      join(dir, "flarelet.yaml"),
      "version: 1\nname: bundled\nruntime: { language: typescript }\nhttp: true\n",
    );
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "app", "index.ts"), 'console.log("hello from bundled app");\n');
    const r = await run(["synth", "--stage", "prod", "--version", "v1"], dir, {
      ...process.env,
      AWS_REGION: "us-east-1",
    });
    expect(r.code, r.stderr).toBe(0);
    const assets = (await readdir(join(dir, ".flarelet", "out"))).filter((n) =>
      n.startsWith("asset."),
    );
    expect(assets.length).toBeGreaterThanOrEqual(2);
    const bundles = await Promise.all(
      assets.map(async (a) => {
        const d = join(dir, ".flarelet", "out", a);
        return existsSync(join(d, "index.mjs")) ? readFile(join(d, "index.mjs"), "utf8") : "";
      }),
    );
    expect(bundles.some((b) => b.includes("hello from bundled app"))).toBe(true);
    expect(bundles.some((b) => b.includes("handler"))).toBe(true); // front auth
    const launcherDirs = assets.filter((a) =>
      existsSync(join(dir, ".flarelet", "out", a, "flarelet-launcher.sh")),
    );
    expect(launcherDirs).toHaveLength(1);
  });
});

describe("examples", () => {
  for (const name of ["python", "typescript"]) {
    it(`${name} example synthesizes`, async () => {
      const work = join(dir, name);
      await cp(join(EXAMPLES, name), work, { recursive: true });
      const v = await run(["validate"], work);
      expect(v.code, v.stderr).toBe(0);
      const r = await run(["synth", "--stage", "prod", "--version", "v1"], work);
      expect(r.code, r.stderr).toBe(0);
      const meta = JSON.parse(await readFile(join(work, ".flarelet", "metadata.json"), "utf8"));
      const version = await readTemplate(work, meta.stacks[1].name);
      const app = fns(version).find((f) => f.Properties.Handler === "flarelet-launcher.sh")!;
      expect(app.Properties.Environment.Variables.FLARELET_SECRETS_PATH).toMatch(/\/secrets\/$/);
      expect(
        Object.keys(app.Properties.Environment.Variables).some((k) =>
          k.startsWith("FLARELET_DATABASE_NOTES"),
        ),
      ).toBe(true);
    });
  }
});
