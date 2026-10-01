import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { launcherFiles, LAUNCHER_HANDLER } from "../../src/constructs/launcher.js";

describe("launcher files", () => {
  it("python launcher fetches secrets with boto3 and execs uvicorn", () => {
    const f = launcherFiles("python");
    expect(LAUNCHER_HANDLER).toBe("flarelet-launcher.sh");
    const sh = f[LAUNCHER_HANDLER]!;
    expect(sh.mode).toBe(0o755);
    expect(sh.content.startsWith("#!/bin/sh\n")).toBe(true);
    expect(sh.content).toContain("FLARELET_SECRETS_PATH");
    expect(sh.content).toContain("exec python3 -m uvicorn main:app --host 0.0.0.0");
    expect(sh.content).toContain('"${PORT:-8080}"');
    expect(f["flarelet-secrets.py"]!.content).toContain("boto3");
    expect(f["flarelet-secrets.py"]!.content).toContain("get_parameters_by_path");
  });

  it("typescript launcher uses the AWS SDK v3 helper and execs node", () => {
    const f = launcherFiles("typescript");
    expect(f[LAUNCHER_HANDLER]!.content).toContain("exec node");
    expect(f[LAUNCHER_HANDLER]!.content).toContain("index.mjs");
    expect(f["flarelet-secrets.cjs"]!.content).toContain("@aws-sdk/client-ssm");
  });

  it("node helper formats exports safely (quotes, reserved and invalid names)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flarelet-launcher-"));
    const file = join(dir, "flarelet-secrets.cjs");
    writeFileSync(file, launcherFiles("typescript")["flarelet-secrets.cjs"]!.content);
    const mod = createRequire(import.meta.url)(file) as {
      formatExports: (path: string, params: { Name: string; Value: string }[]) => string;
    };
    const out = mod.formatExports("/flarelet/app/prod/secrets/", [
      { Name: "/flarelet/app/prod/secrets/API_KEY", Value: 'it\'s $(danger) "x"' },
      { Name: "/flarelet/app/prod/secrets/FLARELET_APP", Value: "evil" },
      { Name: "/flarelet/app/prod/secrets/lower", Value: "x" },
    ]);
    expect(out).toBe(`export API_KEY='it'\\''s $(danger) "x"'\n`);
    // シェルで評価しても値がそのまま入る
    const echoed = execFileSync("sh", ["-c", `${out}\nprintf %s "$API_KEY"`]).toString();
    expect(echoed).toBe(`it's $(danger) "x"`);
  });

  it("python helper prints shell-safe exports (stubbed boto3)", () => {
    const dir = mkdtempSync(join(tmpdir(), "flarelet-launcher-py-"));
    writeFileSync(
      join(dir, "flarelet-secrets.py"),
      launcherFiles("python")["flarelet-secrets.py"]!.content,
    );
    writeFileSync(
      join(dir, "boto3.py"),
      `class _C:
    def get_parameters_by_path(self, **kw):
        assert kw["Path"] == "/flarelet/app/prod/secrets/" and kw["WithDecryption"]
        return {"Parameters": [
            {"Name": "/flarelet/app/prod/secrets/API_KEY", "Value": "it's $(x)"},
            {"Name": "/flarelet/app/prod/secrets/AWS_REGION", "Value": "no"},
        ]}
def client(name):
    assert name == "ssm"
    return _C()
`,
    );
    const out = execFileSync("python3", [join(dir, "flarelet-secrets.py")], {
      env: { ...process.env, FLARELET_SECRETS_PATH: "/flarelet/app/prod/secrets", PYTHONPATH: dir },
    }).toString();
    const echoed = execFileSync("sh", ["-c", `${out}\nprintf %s "$API_KEY"`]).toString();
    expect(echoed).toBe("it's $(x)");
    expect(out).not.toContain("AWS_REGION");
  });

  it("shell launcher propagates a failing secrets fetch and execs the app", () => {
    const dir = mkdtempSync(join(tmpdir(), "flarelet-launcher-sh-"));
    const sh = join(dir, "run.sh");
    // python3 / uvicorn を差し替えて、失敗時に app が起動しないことを確認する
    writeFileSync(
      join(dir, "python3"),
      '#!/bin/sh\nif [ "$1" = "-m" ]; then echo started; else exit 3; fi\n',
    );
    chmodSync(join(dir, "python3"), 0o755);
    writeFileSync(
      sh,
      launcherFiles("python")[LAUNCHER_HANDLER]!.content.replace(/\$LAMBDA_TASK_ROOT/g, dir),
    );
    chmodSync(sh, 0o755);
    let failed = false;
    try {
      execFileSync(sh, [], { env: { PATH: `${dir}:/usr/bin:/bin`, FLARELET_SECRETS_PATH: "/x" } });
    } catch {
      failed = true;
    }
    expect(failed).toBe(true);
    const ok = execFileSync(sh, [], { env: { PATH: `${dir}:/usr/bin:/bin` } }).toString();
    expect(ok).toContain("started");
    expect(readFileSync(sh, "utf8")).toContain("set -e");
  });
});
