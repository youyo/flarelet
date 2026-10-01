import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { createProgram } from "../../src/cli/program.js";
import { parseConfig } from "../../src/config/index.js";
import { extractFlareletCommands, findCommandProblems } from "./skill-commands.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SKILL_DIR = join(ROOT, ".agents/skills/flarelet");
const SKILL_MD = join(SKILL_DIR, "SKILL.md");

const read = (p: string) => readFileSync(p, "utf8");

function frontmatter(md: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) throw new Error("no frontmatter");
  return parseYaml(m[1] ?? "") as Record<string, unknown>;
}

function mdFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? mdFiles(join(dir, e.name))
      : e.name.endsWith(".md")
        ? [join(dir, e.name)]
        : [],
  );
}

describe("skill layout", () => {
  it("lives in .agents/skills/flarelet with SKILL.md and references/", () => {
    expect(existsSync(SKILL_MD)).toBe(true);
    expect(existsSync(join(SKILL_DIR, "references/cli.md"))).toBe(true);
    expect(existsSync(join(SKILL_DIR, "references/flarelet-yaml.md"))).toBe(true);
  });

  it(".claude/skills/flarelet is a relative symlink to the real skill", () => {
    const link = join(ROOT, ".claude/skills/flarelet");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../../.agents/skills/flarelet");
    expect(realpathSync(join(link, "SKILL.md"))).toBe(realpathSync(SKILL_MD));
  });
});

describe("npm package", () => {
  it("ships the skill (files includes .agents/skills, not the .claude symlink)", () => {
    const pkg = JSON.parse(read(join(ROOT, "package.json"))) as { files: string[] };
    expect(pkg.files).toContain(".agents/skills");
    expect(pkg.files.some((f) => f.startsWith(".claude"))).toBe(false);
  });
});

describe("SKILL.md frontmatter", () => {
  const fm = () => frontmatter(read(SKILL_MD));

  it("has name matching the directory name", () => {
    expect(fm().name).toBe("flarelet");
  });

  it("has a concrete description with trigger words", () => {
    const d = fm().description;
    expect(typeof d).toBe("string");
    const s = d as string;
    expect(s.length).toBeGreaterThan(80);
    expect(s.length).toBeLessThanOrEqual(1024);
    for (const w of ["flarelet", "flarelet.yaml", "preview environment"]) {
      expect(s.toLowerCase()).toContain(w);
    }
  });
});

describe("markdown links", () => {
  it("every relative link in the skill resolves to an existing file", () => {
    for (const file of mdFiles(SKILL_DIR)) {
      const links = [...read(file).matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1] ?? "");
      for (const l of links) {
        if (/^[a-z]+:/i.test(l) || l.startsWith("#")) continue;
        const target = resolve(dirname(file), l.split("#")[0] ?? "");
        expect(existsSync(target), `${file} -> ${l}`).toBe(true);
      }
    }
  });

  it("SKILL.md links to both references", () => {
    const md = read(SKILL_MD);
    expect(md).toContain("references/cli.md");
    expect(md).toContain("references/flarelet-yaml.md");
  });
});

describe("drift: commands in the skill exist in the CLI", () => {
  const program = createProgram();

  it("every flarelet command and option written in the skill exists", () => {
    for (const file of mdFiles(SKILL_DIR)) {
      const cmds = extractFlareletCommands(read(file));
      expect(cmds.length, file).toBeGreaterThan(0);
      for (const c of cmds) {
        expect(findCommandProblems(program, c), `${file}: flarelet ${c}`).toEqual([]);
      }
    }
  });

  it("references/cli.md documents every command and every option", () => {
    const cli = read(join(SKILL_DIR, "references/cli.md"));
    const walk = (cmd: ReturnType<typeof createProgram>, path: string[]): void => {
      for (const sub of cmd.commands) {
        const p = [...path, sub.name()];
        if (sub.commands.length === 0) {
          expect(cli, `command ${p.join(" ")}`).toContain(`flarelet ${p.join(" ")}`);
          for (const o of sub.options) {
            if (o.long) expect(cli, `${p.join(" ")} ${o.long}`).toContain(o.long);
          }
        }
        walk(sub, p);
      }
    };
    walk(program, []);
  });
});

describe("drift: flarelet-yaml.md examples", () => {
  it("all yaml examples that declare `version: 1` pass the real schema", () => {
    const md = read(join(SKILL_DIR, "references/flarelet-yaml.md"));
    const blocks = [...md.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    const full = blocks.filter((b) => /^version: 1/m.test(b));
    expect(full.length).toBeGreaterThanOrEqual(3);
    for (const b of full) {
      const r = parseConfig(b);
      expect(r.ok, b).toBe(true);
    }
  });
});
