import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { runValidate } from "./validate.js";

function packageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("flareon")
    .description("Serverless application platform for AWS")
    .version(packageVersion());

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

  return program;
}
