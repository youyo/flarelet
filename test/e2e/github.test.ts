// GitHub Actions 連携の CLI 振る舞い（実プロセス。AWS / GitHub には接続しない）
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");
const BASE_ENV = {
  ...process.env,
  FLARELET_SKIP_BUNDLING: "1",
  FLARELET_OFFLINE: "1",
  AWS_REGION: "ap-northeast-1",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "invalid",
  AWS_SESSION_TOKEN: "",
  AWS_PROFILE: "",
  AWS_ENDPOINT_URL: "http://127.0.0.1:9",
  AWS_MAX_ATTEMPTS: "1",
  GITHUB_ACTIONS: "",
  GITHUB_TOKEN: "",
};

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...BASE_ENV, ...env } },
      (err, stdout, stderr) =>
        res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}

/** 検証に使うワークフローのキーだけを型付けする。 */
interface WorkflowDoc {
  permissions: Record<string, string>;
  on: { pull_request: { types: string[] } };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flarelet-e2e-gh-"));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

describe("flarelet init (workflow)", () => {
  it("writes .github/workflows/flarelet.yml once and never overwrites it", async () => {
    const proj = join(dir, "myapp");
    const r = await run(["init", "--runtime", "typescript", proj], dir);
    expect(r.code, r.stderr).toBe(0);
    const file = join(proj, ".github/workflows/flarelet.yml");
    const doc = parseYaml(await readFile(file, "utf8")) as WorkflowDoc;
    expect(doc.permissions["id-token"]).toBe("write");
    expect(doc.on.pull_request.types).toContain("closed");
    expect(r.stdout).toContain("flarelet bootstrap github --repo");

    await writeFile(file, "mine: true\n");
    await rm(join(proj, "flarelet.yaml"));
    const again = await run(["init", "--runtime", "typescript", proj], dir);
    expect(again.code).toBe(0);
    expect(await readFile(file, "utf8")).toBe("mine: true\n");
    expect(again.stdout).toContain("already exists");
  });

  it("uses the repository default branch for the push trigger", async () => {
    const proj = join(dir, "trunkapp");
    await mkdir(proj);
    await new Promise((res) => execFile("git", ["init", "-b", "trunk"], { cwd: proj }, res));
    await run(["init", proj], dir);
    expect(await readFile(join(proj, ".github/workflows/flarelet.yml"), "utf8")).toContain(
      "branches: [trunk]",
    );
    expect(existsSync(join(proj, "flarelet.yaml"))).toBe(true);
  });
});

describe("GitHub CLI commands", () => {
  beforeEach(async () => {
    await run(["init", "--runtime", "typescript", dir], tmpdir());
  });

  it("deploy --ci / destroy --ci refuse to run outside GitHub Actions", async () => {
    for (const cmd of ["deploy", "destroy"]) {
      const r = await run([cmd, "--ci"], dir);
      expect(r.code, cmd).toBe(1);
      expect(r.stderr).toContain("GitHub Actions");
    }
  });

  it("deploy --ci skips a closed pull request; destroy --ci refuses an open one", async () => {
    const ev = join(dir, "event.json");
    const env = (action: string) => ({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: ev,
      GITHUB_REF: "refs/pull/5/merge",
      GITHUB_HEAD_REF: "feat/x",
      GITHUB_REPOSITORY: "o/r",
      _action: action,
    });
    await writeFile(ev, JSON.stringify({ action: "closed", pull_request: { number: 5 } }));
    const skipped = await run(["deploy", "--ci"], dir, env("closed"));
    expect(skipped.code, skipped.stderr).toBe(0);
    expect(skipped.stdout).toMatch(/closed/);

    await writeFile(ev, JSON.stringify({ action: "synchronize", pull_request: { number: 5 } }));
    const refused = await run(["destroy", "--ci"], dir, env("synchronize"));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("closed pull request");
  });

  it("synth --ci-style resolution picks preview/pr-N from the event", async () => {
    const ev = join(dir, "event.json");
    await writeFile(
      ev,
      JSON.stringify({
        action: "opened",
        pull_request: { number: 5 },
        repository: { default_branch: "main", full_name: "o/r" },
      }),
    );
    const r = await run(["synth"], dir, {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: ev,
      GITHUB_REF: "refs/pull/5/merge",
      GITHUB_HEAD_REF: "feat/x",
    });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("(preview/pr-5)");
  });

  it("github comment requires GITHUB_TOKEN and a valid --state", async () => {
    const noToken = await run(["github", "comment"], dir);
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain("GITHUB_TOKEN");
    const bad = await run(["github", "comment", "--state", "wat"], dir, { GITHUB_TOKEN: "x" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--state");
  });

  it("bootstrap github validates the repository before touching AWS", async () => {
    for (const repo of ["nonsense", "o/*", "a/b/c"]) {
      const r = await run(["bootstrap", "github", "--repo", repo], dir);
      expect(r.code, repo).toBe(1);
      expect(r.stderr).toContain("owner/name");
    }
    const missing = await run(["bootstrap", "github"], dir);
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("--repo");
  });
});
