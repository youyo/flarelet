import { execFile } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");

function run(args: string[], cwd: string, env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        res({ code, stdout, stderr });
      },
    );
  });
}

let dir: string;
let home: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flareon-e2e-skill-"));
  home = await mkdtemp(join(tmpdir(), "flareon-e2e-home-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe("flareon skill install (built binary)", () => {
  it("installs the bundled skill into the project, then refuses to overwrite", async () => {
    const r = await run(["skill", "install"], dir);
    expect(r.code, r.stderr).toBe(0);
    const skill = join(dir, ".agents/skills/flareon/SKILL.md");
    expect(readFileSync(skill, "utf8")).toMatch(/^---\nname: flareon\n/);
    expect(existsSync(join(dir, ".agents/skills/flareon/references/cli.md"))).toBe(true);
    const link = join(dir, ".claude/skills/flareon");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../../.agents/skills/flareon");
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toBe(readFileSync(skill, "utf8"));
    expect(r.stdout).toContain(".agents/skills/flareon");

    const again = await run(["skill", "install"], dir);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("--force");

    const forced = await run(["skill", "install", "--force"], dir);
    expect(forced.code, forced.stderr).toBe(0);
  });

  it("--global installs under $HOME", async () => {
    const r = await run(["skill", "install", "--global"], dir, { HOME: home, USERPROFILE: home });
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(home, ".agents/skills/flareon/SKILL.md"))).toBe(true);
    expect(readlinkSync(join(home, ".claude/skills/flareon"))).toBe("../../.agents/skills/flareon");
    expect(existsSync(join(dir, ".agents"))).toBe(false);
  });

  it("init points at flareon skill install", async () => {
    const r = await run(["init", "app1", "--runtime", "typescript"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("flareon skill install");
  });
});
