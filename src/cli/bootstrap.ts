import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GITHUB_OIDC_URL,
  PROVIDER_STACK,
  parseRepo,
  type Repo,
  providerArn,
  roleStackName,
  synthGithubBootstrap,
} from "../bootstrap/github.js";
import { progressLines } from "./bootstrap-progress.js";
import { errorMessage, type OpsDeps } from "./ops.js";
import { regionOf } from "./synth.js";

export interface BootstrapDeps extends OpsDeps {
  synthBootstrap: typeof synthGithubBootstrap;
}

export interface BootstrapGithubArgs {
  repo: string;
  destroy?: boolean;
  region?: string;
  /** CDK bootstrap のクオリファイア（既定 hnb659fds）。 */
  qualifier?: string;
}

const DEFAULT_QUALIFIER = "hnb659fds";

export async function runBootstrapGithub(
  args: BootstrapGithubArgs,
  deps: BootstrapDeps,
): Promise<number> {
  const { io } = deps;
  let repo: Repo;
  try {
    repo = parseRepo(args.repo);
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
  const slug = `${repo.owner}/${repo.name}`;
  const region = regionOf(args, deps.env);
  const cloud = deps.cloud(region);
  const roleStack = roleStackName(repo);

  try {
    const account = await cloud.account();
    const existing = await cloud.describeStack(roleStack);
    const owner = existing?.tags["flareon:repo"];
    if (existing && owner !== slug) {
      io.stderr(
        `Error: stack ${roleStack} already exists and belongs to ${owner ?? "another owner"}, not ${slug}`,
      );
      return 1;
    }

    if (args.destroy) return await destroy();
    return await create();

    async function create(): Promise<number> {
      const provider = await cloud.findOidcProvider(GITHUB_OIDC_URL);
      const providerStack = await cloud.describeStack(PROVIDER_STACK);
      if (providerStack && !provider) {
        io.stderr(
          `Error: stack ${PROVIDER_STACK} exists but the GitHub OIDC provider is missing; delete that stack first`,
        );
        return 1;
      }
      io.stdout(`Bootstrapping GitHub OIDC access for ${slug} in ${account}/${region}`);
      io.stdout(
        provider
          ? `  OIDC provider: reusing ${provider}${providerStack ? " (managed by Flareon)" : " (not managed by Flareon, left untouched)"}`
          : "  OIDC provider: none in this account, creating one",
      );
      io.stdout("");

      const outdir = await mkdtemp(join(tmpdir(), "flareon-bootstrap-"));
      try {
        deps.synthBootstrap({
          repo,
          account,
          region,
          qualifier: args.qualifier ?? DEFAULT_QUALIFIER,
          createProvider: !provider,
          outdir,
        });
        const stacks = await deps.deployer(region).deploy(outdir, progressLines(io.stdout));
        const arn = stacks.find((s) => s.name === roleStack)?.outputs.RoleArn;
        if (!arn) throw new Error("the role stack did not report a RoleArn output");
        io.stdout("");
        io.stdout(`Role ARN: ${arn}`);
        io.stdout("");
        io.stdout("Set the repository variables used by the generated workflow:");
        io.stdout(`  gh variable set FLAREON_AWS_ROLE_ARN --repo ${slug} --body ${arn}`);
        io.stdout(`  gh variable set FLAREON_AWS_REGION --repo ${slug} --body ${region}`);
        return 0;
      } finally {
        await rm(outdir, { recursive: true, force: true });
      }
    }

    async function destroy(): Promise<number> {
      if (!existing) {
        io.stdout(`${slug} is not bootstrapped in ${account}/${region} (no stack ${roleStack})`);
        return 0;
      }
      io.stdout(`Removing GitHub OIDC access for ${slug}`);
      await cloud.deleteStack(roleStack, () => {});
      io.stdout(`  deleted ${roleStack}`);

      // Flareon が作ったプロバイダだけが対象。他のロールが参照している間は消さない
      if (await cloud.describeStack(PROVIDER_STACK)) {
        const users = await cloud.listRolesTrustingProvider(providerArn(account));
        if (users.length) {
          io.stdout(
            `  kept ${PROVIDER_STACK}: still trusted by ${users.slice(0, 5).join(", ")}${users.length > 5 ? ", ..." : ""}`,
          );
        } else {
          await cloud.deleteStack(PROVIDER_STACK, () => {});
          io.stdout(`  deleted ${PROVIDER_STACK}`);
        }
      }
      return 0;
    }
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
