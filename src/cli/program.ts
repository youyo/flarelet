import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { awsCloud } from "../aws/real.js";
import { toolkitDeployer } from "../aws/toolkit.js";
import { runUserAdd, runUserList, runUserRemove } from "./auth-user.js";
import { synthGithubBootstrap } from "../bootstrap/github.js";
import { gitExec, detectGit } from "../git/index.js";
import { runBootstrapGithub } from "./bootstrap.js";
import { runDeploy } from "./deploy.js";
import { runDestroy } from "./destroy.js";
import { registerDevCommand } from "./dev-command.js";
import { runEnvList, runEnvUrl } from "./env.js";
import { defaultGithub, runGithubComment, type CommentState } from "./github.js";
import { runInit } from "./init.js";
import { readSecretInput } from "./input.js";
import { runLogs } from "./logs.js";
import type { OpsDeps } from "./ops.js";
import { runSecretDelete, runSecretList, runSecretSet } from "./secret.js";
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
      const target = dir ?? ".";
      const exec = gitExec(resolve(target));
      // origin/HEAD が無い新規リポジトリは、現在のブランチ（まだコミットが無くても）を既定ブランチとみなす
      const defaultBranch =
        (await detectGit({ exec })).defaultBranch ??
        (await exec(["symbolic-ref", "--short", "HEAD"]));
      process.exitCode = await runInit(
        {
          dir: target,
          runtime: opts.runtime,
          ...(defaultBranch ? { defaultBranch } : {}),
        },
        io,
      );
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

  const opsDeps = (a: SynthArgs, signal?: AbortSignal): OpsDeps => ({
    ...defaultSynthDeps(io, dirname(a.file)),
    cloud: (region) => awsCloud(region),
    deployer: () => toolkitDeployer(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    readSecret: readSecretInput,
    ...(signal ? { signal } : {}),
  });

  const toArgs = (o: Record<string, unknown>): SynthArgs => {
    const a: SynthArgs = { file: resolve(String(o.file)) };
    for (const k of ["stage", "version", "branch", "defaultBranch", "region"] as const) {
      if (typeof o[k] === "string") a[k] = o[k];
    }
    if (typeof o.pr === "number") a.pr = o.pr;
    if (o.ci === true) a.ci = true;
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
    process.exitCode = await runPlan(a, opsDeps(a));
  });

  targetOptions(
    program
      .command("deploy")
      .description("Deploy the app to AWS and print its URL")
      .option("--ci", "GitHub Actions mode: derive the target from the event (skips closed PRs)"),
  ).action(async (o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runDeploy(a, opsDeps(a));
  });

  targetOptions(
    program
      .command("destroy")
      .description("Remove a deployed version (PR previews are removed entirely)")
      .option(
        "--stage-resources",
        "also permanently delete the stage's database, storage, users and secrets",
      )
      .option("-y, --yes", "confirm --stage-resources")
      .option("--ci", "GitHub Actions mode: only for a closed pull request"),
  ).action(async (o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runDestroy(
      { ...a, stageResources: o.stageResources === true, yes: o.yes === true },
      opsDeps(a),
    );
  });

  const env = program
    .command("env")
    .description("Inspect deployed environments")
    .enablePositionalOptions();
  env
    .command("list")
    .description("List deployed stages and versions")
    .option("-f, --file <path>", "path to the config file", "flareon.yaml")
    .option("--region <region>", "AWS region (default: AWS_REGION or us-east-1)")
    .action(async (o: Record<string, unknown>) => {
      const a = toArgs(o);
      process.exitCode = await runEnvList(a, opsDeps(a));
    });
  targetOptions(
    env
      .command("url")
      .description("Print the URL of a deployed version")
      .option("--with-token", "print a PR preview magic link (contains the preview token)"),
  ).action(async (o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runEnvUrl({ ...a, withToken: o.withToken === true }, opsDeps(a));
  });

  targetOptions(
    program
      .command("logs")
      .description("Show application logs")
      .option("--since <duration>", "how far back to start (e.g. 30s, 10m, 2h)", "10m")
      .option("--follow", "keep streaming new log lines"),
  ).action(async (o: Record<string, unknown>) => {
    const a = toArgs(o);
    const ac = new AbortController();
    const stop = () => ac.abort();
    process.once("SIGINT", stop);
    try {
      process.exitCode = await runLogs(
        { ...a, since: String(o.since), follow: o.follow === true },
        opsDeps(a, ac.signal),
      );
    } finally {
      process.off("SIGINT", stop);
    }
  });

  const secret = program
    .command("secret")
    .description("Manage secrets (exposed to the app as environment variables)")
    .enablePositionalOptions();
  targetOptions(
    secret
      .command("set <name>")
      .description("Set a secret; the value is read from stdin or prompted for"),
  ).action(async (name: string, o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runSecretSet({ ...a, name }, opsDeps(a));
  });
  targetOptions(secret.command("list").description("List secrets (values are not shown)")).action(
    async (o: Record<string, unknown>) => {
      const a = toArgs(o);
      process.exitCode = await runSecretList(a, opsDeps(a));
    },
  );
  targetOptions(secret.command("delete <name>").description("Delete a secret")).action(
    async (name: string, o: Record<string, unknown>) => {
      const a = toArgs(o);
      process.exitCode = await runSecretDelete({ ...a, name }, opsDeps(a));
    },
  );

  const user = program
    .command("auth")
    .description("Manage authentication")
    .enablePositionalOptions()
    .command("user")
    .description("Manage the users who can sign in to a stage")
    .enablePositionalOptions();
  targetOptions(
    user.command("add <email>").description("Invite a user (a temporary password is emailed)"),
  ).action(async (email: string, o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runUserAdd({ ...a, email }, opsDeps(a));
  });
  targetOptions(user.command("list").description("List users")).action(
    async (o: Record<string, unknown>) => {
      const a = toArgs(o);
      process.exitCode = await runUserList(a, opsDeps(a));
    },
  );
  targetOptions(user.command("remove <email>").description("Remove a user")).action(
    async (email: string, o: Record<string, unknown>) => {
      const a = toArgs(o);
      process.exitCode = await runUserRemove({ ...a, email }, opsDeps(a));
    },
  );

  const github = program
    .command("github")
    .description("GitHub integration (for GitHub Actions)")
    .enablePositionalOptions();
  targetOptions(
    github
      .command("comment")
      .description("Create or update the PR comment and GitHub Deployment for a preview")
      .option("--state <state>", "success, failure or inactive", "success")
      .option(
        "--with-token",
        "include the preview magic link (contains the token; private repositories only)",
      ),
  ).action(async (o: Record<string, unknown>) => {
    const state = String(o.state);
    if (!["success", "failure", "inactive"].includes(state)) {
      console.error("Error: --state must be success, failure or inactive");
      process.exitCode = 1;
      return;
    }
    const a = toArgs(o);
    process.exitCode = await runGithubComment(
      { ...a, state: state as CommentState, withToken: o.withToken === true },
      { ...opsDeps(a), github: defaultGithub },
    );
  });

  const bootstrap = program
    .command("bootstrap")
    .description("Prepare the AWS account")
    .enablePositionalOptions();
  bootstrap
    .command("github")
    .description("Create the IAM role GitHub Actions of a repository assumes via OIDC")
    .requiredOption("--repo <owner/name>", "GitHub repository")
    .option("--destroy", "remove the role (and the OIDC provider if Flareon created it)")
    .option("--qualifier <qualifier>", "CDK bootstrap qualifier", "hnb659fds")
    .option("--region <region>", "AWS region (default: AWS_REGION or us-east-1)")
    .action(async (o: Record<string, unknown>) => {
      const a = {
        file: resolve("flareon.yaml"),
        ...(typeof o.region === "string" ? { region: o.region } : {}),
      };
      process.exitCode = await runBootstrapGithub(
        {
          repo: String(o.repo),
          destroy: o.destroy === true,
          qualifier: String(o.qualifier),
          ...(typeof o.region === "string" ? { region: o.region } : {}),
        },
        { ...opsDeps(a), synthBootstrap: synthGithubBootstrap },
      );
    });

  registerDevCommand(program, opsDeps);

  return program;
}
