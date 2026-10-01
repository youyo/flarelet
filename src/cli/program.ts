import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { runInit } from "./init.js";
import { defaultSynthDeps, runPlan, runSynth, type SynthArgs } from "./synth.js";
import { runValidate, type Io } from "./validate.js";

function packageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("flareon")
    .description("Serverless application platform for AWS")
    .version(packageVersion())
    // サブコマンドの --version <version> とグローバルの --version を衝突させない
    .enablePositionalOptions();

  program
    .command("validate")
    .description("Validate flareon.yaml")
    .option("-f, --file <path>", "path to the config file", "flareon.yaml")
    .action(async (opts: { file: string }) => {
      process.exitCode = await runValidate(resolve(opts.file), {
        stdout: (l) => console.log(l),
        stderr: (l) => console.error(l),
      });
    });

  const io: Io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };

  program
    .command("init [dir]")
    .description("Create flareon.yaml and a starter app")
    .option("--runtime <runtime>", "python or typescript", "python")
    .action(async (dir: string | undefined, opts: { runtime: string }) => {
      process.exitCode = await runInit({ dir: dir ?? ".", runtime: opts.runtime }, io);
    });

  const targetOptions = (cmd: Command): Command =>
    cmd
      .option("-f, --file <path>", "path to the config file", "flareon.yaml")
      .option("--stage <stage>", "stage name (overrides Git)")
      .option("--version <version>", "version name (overrides Git)")
      .option("--branch <branch>", "Git branch to resolve (default: current branch)")
      .option("--pr <number>", "pull request number to resolve", (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n <= 0)
          throw new InvalidArgumentError("must be a positive integer");
        return n;
      })
      .option("--default-branch <branch>", "the repository default branch")
      .option("--region <region>", "AWS region (default: AWS_REGION or us-east-1)");

  const toArgs = (o: Record<string, unknown>): SynthArgs => {
    const a: SynthArgs = { file: resolve(String(o.file)) };
    for (const k of ["stage", "version", "branch", "defaultBranch", "region"] as const) {
      if (typeof o[k] === "string") a[k] = o[k];
    }
    if (typeof o.pr === "number") a.pr = o.pr;
    return a;
  };

  targetOptions(
    program.command("synth").description("Generate the CDK Cloud Assembly into .flareon/out"),
  ).action(async (o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runSynth(a, defaultSynthDeps(io, dirname(a.file)));
  });

  targetOptions(
    program.command("plan").description("Show what a deployment would create or change"),
  ).action(async (o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runPlan(a, defaultSynthDeps(io, dirname(a.file)));
  });

  return program;
}
