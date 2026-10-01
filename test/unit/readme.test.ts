import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli/program.js";
import { extractFlareonCommands, findCommandProblems } from "./skill-commands.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const EN = join(ROOT, "README.md");
const JA = join(ROOT, "README.ja.md");

const read = (p: string) => readFileSync(p, "utf8");

/** コードフェンスの外にある、指定レベルの見出し。 */
function headings(md: string, prefix: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    else if (!fenced && line.startsWith(prefix)) out.push(line);
  }
  return out;
}

const fences = (md: string): number => (md.match(/^\s*```/gm) ?? []).length;

describe("README", () => {
  it("README.md and README.ja.md exist and link to each other near the top", () => {
    expect(existsSync(EN)).toBe(true);
    expect(existsSync(JA)).toBe(true);
    expect(read(EN).split("\n").slice(0, 8).join("\n")).toContain("(README.ja.md)");
    expect(read(JA).split("\n").slice(0, 8).join("\n")).toContain("(README.md)");
  });

  it("both have the CI badge", () => {
    const badge = "![CI](https://github.com/youyo/flareon/actions/workflows/ci.yml/badge.svg)";
    expect(read(EN)).toContain(badge);
    expect(read(JA)).toContain(badge);
  });

  it("have the same structure (## / ### headings and code blocks)", () => {
    expect(headings(read(JA), "## ").length).toBe(headings(read(EN), "## ").length);
    expect(headings(read(JA), "### ").length).toBe(headings(read(EN), "### ").length);
    expect(fences(read(JA))).toBe(fences(read(EN)));
  });

  it("every `flareon <cmd>` mentioned exists in the CLI", () => {
    const program = createProgram();
    for (const file of [EN, JA]) {
      const cmds = extractFlareonCommands(read(file));
      expect(cmds.length).toBeGreaterThan(20);
      for (const c of cmds) {
        expect(findCommandProblems(program, c), `${file}: flareon ${c}`).toEqual([]);
      }
    }
  });

  it("documents every top-level command", () => {
    const program = createProgram();
    for (const file of [EN, JA]) {
      const md = read(file);
      for (const c of program.commands) {
        expect(md, `${file}: flareon ${c.name()}`).toContain(`flareon ${c.name()}`);
      }
    }
  });

  it("README.ja.md is shipped in the npm package", () => {
    const pkg = JSON.parse(read(join(ROOT, "package.json"))) as { files: string[] };
    expect(pkg.files).toContain("README.ja.md");
  });
});
