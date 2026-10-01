import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultSkillSource, runSkillInstall } from "../../src/cli/skill.js";

let root: string;
let source: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flareon-skill-"));
  source = join(root, "pkg/.agents/skills/flareon");
  await mkdir(join(source, "references"), { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: flareon\n---\nbody\n");
  await writeFile(join(source, "references/cli.md"), "cli\n");
  await mkdir(join(root, "proj"));
  await mkdir(join(root, "home"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
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

const deps = (t: ReturnType<typeof io>) => ({
  io: t.io,
  cwd: join(root, "proj"),
  home: join(root, "home"),
  source,
});

describe("defaultSkillSource", () => {
  it("resolves to the bundled skill relative to the module", () => {
    expect(existsSync(join(defaultSkillSource(), "SKILL.md"))).toBe(true);
  });
});

describe("runSkillInstall (project)", () => {
  it("copies into .agents/skills/flareon and links .claude/skills/flareon relatively", async () => {
    const t = io();
    const code = await runSkillInstall({}, deps(t));
    expect(code, t.err.join("\n")).toBe(0);
    const entity = join(root, "proj/.agents/skills/flareon");
    expect(readFileSync(join(entity, "SKILL.md"), "utf8")).toContain("name: flareon");
    expect(readFileSync(join(entity, "references/cli.md"), "utf8")).toBe("cli\n");
    const link = join(root, "proj/.claude/skills/flareon");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../../.agents/skills/flareon");
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("name: flareon");
    expect(t.out.join("\n")).toContain(entity);
    expect(t.out.join("\n")).toContain(link);
  });

  it("refuses to overwrite an existing install without --force and changes nothing", async () => {
    await runSkillInstall({}, deps(io()));
    const entity = join(root, "proj/.agents/skills/flareon");
    await writeFile(join(entity, "SKILL.md"), "edited\n");
    const t = io();
    expect(await runSkillInstall({}, deps(t))).toBe(1);
    expect(t.err.join("\n")).toContain("--force");
    expect(readFileSync(join(entity, "SKILL.md"), "utf8")).toBe("edited\n");
  });

  it("--force replaces the files (stale files are removed)", async () => {
    await runSkillInstall({}, deps(io()));
    const entity = join(root, "proj/.agents/skills/flareon");
    await writeFile(join(entity, "stale.md"), "x");
    await writeFile(join(entity, "SKILL.md"), "edited\n");
    const t = io();
    expect(await runSkillInstall({ force: true }, deps(t))).toBe(0);
    expect(existsSync(join(entity, "stale.md"))).toBe(false);
    expect(readFileSync(join(entity, "SKILL.md"), "utf8")).toContain("name: flareon");
    expect(readlinkSync(join(root, "proj/.claude/skills/flareon"))).toBe(
      "../../.agents/skills/flareon",
    );
  });

  it("is idempotent for the link: an existing correct link is left as is", async () => {
    // 実体だけ消えた状態（リンクは正しい）から入れ直しても成功する
    await runSkillInstall({}, deps(io()));
    await rm(join(root, "proj/.agents/skills/flareon"), { recursive: true });
    const t = io();
    // リンクがぶら下がっていても、リンク先が同じなら置き換え不要
    expect(await runSkillInstall({}, deps(t)), t.err.join("\n")).toBe(0);
    expect(readlinkSync(join(root, "proj/.claude/skills/flareon"))).toBe(
      "../../.agents/skills/flareon",
    );
    expect(existsSync(join(root, "proj/.agents/skills/flareon/SKILL.md"))).toBe(true);
  });

  it("refuses when .claude/skills/flareon is a different symlink or a real directory", async () => {
    const link = join(root, "proj/.claude/skills/flareon");
    await mkdir(join(root, "proj/.claude/skills"), { recursive: true });
    await symlink("../../elsewhere", link);
    const t = io();
    expect(await runSkillInstall({}, deps(t))).toBe(1);
    expect(t.err.join("\n")).toContain("--force");
    expect(existsSync(join(root, "proj/.agents/skills/flareon"))).toBe(false);
    expect(readlinkSync(link)).toBe("../../elsewhere");

    expect(await runSkillInstall({ force: true }, deps(io()))).toBe(0);
    expect(readlinkSync(link)).toBe("../../.agents/skills/flareon");

    await rm(link);
    await rm(join(root, "proj/.agents"), { recursive: true });
    await mkdir(link);
    await writeFile(join(link, "mine.md"), "mine");
    const t2 = io();
    expect(await runSkillInstall({}, deps(t2))).toBe(1);
    expect(existsSync(join(link, "mine.md"))).toBe(true);
    expect(await runSkillInstall({ force: true }, deps(io()))).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it("--dir uses that directory as the project root", async () => {
    const t = io();
    const other = join(root, "other");
    await mkdir(other);
    expect(await runSkillInstall({ dir: other }, deps(t))).toBe(0);
    expect(existsSync(join(other, ".agents/skills/flareon/SKILL.md"))).toBe(true);
    expect(lstatSync(join(other, ".claude/skills/flareon")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "proj/.agents"))).toBe(false);
  });

  it("falls back to copying (with a warning) when symlinks cannot be created", async () => {
    const t = io();
    const code = await runSkillInstall(
      {},
      {
        ...deps(t),
        symlink: async () => {
          throw Object.assign(new Error("EPERM"), { code: "EPERM" });
        },
      },
    );
    expect(code).toBe(0);
    const link = join(root, "proj/.claude/skills/flareon");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(link, "SKILL.md"), "utf8")).toContain("name: flareon");
    expect(t.err.join("\n")).toMatch(/symbolic link/i);
  });

  it("fails clearly when the bundled skill is missing", async () => {
    const t = io();
    expect(await runSkillInstall({}, { ...deps(t), source: join(root, "nope") })).toBe(1);
    expect(t.err.join("\n")).toContain("not found");
  });
});

describe("runSkillInstall (--global)", () => {
  it("installs under the home directory", async () => {
    const t = io();
    expect(await runSkillInstall({ global: true }, deps(t))).toBe(0);
    expect(existsSync(join(root, "home/.agents/skills/flareon/SKILL.md"))).toBe(true);
    const link = join(root, "home/.claude/skills/flareon");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe("../../.agents/skills/flareon");
    expect(existsSync(join(root, "proj/.agents"))).toBe(false);
  });

  it("rejects --global together with --dir", async () => {
    const t = io();
    expect(await runSkillInstall({ global: true, dir: "x" }, deps(t))).toBe(1);
    expect(t.err.join("\n")).toContain("--global");
  });
});
