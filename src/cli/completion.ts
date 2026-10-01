import { Command, Help, type Option } from "commander";
import type { Io } from "./validate.js";

/** 対応シェル。v0 は zsh のみ。 */
export const COMPLETION_SHELLS = ["zsh"] as const;

/** シングルクォートで囲むだけ（_describe の `name:description` 用。説明中の `:` はそのまま）。 */
function plainQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** 説明文を 1 行にする。 */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 値の補完アクション。choices > ディレクトリ > ファイル > 補完なし（スペース）の順。 */
function valueAction(
  argName: string,
  choices: readonly string[] | undefined,
  long?: string,
): string {
  if (choices && choices.length > 0) return `(${choices.join(" ")})`;
  if (long === "--dir" || argName === "dir") return "_files -/";
  if (argName === "path" || argName === "file") return "_files";
  return " ";
}

/** メッセージ部（`:message:action` の message）。コロンと空白まわりを安全にする。 */
const message = (s: string): string => s.replace(/[\\:]/g, "\\$&").replace(/'/g, "'\\''");

function optionSpec(o: Option): string {
  const flags = [o.short, o.long].filter((f): f is string => !!f);
  const desc = oneLine(o.description)
    .replace(/[\\[\]:]/g, "\\$&")
    .replace(/'/g, "'\\''");
  let tail = "";
  if (o.required || o.optional) {
    const name = /[<[]([^>\]]+)[>\]]/.exec(o.flags)?.[1] ?? "value";
    tail = `${o.optional ? "::" : ":"}${message(name)}:${valueAction(name, o.argChoices, o.long)}`;
  }
  const body = `[${desc}]${tail}`;
  if (flags.length > 1) return `'(${flags.join(" ")})'{${flags.join(",")}}'${body}'`;
  return `'${flags[0] ?? ""}${body}'`;
}

const help = new Help();

function visibleSubcommands(cmd: Command): Command[] {
  return help.visibleCommands(cmd).filter((c) => cmd.commands.includes(c));
}

const fnName = (path: string[]): string => `_${path.join("_").replace(/[^A-Za-z0-9_]/g, "_")}`;

function positionalSpecs(cmd: Command): string[] {
  return cmd.registeredArguments.map((a) => {
    const name = a.name();
    const action = valueAction(name, a.argChoices);
    const lead = a.variadic ? "*" : a.required ? "" : ":";
    return `'${lead}:${message(name)}:${action}'`;
  });
}

function emit(cmd: Command, path: string[], out: string[]): void {
  const subs = visibleSubcommands(cmd);
  const fn = fnName(path);
  const opts = help.visibleOptions(cmd).map(optionSpec);
  // visibleOptions に help / version が含まれない場合に備えて -h/--help を保証する
  if (!help.visibleOptions(cmd).some((o) => o.long === "--help")) {
    opts.unshift(`'(-h --help)'{-h,--help}'[display help for command]'`);
  }
  const L: string[] = [];
  if (subs.length > 0) {
    L.push(`${fn}() {`);
    L.push(`  local curcontext="$curcontext" state line ret=1`);
    L.push(`  typeset -A opt_args`);
    L.push(`  _arguments -C \\`);
    for (const o of opts) L.push(`    ${o} \\`);
    L.push(`    '1: :->cmds' \\`);
    L.push(`    '*::arg:->args' && ret=0`);
    L.push(`  case $state in`);
    L.push(`    cmds)`);
    L.push(`      local -a cmds`);
    L.push(`      cmds=(`);
    for (const s of subs)
      L.push(`        ${plainQuote(`${s.name()}:${oneLine(s.description())}`)}`);
    L.push(`      )`);
    L.push(`      _describe -t commands ${plainQuote(`${path.join(" ")} command`)} cmds && ret=0`);
    L.push(`      ;;`);
    L.push(`    args)`);
    L.push(`      case $line[1] in`);
    for (const s of subs) {
      L.push(`        ${s.name()}) ${fnName([...path, s.name()])} && ret=0 ;;`);
    }
    L.push(`      esac`);
    L.push(`      ;;`);
    L.push(`  esac`);
    L.push(`  return ret`);
    L.push(`}`);
  } else {
    L.push(`${fn}() {`);
    L.push(`  _arguments -S \\`);
    const specs = [...opts, ...positionalSpecs(cmd)];
    specs.forEach((s, i) => L.push(`    ${s}${i < specs.length - 1 ? " \\" : ""}`));
    L.push(`}`);
  }
  out.push(L.join("\n"));
  for (const s of subs) emit(s, [...path, s.name()], out);
}

/** commander の program 定義を走査して zsh 補完スクリプトを生成する（手書きの一覧は持たない）。 */
export function generateZshCompletion(program: Command): string {
  const name = program.name();
  const fns: string[] = [];
  emit(program, [`${name}`], fns);
  // ルート関数名は `_<name>`（path の先頭が name なので fnName で `_flareon` になる）
  return [
    `#compdef ${name}`,
    "",
    `# ${name} の zsh 補完。\`${name} completion zsh\` が commander の定義から生成した。`,
    ...fns.map((f) => `${f}\n`),
    `if [ "$funcstack[1]" = "_${name}" ]; then`,
    `  _${name} "$@"`,
    `else`,
    `  compdef _${name} ${name}`,
    `fi`,
    "",
  ].join("\n");
}

/** `flareon completion <shell>` の本体。 */
export function runCompletion(shell: string, program: Command, io: Io): number {
  if (shell !== "zsh") {
    io.stderr(`Error: unsupported shell "${shell}" (supported: ${COMPLETION_SHELLS.join(", ")})`);
    return 1;
  }
  io.stdout(generateZshCompletion(program).trimEnd());
  return 0;
}
