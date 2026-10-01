import { Command, Option } from "commander";
import { describe, expect, it } from "vitest";
import { generateZshCompletion, runCompletion } from "../../src/cli/completion.js";
import { createProgram } from "../../src/cli/program.js";

const program = createProgram();
const script = generateZshCompletion(program);

/** 隠しでない（help 以外の）サブコマンドを再帰的に集める。 */
function walk(cmd: Command, path: string[] = []): { path: string[]; cmd: Command }[] {
  return cmd.commands.flatMap((sub) => {
    const p = [...path, sub.name()];
    return [{ path: p, cmd: sub }, ...walk(sub, p)];
  });
}

describe("generateZshCompletion", () => {
  it("is a zsh completion script defining _flarelet", () => {
    expect(script.startsWith("#compdef flarelet\n")).toBe(true);
    expect(script).toContain("_flarelet() {");
    expect(script).toContain("compdef _flarelet flarelet");
  });

  it("contains every command (nested too) of the program", () => {
    const all = walk(program);
    expect(all.length).toBeGreaterThan(10);
    for (const { path, cmd } of all) {
      expect(script, path.join(" ")).toContain(`_flarelet_${path.join("_").replace(/-/g, "_")}()`);
      expect(script, path.join(" ")).toContain(`'${cmd.name()}:`);
    }
    for (const p of [
      "env list",
      "env url",
      "secret set",
      "secret list",
      "secret delete",
      "auth user add",
      "auth user list",
      "auth user remove",
      "auth revoke-sessions",
      "bootstrap aws",
      "bootstrap github",
      "github comment",
      "skill install",
      "completion",
    ]) {
      expect(
        all.map((c) => c.path.join(" ")),
        p,
      ).toContain(p);
    }
  });

  it("contains every option (long and short) and its description", () => {
    for (const { path, cmd } of [{ path: [] as string[], cmd: program }, ...walk(program)]) {
      for (const o of cmd.options) {
        if (o.long) expect(script, `${path.join(" ")} ${o.long}`).toContain(o.long);
        if (o.short) expect(script, `${path.join(" ")} ${o.short}`).toContain(o.short);
      }
    }
    expect(script).toContain("Deploy the app to AWS and print its URL");
    expect(script).toContain("path to the config file");
  });

  it("completes values: runtime / state / shell choices", () => {
    expect(script).toContain(":runtime:(python typescript)");
    expect(script).toContain(":state:(success failure inactive)");
    expect(script).toContain(":shell:(zsh)");
  });

  it("completes files for -f/--file and directories for --dir and [dir]", () => {
    expect(script).toContain(":path:_files");
    expect(script).toMatch(/--dir\]?[^\n]*_files -\//);
    expect(script).toMatch(/:dir:_files -\//);
  });

  it("does not complete --stage / --version dynamically", () => {
    expect(script).not.toMatch(/--stage[^\n]*_(?!files)/);
    expect(script).toMatch(/--stage\[[^\n]*:stage: /);
  });

  it("escapes characters special to _arguments in descriptions", () => {
    const p = new Command("flarelet");
    p.option("--x <v>", "list [a] and b: c \\ d 'quoted'");
    const s = generateZshCompletion(p);
    expect(s).toContain("\\[a\\]");
    expect(s).toContain("b\\: c");
    expect(s).toContain("\\\\ d");
    expect(s).toContain("'\\''quoted'\\''");
  });

  it("excludes hidden commands and options", () => {
    const p = new Command("flarelet");
    p.command("visible").description("v");
    p.command("secretcmd", { hidden: true }).description("h");
    p.option("--shown", "s");
    p.addOption(new Option("--nope-hidden").hideHelp());
    const s = generateZshCompletion(p);
    expect(s).toContain("'visible:");
    expect(s).not.toContain("secretcmd");
    expect(s).not.toContain("nope-hidden");
    expect(s).toContain("--shown");
  });
});

describe("runCompletion", () => {
  const mk = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
    };
  };

  it("prints the zsh script", () => {
    const { out, io } = mk();
    expect(runCompletion("zsh", program, io)).toBe(0);
    expect(out.join("\n")).toContain("#compdef flarelet");
  });

  it("rejects unknown shells with exit 1 and a clear message", () => {
    const { out, err, io } = mk();
    expect(runCompletion("fish", program, io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("\n")).toMatch(/unsupported shell "fish".*zsh/i);
  });
});

describe("program wiring", () => {
  it("registers `completion <shell>` and documents usage in --help", () => {
    const c = program.commands.find((x) => x.name() === "completion");
    expect(c).toBeDefined();
    let help = "";
    c?.configureOutput({ writeOut: (s) => (help += s) });
    c?.outputHelp();
    expect(help).toContain("_flarelet");
    expect(help).toContain("eval");
  });

  it("keeps --runtime / --state validation messages unchanged (no commander choices())", () => {
    const init = program.commands.find((x) => x.name() === "init");
    const rt = init?.options.find((o) => o.long === "--runtime");
    expect(rt?.argChoices).toEqual(["python", "typescript"]);
    expect(rt?.parseArg).toBeUndefined();
  });
});
