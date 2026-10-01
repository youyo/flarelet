import { userInfo } from "node:os";
import { resolve } from "node:path";
import { type Command, InvalidArgumentError } from "commander";
import { synthesizeDev } from "../constructs/dev.js";
import { startLocal } from "../dev/session.js";
import { DEFAULT_DEV_PORT, runDev, type DevArgs } from "./dev.js";
import type { OpsDeps } from "./ops.js";
import type { SynthArgs } from "./synth.js";

function osUser(): string {
  try {
    return userInfo().username;
  } catch {
    return process.env.USER ?? process.env.USERNAME ?? "";
  }
}

const untilStopped = (): Promise<void> =>
  new Promise((r) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      r();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });

/** `flarelet dev` を登録する。 */
export function registerDevCommand(program: Command, opsDeps: (a: SynthArgs) => OpsDeps): void {
  program
    .command("dev")
    .description(
      "Run the app locally with hot reload, connected to AWS dev resources (preview/local-<user>)",
    )
    .option("-f, --file <path>", "path to the config file", "flarelet.yaml")
    .option("--port <port>", `local port (default: ${DEFAULT_DEV_PORT})`, (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) {
        throw new InvalidArgumentError("must be a port number");
      }
      return n;
    })
    .option("--stage <stage>", "connect to an existing environment instead (with --version)")
    .option("--version <version>", "connect to an existing environment instead (with --stage)")
    .option("--as <email>", "simulate a signed-in user (adds x-flarelet-* identity headers)")
    .option("--region <region>", "AWS region (default: AWS_REGION or us-east-1)")
    .action(async (o: Record<string, unknown>) => {
      const a: DevArgs = { file: resolve(String(o.file)) };
      for (const k of ["stage", "version", "region", "as"] as const) {
        if (typeof o[k] === "string") a[k] = o[k];
      }
      if (typeof o.port === "number") a.port = o.port;
      process.exitCode = await runDev(a, {
        ...opsDeps({ file: a.file }),
        username: osUser,
        synthesizeDev,
        startLocal,
        untilStopped,
      });
    });
}
