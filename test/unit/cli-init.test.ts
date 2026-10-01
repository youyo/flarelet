/* eslint-disable @typescript-eslint/no-explicit-any -- 生成された JSON/YAML を緩く検査する */
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "../../src/config/index.js";
import { appNameFromDir, runInit } from "../../src/cli/init.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flarelet-init-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
  };
};

describe("appNameFromDir", () => {
  it("derives a valid app name", () => {
    expect(appNameFromDir("/x/My_Cool App")).toBe("my-cool-app");
    expect(appNameFromDir("/x/123")).toBe("app-123");
    expect(appNameFromDir("/x/a")).toBe("myapp");
    expect(appNameFromDir("/x/" + "z".repeat(40))).toHaveLength(24);
  });
});

describe("runInit", () => {
  it("scaffolds a python project (FastAPI + uvicorn)", async () => {
    const t = io();
    const code = await runInit({ dir, runtime: "python" }, t.io);
    expect(code).toBe(0);
    const yaml = await readFile(join(dir, "flarelet.yaml"), "utf8");
    const parsed = parseConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.runtime.language).toBe("python");
    expect(await readFile(join(dir, "app/main.py"), "utf8")).toContain("FastAPI");
    const req = await readFile(join(dir, "app/requirements.txt"), "utf8");
    expect(req).toContain("fastapi");
    expect(req).toContain("uvicorn");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".flarelet/");
  });

  it("tells how to install the AI agent skill", async () => {
    const t = io();
    await runInit({ dir, runtime: "python" }, t.io);
    expect(t.out.join("\n")).toContain("flarelet skill install");
  });

  it("scaffolds a typescript project (Hono)", async () => {
    const code = await runInit({ dir, runtime: "typescript" }, io().io);
    expect(code).toBe(0);
    const parsed = parseConfig(await readFile(join(dir, "flarelet.yaml"), "utf8"));
    expect(parsed.ok && parsed.config.runtime.language).toBe("typescript");
    const src = await readFile(join(dir, "app/index.ts"), "utf8");
    expect(src).toContain("Hono");
    expect(src).toContain("process.env.PORT");
    const pkg = JSON.parse(await readFile(join(dir, "app/package.json"), "utf8"));
    expect(pkg.dependencies.hono).toBeDefined();
    expect(pkg.type).toBe("module");
  });

  it("defaults to python, creates the target dir and names the app after it", async () => {
    const target = join(dir, "sub", "Hello App");
    expect(await runInit({ dir: target }, io().io)).toBe(0);
    const yaml = await readFile(join(target, "flarelet.yaml"), "utf8");
    expect(yaml).toContain("name: hello-app");
    expect(yaml).toContain("language: python");
  });

  it("appends to an existing .gitignore only once", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    await runInit({ dir, runtime: "python" }, io().io);
    const g = await readFile(join(dir, ".gitignore"), "utf8");
    expect(g).toBe("node_modules\n.flarelet/\n");
    await rm(join(dir, "flarelet.yaml"));
    await runInit({ dir, runtime: "python" }, io().io);
    expect((await readFile(join(dir, ".gitignore"), "utf8")).match(/\.flarelet\//g)).toHaveLength(
      1,
    );
  });

  it("refuses to overwrite an existing flarelet.yaml", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "flarelet.yaml"), "keep");
    const t = io();
    expect(await runInit({ dir, runtime: "python" }, t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("already exists");
    expect(await readFile(join(dir, "flarelet.yaml"), "utf8")).toBe("keep");
    expect(existsSync(join(dir, "app"))).toBe(false);
  });

  it("rejects unknown runtimes", async () => {
    const t = io();
    expect(await runInit({ dir, runtime: "ruby" }, t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/python|typescript/);
  });
});

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

