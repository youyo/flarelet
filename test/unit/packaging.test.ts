import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleFrontAuth, pythonBundling, stageAppSource } from "../../src/constructs/packaging.js";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `flareon-${p}-`));

describe("stageAppSource", () => {
  it("python: copies app files (without caches/venvs) and adds the launcher", () => {
    const app = tmp("app");
    writeFileSync(join(app, "main.py"), "app = None\n");
    writeFileSync(join(app, "requirements.txt"), "fastapi\nuvicorn\n");
    mkdirSync(join(app, "__pycache__"));
    writeFileSync(join(app, "__pycache__", "x.pyc"), "");
    mkdirSync(join(app, ".venv"));
    writeFileSync(join(app, ".venv", "y"), "");
    const out = tmp("stage");
    stageAppSource({ appDir: app, language: "python", stagingDir: out, skipBundling: false });
    expect(existsSync(join(out, "main.py"))).toBe(true);
    expect(existsSync(join(out, "requirements.txt"))).toBe(true);
    expect(existsSync(join(out, "__pycache__"))).toBe(false);
    expect(existsSync(join(out, ".venv"))).toBe(false);
    expect(statSync(join(out, "flareon-launcher.sh")).mode & 0o111).not.toBe(0);
    expect(existsSync(join(out, "flareon-secrets.py"))).toBe(true);
  });

  it("python: requires main.py", () => {
    const app = tmp("app");
    expect(() =>
      stageAppSource({
        appDir: app,
        language: "python",
        stagingDir: tmp("s"),
        skipBundling: false,
      }),
    ).toThrow(/main\.py/);
  });

  it("typescript: bundles app/index.ts with esbuild into index.mjs", () => {
    const app = tmp("app");
    writeFileSync(
      join(app, "index.ts"),
      'const port: number = Number(process.env.PORT ?? 8080);\nconsole.log("listening", port);\n',
    );
    const out = tmp("stage");
    stageAppSource({ appDir: app, language: "typescript", stagingDir: out, skipBundling: false });
    const js = readFileSync(join(out, "index.mjs"), "utf8");
    expect(js).toContain("listening");
    expect(js).not.toContain(": number");
    expect(existsSync(join(out, "flareon-secrets.cjs"))).toBe(true);
    expect(statSync(join(out, "flareon-launcher.sh")).mode & 0o111).not.toBe(0);
  });

  it("typescript: requires app/index.ts", () => {
    expect(() =>
      stageAppSource({
        appDir: tmp("app"),
        language: "typescript",
        stagingDir: tmp("s"),
        skipBundling: false,
      }),
    ).toThrow(/index\.ts/);
  });

  it("typescript with skipBundling copies the source untouched (no esbuild, no dependencies needed)", () => {
    const app = tmp("app");
    writeFileSync(join(app, "index.ts"), 'import { Hono } from "hono";\n');
    const out = tmp("stage");
    stageAppSource({ appDir: app, language: "typescript", stagingDir: out, skipBundling: true });
    expect(existsSync(join(out, "index.ts"))).toBe(true);
    expect(existsSync(join(out, "index.mjs"))).toBe(false);
  });
});

describe("pythonBundling", () => {
  it("builds dependencies in an arm64 SAM build image", () => {
    const b = pythonBundling("3.13");
    expect(b.image.image).toContain("sam/build-python3.13");
    expect(b.platform).toBe("linux/arm64");
    const cmd = (b.command ?? []).join(" ");
    expect(cmd).toMatch(/pip install .*-r requirements\.txt/);
    // deploy の出力を Flareon の進捗に保つため pip は静かにする
    expect(cmd).toMatch(/pip install .*(-q|--quiet)/);
    expect(cmd).toContain("/asset-output");
  });
});

describe("bundleFrontAuth", () => {
  it("bundles a given entry into index.mjs", () => {
    const dir = tmp("entry");
    const entry = join(dir, "handler.ts");
    writeFileSync(entry, "export const handler = async () => ({ statusCode: 200 });\n");
    const out = tmp("front");
    bundleFrontAuth(out, entry);
    const js = readFileSync(join(out, "index.mjs"), "utf8");
    expect(js).toContain("handler");
  });
});
