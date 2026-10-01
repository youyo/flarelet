import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readlink, rm, symlink as fsSymlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Io } from "./validate.js";

/** 実体（エージェント共通の置き場）とリンク（Claude Code 用）の、ルートからの相対パス。 */
const ENTITY_REL = join(".agents", "skills", "flarelet");
const LINK_REL = join(".claude", "skills", "flarelet");

/** パッケージ同梱のスキル。src/cli/ と dist/cli/ のどちらからでも `../../.agents/skills/flarelet`。 */
export function defaultSkillSource(): string {
  return fileURLToPath(new URL("../../.agents/skills/flarelet", import.meta.url));
}

export interface SkillInstallArgs {
  global?: boolean;
  /** プロジェクトのルートとして使うディレクトリ（既定: カレントディレクトリ）。 */
  dir?: string;
  force?: boolean;
}

export interface SkillInstallDeps {
  io: Io;
  cwd: string;
  home: string;
  source: string;
  /** テストで差し替える。 */
  symlink?: (target: string, path: string) => Promise<void>;
}

export const defaultSkillDeps = (io: Io): SkillInstallDeps => ({
  io,
  cwd: process.cwd(),
  home: homedir(),
  source: defaultSkillSource(),
});

type LinkState = "none" | "same" | "other";

async function linkState(path: string, expected: string): Promise<LinkState> {
  let st;
  try {
    st = await lstat(path);
  } catch {
    return "none";
  }
  if (st.isSymbolicLink() && (await readlink(path)) === expected) return "same";
  return "other";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 同梱スキルを `<root>/.agents/skills/flarelet/` にコピーし、`<root>/.claude/skills/flarelet` から相対リンクする。 */
export async function runSkillInstall(
  args: SkillInstallArgs,
  deps: SkillInstallDeps,
): Promise<number> {
  const { io } = deps;
  if (args.global && args.dir !== undefined) {
    io.stderr("Error: --global and --dir cannot be used together");
    return 1;
  }
  if (!existsSync(join(deps.source, "SKILL.md"))) {
    io.stderr(`Error: the bundled skill was not found at ${deps.source}`);
    return 1;
  }

  const root = args.global ? resolve(deps.home) : resolve(deps.cwd, args.dir ?? ".");
  const entity = join(root, ENTITY_REL);
  const link = join(root, LINK_REL);
  const target = relative(dirname(link), entity);

  // 何かを書き換える前に、上書きになるものをすべて確認する
  const state = await linkState(link, target);
  const conflicts: string[] = [];
  if (await pathExists(entity)) conflicts.push(entity);
  if (state === "other") conflicts.push(link);
  if (conflicts.length && !args.force) {
    for (const c of conflicts) io.stderr(`Error: ${c} already exists`);
    io.stderr("Use --force to replace it.");
    return 1;
  }

  if (await pathExists(entity)) await rm(entity, { recursive: true, force: true });
  await mkdir(dirname(entity), { recursive: true });
  await cp(deps.source, entity, { recursive: true });

  let linked = true;
  if (state !== "same") {
    if (state === "other") await rm(link, { recursive: true, force: true });
    await mkdir(dirname(link), { recursive: true });
    try {
      await (deps.symlink ?? fsSymlink)(target, link);
    } catch {
      linked = false;
      io.stderr(
        `Warning: could not create a symbolic link at ${link}; copied the skill there instead (re-run with --force to update both copies)`,
      );
      await cp(deps.source, link, { recursive: true });
    }
  }

  io.stdout(`Installed the flarelet skill: ${entity}`);
  io.stdout(
    linked ? `  ${link} -> ${target}` : `  ${link} (copy; symbolic links are not available here)`,
  );
  return 0;
}
