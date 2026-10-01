import { execFile } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");

function run(args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(process.execPath, [CLI, ...args], { cwd }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      res({ code, stdout, stderr });
    });
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flarelet-e2e-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("flarelet CLI (built binary)", () => {
  it("--version prints the package version", async () => {
    const r = await run(["--version"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("validate succeeds on a valid flarelet.yaml", async () => {
    await writeFile(
      join(dir, "flarelet.yaml"),
      'version: 1\nname: myapp\nruntime:\n  language: python\n  version: "3.13"\nhttp: true\ndatabase:\n  main: {}\n',
    );
    const r = await run(["validate"], dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("flarelet.yaml is valid");
    expect(r.stdout).toContain("myapp");
  });

  it("validate fails with path-annotated errors and exit 1", async () => {
    await writeFile(
      join(dir, "flarelet.yaml"),
      "version: 1\nname: Bad_Name\nruntime:\n  language: ruby\n",
    );
    const r = await run(["validate"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("name:");
    expect(r.stderr).toContain("runtime.language:");
  });

  it("validate fails when flarelet.yaml is missing", async () => {
    const r = await run(["validate"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/flarelet\.yaml.*not found/i);
  });

  it("validate accepts --file", async () => {
    await writeFile(
      join(dir, "other.yaml"),
      "version: 1\nname: myapp\nruntime: { language: typescript }\n",
    );
    const r = await run(["validate", "--file", "other.yaml"], dir);
    expect(r.code).toBe(0);
  });

  it("unknown command exits non-zero", async () => {
    const r = await run(["nope"], dir);
    expect(r.code).not.toBe(0);
  });
});
