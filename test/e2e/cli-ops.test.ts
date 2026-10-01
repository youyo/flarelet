// AWS に接続せずに確認できる、運用コマンドの CLI 振る舞い（引数・検証・エラー終了コード）
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");
// 誤って実 AWS に触れないよう、無効な認証情報と存在しないエンドポイントを与える
const ENV = {
  ...process.env,
  FLAREON_SKIP_BUNDLING: "1",
  FLAREON_OFFLINE: "1",
  AWS_REGION: "ap-northeast-1",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "invalid",
  AWS_SESSION_TOKEN: "",
  AWS_PROFILE: "",
  AWS_ENDPOINT_URL: "http://127.0.0.1:9",
  AWS_MAX_ATTEMPTS: "1",
};

function run(args: string[], cwd: string, input?: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    const child = execFile(process.execPath, [CLI, ...args], { cwd, env: ENV }, (err, so, se) => {
      res({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: so,
        stderr: se,
      });
    });
    if (input !== undefined) child.stdin?.end(input);
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flareon-e2e-ops-"));
  await writeFile(
    join(dir, "flareon.yaml"),
    `version: 1
name: opsapp
runtime: { language: typescript }
http: true
database: { main: {} }
secrets: [API_KEY]
`,
  );
  await mkdir(join(dir, "app"));
  await writeFile(join(dir, "app", "index.ts"), "export {};\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("operational commands (no AWS)", () => {
  it("lists the commands in help", async () => {
    const r = await run(["--help"], dir);
    for (const c of ["deploy", "destroy", "plan", "env", "logs", "secret", "auth"]) {
      expect(r.stdout).toContain(c);
    }
    const env = await run(["env", "--help"], dir);
    expect(env.stdout).toMatch(/list/);
    expect(env.stdout).toMatch(/url/);
    const user = await run(["auth", "user", "--help"], dir);
    expect(user.stdout).toMatch(/add/);
    expect(user.stdout).toMatch(/remove/);
  });

  it("deploy accepts the target options", async () => {
    const r = await run(["deploy", "--help"], dir);
    for (const o of ["--stage", "--version", "--branch", "--pr", "--default-branch", "--region"]) {
      expect(r.stdout).toContain(o);
    }
  });

  it("plan stays offline with FLAREON_OFFLINE=1", async () => {
    const r = await run(["plan", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("Flareon will create opsapp (prod/v1)");
    expect(r.stderr).toBe("");
  });

  it("secret set rejects undeclared names and never takes the value as an argument", async () => {
    const r = await run(["secret", "set", "NOPE", "--stage", "prod"], dir, "value\n");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("not declared");
    const extra = await run(["secret", "set", "API_KEY", "the-value", "--stage", "prod"], dir);
    expect(extra.code).toBe(1);
    expect(extra.stderr).toMatch(/too many arguments|unknown/i);
  });

  it("secret set rejects an empty value from stdin", async () => {
    const r = await run(["secret", "set", "API_KEY", "--stage", "prod"], dir, "");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("empty");
  });

  it("destroy --stage-resources requires --yes", async () => {
    const r = await run(
      ["destroy", "--stage", "prod", "--version", "v1", "--stage-resources"],
      dir,
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--yes");
  });

  it("logs validates --since", async () => {
    const r = await run(["logs", "--stage", "prod", "--version", "v1", "--since", "abc"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--since");
  });

  it("auth revoke-sessions is available with the target options", async () => {
    const auth = await run(["auth", "--help"], dir);
    expect(auth.stdout).toMatch(/revoke-sessions/);
    const help = await run(["auth", "revoke-sessions", "--help"], dir);
    expect(help.code).toBe(0);
    for (const o of ["--stage", "--version", "--pr"]) expect(help.stdout).toContain(o);
    // 無効な認証情報なので AWS 呼び出しで失敗する（引数は解釈され、黙って成功しない）
    const r = await run(["auth", "revoke-sessions", "--stage", "prod"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Error/);
  });

  it("auth user add validates the email", async () => {
    const r = await run(["auth", "user", "add", "not-an-email", "--stage", "prod"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("valid email");
  });

  it("env url resolves --version for nested subcommands", async () => {
    const r = await run(["env", "url", "--stage", "prod", "--version", "v1"], dir);
    // 無効な認証情報なので AWS 呼び出しで失敗するが、引数は解釈されている（グローバル --version と衝突しない）
    expect(r.code).toBe(1);
    expect(r.stdout).not.toMatch(/^\d+\.\d+\.\d+/);
    expect(r.stderr).toMatch(/Error/);
  });
});
