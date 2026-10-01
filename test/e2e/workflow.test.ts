// flarelet init / workflow generate / validate の GitHub Actions ワークフロー連動（ビルド済み CLI を実行）
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");

function run(args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (err, stdout, stderr) =>
      res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }),
    );
  });
}

const hasActionlint = (() => {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let wf: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flarelet-e2e-wf-"));
  wf = join(dir, ".github/workflows/flarelet.yml");
  // default branch を main に固定
  await new Promise((res) => execFile("git", ["init", "-b", "main"], { cwd: dir }, res));
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

const branches = async (): Promise<string[]> =>
  (parseYaml(await readFile(wf, "utf8")) as { on: { push: { branches: string[] } } }).on.push
    .branches;

const GIT_YAML = (extra: string) => `version: 1
name: demo
runtime:
  language: python
${extra}`;

describe("workflow follows the git settings", () => {
  it("init generates [main]; after editing git settings, workflow generate re-syncs it", async () => {
    expect((await run(["init", "."], dir)).code).toBe(0);
    expect(await branches()).toEqual(["main"]);
    expect(await readFile(wf, "utf8")).toContain("flarelet workflow generate --force");

    let r = await run(["workflow", "generate"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("up to date");

    await writeFile(
      join(dir, "flarelet.yaml"),
      GIT_YAML(
        "git:\n  production:\n    branch: release/*\n    version: branch\n  preview:\n    branch: default\n",
      ),
    );

    // validate が食い違いを警告（終了コードは 0）
    r = await run(["validate"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toContain("Warning:");
    expect(r.stderr).toContain("flarelet workflow generate --force");

    // --force なしでは上書きしない
    r = await run(["workflow", "generate"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--force");
    expect(await branches()).toEqual(["main"]);

    r = await run(["workflow", "generate", "--force"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(await branches()).toEqual(["release/*", "main"]);

    r = await run(["validate"], dir);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("Warning:");
  });

  it("validate is silent when there is no workflow file", async () => {
    await writeFile(join(dir, "flarelet.yaml"), GIT_YAML("git:\n  preview:\n    branch: dev/*\n"));
    const r = await run(["validate"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stderr).toBe("");
  });

  it("workflow generate creates the file when missing", async () => {
    await writeFile(join(dir, "flarelet.yaml"), GIT_YAML("git:\n  preview:\n    branch: dev/*\n"));
    const r = await run(["workflow", "generate"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(await branches()).toEqual(["main", "dev/*"]);
  });

  it.skipIf(!hasActionlint)("generated workflows pass actionlint", async () => {
    await writeFile(
      join(dir, "flarelet.yaml"),
      GIT_YAML("git:\n  production:\n    branch: release/*\n  preview:\n    branch: default\n"),
    );
    expect((await run(["workflow", "generate"], dir)).code).toBe(0);
    expect(() => execFileSync("actionlint", [wf], { stdio: "pipe" })).not.toThrow();
  });
});
