import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 改名（旧名 → Flarelet）の漏れ検出。旧名はこのファイル自身に一致しないよう分割して組み立てる。
 * 旧名を書いてよいのは docs/specs/DECISIONS.md の改名経緯の節だけ。
 */
const OLD = new RegExp("flare" + "on", "i");
const ROOT = resolve(import.meta.dirname, "../..");
const DECISIONS = "docs/specs/DECISIONS.md";
const RENAME_HEADING = /^## 改名（2026-10-02）/;

const trackedFiles = (): string[] =>
  execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((f) => f !== "");

/** DECISIONS.md の改名節（見出しから次の `## ` 見出しまで）の行番号（0 始まり）。 */
function renameSectionLines(lines: string[]): Set<number> {
  const out = new Set<number>();
  const start = lines.findIndex((l) => RENAME_HEADING.test(l));
  if (start < 0) return out;
  out.add(start);
  for (let i = start + 1; i < lines.length && !/^## /.test(lines[i] ?? ""); i++) out.add(i);
  return out;
}

describe("改名漏れ", () => {
  it("追跡ファイルのパスに旧名を含まない", () => {
    expect(trackedFiles().filter((f) => OLD.test(f))).toEqual([]);
  });

  it("追跡ファイルの内容に旧名を含まない（DECISIONS.md の改名節を除く）", () => {
    const hits: string[] = [];
    for (const f of trackedFiles()) {
      const abs = join(ROOT, f);
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (!st) continue; // 作業ツリーで削除済み
      const text = st.isSymbolicLink() ? readlinkSync(abs) : readFileSync(abs, "utf8");
      const lines = text.split("\n");
      const allowed = f === DECISIONS ? renameSectionLines(lines) : new Set<number>();
      lines.forEach((l, i) => {
        if (OLD.test(l) && !allowed.has(i)) hits.push(`${f}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it("DECISIONS.md に改名の経緯の節がある", () => {
    const lines = readFileSync(join(ROOT, DECISIONS), "utf8").split("\n");
    const section = [...renameSectionLines(lines)].map((i) => lines[i]).join("\n");
    expect(section).toMatch(OLD);
    expect(section).toContain("Flarelet");
  });
});
