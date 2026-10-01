import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");
const DRIVER = resolve(import.meta.dirname, "completion-driver.zsh");

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, ...env }, timeout: 60_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        res({ code, stdout, stderr });
      },
    );
  });
}
const cli = (args: string[]) => run(process.execPath, [CLI, ...args]);

let dir: string;
let script: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "flarelet-e2e-completion-"));
  const r = await cli(["completion", "zsh"]);
  expect(r.code, r.stderr).toBe(0);
  script = join(dir, "_flarelet");
  await writeFile(script, r.stdout);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("flarelet completion (built binary)", () => {
  it("prints a zsh script that passes `zsh -n`", async () => {
    expect((await cli(["completion", "zsh"])).stdout).toMatch(/^#compdef flarelet\n/);
    const r = await run("zsh", ["-n", script]);
    expect(r.code, r.stderr).toBe(0);
  });

  it("rejects other shells with exit 1", async () => {
    const r = await cli(["completion", "fish"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/unsupported shell "fish".*zsh/);
  });

  it("has usage in --help", async () => {
    const r = await cli(["completion", "--help"]);
    expect(r.stdout).toContain('eval "$(flarelet completion zsh)"');
  });

  it("defines _flarelet after compinit + source (fpath file and eval styles)", async () => {
    const sh = `autoload -Uz compinit && compinit -u -d ${dir}/dump1 && source ${script} && whence -w _flarelet && (( $+_comps[flarelet] )) && print registered`;
    const r = await run("zsh", ["-f", "-c", sh], { HOME: dir });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("_flarelet: function");
    expect(r.stdout).toContain("registered");
  });

  it("offers real completion candidates through zpty", async () => {
    const r = await run(
      "zsh",
      [
        "-f",
        DRIVER,
        script,
        dir,
        "flarelet ",
        "flarelet auth ",
        "flarelet init --runtime ",
        "flarelet github comment --state ",
        "flarelet completion ",
        "flarelet env ",
      ],
      { HOME: dir },
    );
    expect(r.code, r.stderr).toBe(0);
    const sec = (line: string) => {
      const parts = r.stdout.split(/^=== /m);
      const hit = parts.find((p) => p.startsWith(`${line}\n`));
      expect(hit, `${line}\n${r.stdout}`).toBeDefined();
      return hit ?? "";
    };
    const top = sec("flarelet ");
    for (const c of ["deploy", "destroy", "auth", "secret", "completion", "skill"]) {
      expect(top, c).toContain(c);
    }
    const auth = sec("flarelet auth ");
    expect(auth).toContain("user");
    expect(auth).toContain("revoke-sessions");
    expect(auth).not.toContain("deploy");
    const rt = sec("flarelet init --runtime ");
    expect(rt).toContain("python");
    expect(rt).toContain("typescript");
    const state = sec("flarelet github comment --state ");
    for (const c of ["success", "failure", "inactive"]) expect(state, c).toContain(c);
    expect(sec("flarelet completion ")).toContain("zsh");
    const env = sec("flarelet env ");
    expect(env).toContain("list");
    expect(env).toContain("url");
  }, 60_000);
});
