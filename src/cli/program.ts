import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Argument, Command, InvalidArgumentError, Option } from "commander";
import { awsCloud } from "../aws/real.js";
import { toolkitDeployer } from "../aws/toolkit.js";
import { runRevokeSessions, runUserAdd, runUserList, runUserRemove } from "./auth-user.js";
import { synthGithubBootstrap } from "../bootstrap/github.js";
import { gitExec, detectGit } from "../git/index.js";
import { runBootstrapGithub } from "./bootstrap.js";
import { runCompletion } from "./completion.js";
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
import { defaultSkillDeps, runSkillInstall } from "./skill.js";
import { defaultSynthDeps, runPlan, runSynth, type SynthArgs } from "./synth.js";
import { runValidate, type Io } from "./validate.js";
import { runWorkflowGenerate } from "./workflow-generate.js";

function packageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

/**
 * 補完候補（argChoices）だけを付ける。commander の `.choices()` は検証とエラー文言まで変えてしまうので、
 * 既存のエラーメッセージを保つため候補の宣言だけにする（検証は各コマンド側）。
 */
function withChoices<T extends Option | Argument>(item: T, choices: string[]): T {
  item.argChoices = choices;
  return item;
}

/** origin/HEAD が無い新規リポジトリは、現在のブランチ（まだコミットが無くても）を既定ブランチとみなす。 */
async function detectDefaultBranch(dir: string): Promise<string | undefined> {
  const exec = gitExec(dir);
  return (
    (await detectGit({ exec })).defaultBranch ??
    (await exec(["symbolic-ref", "--short", "HEAD"])) ??
    undefined
  );
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("flarelet")
    .description("Serverless application platform for AWS")
    .version(packageVersion())
    // サブコマンドの --version <version> とグローバルの --version を衝突させない
    .enablePositionalOptions();

  program
    .command("validate")
    .description("Validate flarelet.yaml")
    .option("-f, --file <path>", "path to the config file", "flarelet.yaml")
    .action(async (opts: { file: string }) => {
      const defaultBranch = await detectDefaultBranch(dirname(resolve(opts.file)));
      process.exitCode = await runValidate(
        resolve(opts.file),
        { stdout: (l) => console.log(l), stderr: (l) => console.error(l) },
        defaultBranch ? { defaultBranch } : {},
      );
    });

  const io: Io = { stdout: (l) => console.log(l), stderr: (l) => console.error(l) };

  program
    .command("init [dir]")
    .description("Create flarelet.yaml and a starter app")
    .addOption(
      withChoices(new Option("--runtime <runtime>", "python or typescript").default("python"), [
        "python",
        "typescript",
      ]),
    )
    .action(async (dir: string | undefined, opts: { runtime: string }) => {
      const target = dir ?? ".";
      const defaultBranch = await detectDefaultBranch(resolve(target));
      process.exitCode = await runInit(
        {
          dir: target,
          runtime: opts.runtime,
          ...(defaultBranch ? { defaultBranch } : {}),
        },
        io,
      );
    });

  const workflow = program.command("workflow").description("Manage the GitHub Actions workflow");
  workflow
    .command("generate")
    .description("Generate .github/workflows/flarelet.yml from the git settings in flarelet.yaml")
    .option("-f, --file <path>", "path to the config file", "flarelet.yaml")
    .option("--force", "overwrite the workflow if it differs")
    .option("--default-branch <branch>", "the repository default branch")
    .action(async (opts: { file: string; force?: boolean; defaultBranch?: string }) => {
      const file = resolve(opts.file);
      const defaultBranch = opts.defaultBranch ?? (await detectDefaultBranch(dirname(file)));
      process.exitCode = await runWorkflowGenerate(
        { file, force: opts.force === true, ...(defaultBranch ? { defaultBranch } : {}) },
        io,
      );
    });

  const targetOptions = (cmd: Command): Command =>
    cmd
      .option("-f, --file <path>", "path to the config file", "flarelet.yaml")
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
    program.command("synth").description("Generate the CDK Cloud Assembly into .flarelet/out"),
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
    .option("-f, --file <path>", "path to the config file", "flarelet.yaml")
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

  const auth = program
    .command("auth")
    .description("Manage authentication")
    .enablePositionalOptions();
  targetOptions(
    auth
      .command("revoke-sessions")
      .description("Sign out every session of an environment (takes effect within 60 seconds)"),
  ).action(async (o: Record<string, unknown>) => {
    const a = toArgs(o);
    process.exitCode = await runRevokeSessions(a, opsDeps(a));
  });
  const user = auth
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
      .addOption(
        withChoices(
          new Option("--state <state>", "success, failure or inactive").default("success"),
          ["success", "failure", "inactive"],
        ),
      )
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
    .option("--destroy", "remove the role (and the OIDC provider if Flarelet created it)")
    .option("--qualifier <qualifier>", "CDK bootstrap qualifier", "hnb659fds")
    .option("--region <region>", "AWS region (default: AWS_REGION or us-east-1)")
    .action(async (o: Record<string, unknown>) => {
      const a = {
        file: resolve("flarelet.yaml"),
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

  program
    .command("skill")
    .description("AI coding agent skill")
    .enablePositionalOptions()
    .command("install")
    .description("Install the bundled flarelet skill for AI coding agents (Claude Code etc.)")
    .option("--global", "install for the current user (~/.agents/skills, ~/.claude/skills)")
    .option("--dir <path>", "project root to install into (default: current directory)")
    .option("--force", "replace an existing installation")
    .action(async (o: Record<string, unknown>) => {
      process.exitCode = await runSkillInstall(
        {
          global: o.global === true,
          force: o.force === true,
          ...(typeof o.dir === "string" ? { dir: o.dir } : {}),
        },
        defaultSkillDeps(io),
      );
    });

  registerDevCommand(program, opsDeps);

  program
    .command("completion")
    .description("Print the shell completion script (zsh only)")
    .addArgument(withChoices(new Argument("<shell>", "target shell: zsh"), ["zsh"]))
    .addHelpText(
      "after",
      `
Install (zsh):
  flarelet completion zsh > "\${fpath[1]}/_flarelet"
or add this to ~/.zshrc (after compinit):
  eval "$(flarelet completion zsh)"`,
    )
    .action((shell: string) => {
      process.exitCode = runCompletion(shell, program, io);
    });

  return program;
}
