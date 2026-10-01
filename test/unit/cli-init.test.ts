import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { appNameFromDir, runInit } from "../../src/cli/init.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flareon-init-"));
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
    const yaml = await readFile(join(dir, "flareon.yaml"), "utf8");
    const parsed = parseConfig(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.config.runtime.language).toBe("python");
    expect(await readFile(join(dir, "app/main.py"), "utf8")).toContain("FastAPI");
    const req = await readFile(join(dir, "app/requirements.txt"), "utf8");
    expect(req).toContain("fastapi");
    expect(req).toContain("uvicorn");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toContain(".flareon/");
  });

  it("scaffolds a typescript project (Hono)", async () => {
    const code = await runInit({ dir, runtime: "typescript" }, io().io);
    expect(code).toBe(0);
    const parsed = parseConfig(await readFile(join(dir, "flareon.yaml"), "utf8"));
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
    const yaml = await readFile(join(target, "flareon.yaml"), "utf8");
    expect(yaml).toContain("name: hello-app");
    expect(yaml).toContain("language: python");
  });

  it("appends to an existing .gitignore only once", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules\n");
    await runInit({ dir, runtime: "python" }, io().io);
    const g = await readFile(join(dir, ".gitignore"), "utf8");
    expect(g).toBe("node_modules\n.flareon/\n");
    await rm(join(dir, "flareon.yaml"));
    await runInit({ dir, runtime: "python" }, io().io);
    expect((await readFile(join(dir, ".gitignore"), "utf8")).match(/\.flareon\//g)).toHaveLength(1);
  });

  it("refuses to overwrite an existing flareon.yaml", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "flareon.yaml"), "keep");
    const t = io();
    expect(await runInit({ dir, runtime: "python" }, t.io)).toBe(1);
    expect(t.err.join("\n")).toContain("already exists");
    expect(await readFile(join(dir, "flareon.yaml"), "utf8")).toBe("keep");
    expect(existsSync(join(dir, "app"))).toBe(false);
  });

  it("rejects unknown runtimes", async () => {
    const t = io();
    expect(await runInit({ dir, runtime: "ruby" }, t.io)).toBe(1);
    expect(t.err.join("\n")).toMatch(/python|typescript/);
  });
});
