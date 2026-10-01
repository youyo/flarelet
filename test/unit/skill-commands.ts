import type { Command } from "commander";

/** Markdown の code span / code block から `flareon ...` のコマンド列（`flareon ` 以降）を取り出す。 */
export function extractFlareonCommands(md: string): string[] {
  const spans: string[] = [];
  for (const m of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) spans.push(...(m[1] ?? "").split("\n"));
  const withoutBlocks = md.replace(/```[\s\S]*?```/g, "");
  for (const m of withoutBlocks.matchAll(/`([^`\n]+)`/g)) spans.push(m[1] ?? "");
  const out: string[] = [];
  for (const s of spans) {
    for (const m of s.matchAll(/(?:^|[\s(])flareon ([a-z][^\n#>&;]*)/g)) {
      out.push((m[1] ?? "").replace(/[|[\]]/g, " ").trim());
    }
  }
  return out;
}

/** コマンドと --オプションが program に実在するかを検査し、問題の一覧を返す。 */
export function findCommandProblems(program: Command, cmd: string): string[] {
  const problems: string[] = [];
  const tokens = cmd.split(/\s+/).filter(Boolean);
  let cur = program;
  let descending = true;
  const first = tokens[0] ?? "";
  if (!program.commands.some((c) => c.name() === first)) {
    return [`unknown command "${first}"`];
  }
  for (const t of tokens) {
    if (t.startsWith("--")) {
      const flag = t.split("=")[0]?.replace(/[.,:;)]+$/, "") ?? t;
      const known = [cur, ...ancestors(cur)].some((c) => c.options.some((o) => o.long === flag));
      if (!known && flag !== "--help" && flag !== "--version") {
        problems.push(`unknown option ${flag} for "${cur.name()}"`);
      }
      descending = false;
      continue;
    }
    if (!descending) continue;
    const sub = cur.commands.find((c) => c.name() === t);
    if (sub) cur = sub;
    else descending = false;
  }
  return problems;
}

function ancestors(cmd: Command): Command[] {
  const out: Command[] = [];
  for (let p = cmd.parent; p; p = p.parent) out.push(p);
  return out;
}
