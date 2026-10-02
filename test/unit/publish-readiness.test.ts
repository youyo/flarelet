import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createProgram } from "../../src/cli/program.js";

const ROOT = resolve(import.meta.dirname, "../..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const pkg = JSON.parse(read("package.json")) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("package.json metadata for npm", () => {
  it("is public, MIT and has repository metadata", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe("flarelet");
    expect(pkg.license).toBe("MIT");
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/youyo/flarelet.git",
    });
    expect(pkg.homepage).toContain("github.com/youyo/flarelet");
    expect(pkg.bugs.url).toContain("github.com/youyo/flarelet/issues");
    expect(pkg.keywords.length).toBeGreaterThan(0);
    expect(pkg.engines).toEqual({ node: ">=24" });
    expect(pkg.publishConfig).toEqual({ access: "public", provenance: true });
  });

  it("ships LICENSE, and the LICENSE is MIT for youyo 2026", () => {
    expect(pkg.files).toContain("LICENSE");
    const text = read("LICENSE");
    expect(text).toMatch(/^MIT License/);
    expect(text).toContain("Copyright (c) 2026 youyo");
  });

  it("`flarelet --version` prints the version in package.json", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    let out = "";
    const program = createProgram();
    program.configureOutput({ writeOut: (s) => (out += s) }).exitOverride();
    expect(() => program.parse(["node", "flarelet", "--version"])).toThrow();
    expect(out.trim()).toBe(pkg.version);
  });
});

describe("release workflow", () => {
  const text = read(".github/workflows/release.yml");
  const doc = parseYaml(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("runs on v* tags with OIDC permissions and stores no npm token", () => {
    expect(doc.on.push.tags).toEqual(["v*"]);
    expect(doc.permissions["id-token"]).toBe("write");
    expect(text).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("verifies like CI, checks the tag against package.json, then publishes", () => {
    for (const cmd of [
      "mise run install",
      "mise run lint",
      "mise run typecheck",
      "mise run test",
      "mise run pack:check",
      "npm publish",
      "gh release create",
    ]) {
      expect(text, cmd).toContain(cmd);
    }
    expect(text).toContain("GITHUB_REF_NAME");
    expect(text.indexOf("GITHUB_REF_NAME")).toBeLessThan(text.indexOf("npm publish"));
  });
});

describe("repository policy files", () => {
  it("has SECURITY.md pointing to private vulnerability reporting", () => {
    expect(read("SECURITY.md")).toMatch(/private vulnerability reporting/i);
  });
  it("has dependabot config for npm and github-actions", () => {
    const doc = parseYaml(read(".github/dependabot.yml")) as {
      updates: { "package-ecosystem": string; schedule: { interval: string } }[];
    };
    expect(doc.updates.map((u) => u["package-ecosystem"]).sort()).toEqual([
      "github-actions",
      "npm",
    ]);
    for (const u of doc.updates) expect(u.schedule.interval).toBe("weekly");
  });
});

describe("no real AWS account IDs in tracked files", () => {
  // 753240598075 は AWS が公開している Lambda Web Adapter レイヤーの提供元アカウント（秘匿情報ではない）
  const PUBLIC = new Set(["123456789012", "753240598075"]);
  const isDummy = (id: string) => PUBLIC.has(id) || /^(\d)\1{11}$/.test(id); // 000000000000 / 111111111111 など
  it("only dummy 12-digit account IDs appear", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
      .split("\0")
      .filter((f) => f !== "" && f !== "package-lock.json");
    const hits: string[] = [];
    for (const f of files) {
      const abs = join(ROOT, f);
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (!st?.isFile() || !existsSync(abs)) continue;
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue; // バイナリ
      // Actions を固定するコミット SHA（40 桁 16 進）は 12 桁の数字列を含みうるが、アカウント ID ではない
      const text = buf.toString("utf8").replace(/@[0-9a-f]{40}\b/g, "@<sha>");
      for (const m of text.matchAll(/(?<![0-9])[0-9]{12}(?![0-9])/g)) {
        if (!isDummy(m[0])) hits.push(`${f}: ${m[0]}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