describe("runInit GitHub workflow", () => {
  const wf = async (opts: Parameters<typeof runInit>[0]) => {
    const t = io();
    expect(await runInit(opts, t.io)).toBe(0);
    return {
      text: await readFile(join(dir, ".github/workflows/flarelet.yml"), "utf8"),
      out: t.out,
    };
  };

  it("generates a valid workflow with permissions, OIDC, concurrency and PR lifecycle", async () => {
    const { text } = await wf({ dir, runtime: "python", defaultBranch: "trunk" });
    const doc = parseYaml(text) as Record<string, any>;
    expect(doc.permissions).toEqual({
      "id-token": "write",
      contents: "read",
      "pull-requests": "write",
      deployments: "write",
    });
    expect(doc.on.push.branches).toEqual(["trunk"]);
    expect(doc.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "closed"]);
    expect(doc.concurrency.group).toContain("github.event.pull_request.number");
    expect(doc.concurrency["cancel-in-progress"]).toBe(false);
    expect(Object.keys(doc.jobs)).toEqual(["deploy", "destroy"]);
    expect(doc.jobs.deploy.if).toContain("closed");
    expect(doc.jobs.destroy.if).toContain("closed");
    // fork からの PR は OIDC / secrets が使えないので対象外
    expect(doc.jobs.deploy.if).toContain("head.repo.full_name");
    for (const job of Object.values<any>(doc.jobs)) {
      const aws = job.steps.find((s: any) =>
        String(s.uses).startsWith("aws-actions/configure-aws-credentials@"),
      );
      expect(aws.with["role-to-assume"]).toBe("${{ vars.FLARELET_AWS_ROLE_ARN }}");
      expect(aws.with["aws-region"]).toBe("${{ vars.FLARELET_AWS_REGION }}");
    }
    expect(text).toContain("deploy --ci");
    expect(text).toContain("destroy --ci");
    expect(text).toContain("github comment --state ${{ steps.deploy.outcome == 'success'");
    expect(text).toContain("github comment --state inactive");
    expect(text).toContain("FLARELET_PACKAGE");
    // init を実行した CLI 自身のバージョンに固定する
    expect(text).toContain(`'flarelet@${packageJson.version}'`);
    expect(text).not.toContain("flarelet@latest");
    expect(text).not.toMatch(/AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID/);
  });

  it("installs app dependencies only for typescript apps", async () => {
    const ts = await wf({ dir, runtime: "typescript" });
    expect(ts.text).toContain("npm install");
    expect(ts.text).toContain("branches: [main]");
    const dir2 = await mkdtemp(join(tmpdir(), "flarelet-init2-"));
    try {
      const t = io();
      await runInit({ dir: dir2, runtime: "python" }, t.io);
      expect(await readFile(join(dir2, ".github/workflows/flarelet.yml"), "utf8")).not.toContain(
        "npm install",
      );
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  it("never overwrites an existing workflow", async () => {
    await mkdir(join(dir, ".github/workflows"), { recursive: true });
    await writeFile(join(dir, ".github/workflows/flarelet.yml"), "mine: true\n");
    const t = io();
    expect(await runInit({ dir, runtime: "python" }, t.io)).toBe(0);
    expect(await readFile(join(dir, ".github/workflows/flarelet.yml"), "utf8")).toBe(
      "mine: true\n",
    );
    expect(t.out.join("\n")).toMatch(/already exists/);
  });

  it("points to bootstrap and gh variable set in the next steps", async () => {
    const { out } = await wf({ dir, runtime: "python" });
    expect(out.join("\n")).toContain("flarelet bootstrap github --repo");
    expect(out.join("\n")).toContain("FLARELET_AWS_ROLE_ARN");
  });

  it("offers both ways to install the agent skill", async () => {
    const { out } = await wf({ dir, runtime: "python" });
    const text = out.join("\n");
    expect(text).toContain("flarelet skill install");
    expect(text).toContain("npx skills add youyo/flarelet");
  });
});

describe("runInit workflow header", () => {
  it("mentions regeneration after changing git settings", async () => {
    const t = io();
    await runInit({ dir, runtime: "python" }, t.io);
    const text = await readFile(join(dir, ".github/workflows/flarelet.yml"), "utf8");
    expect(text).toContain("flarelet workflow generate --force");
  });
});
