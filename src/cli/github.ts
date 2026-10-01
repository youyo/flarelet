import { stackNames } from "../constructs/names.js";
import { githubApi, type DeploymentState, type GithubApi } from "../github/api.js";
import { errorMessage, type OpsDeps } from "./ops.js";
import { resolveTarget, type SynthArgs } from "./synth.js";

const PREVIEW_AUTH_PATH = "/__flarelet/auth/preview";

export interface GithubDeps extends OpsDeps {
  github: (o: { token: string; apiUrl?: string }) => GithubApi;
}

export const defaultGithub: GithubDeps["github"] = (o) => githubApi(o);

export type CommentState = "success" | "failure" | "inactive";

export interface GithubCommentArgs extends SynthArgs {
  state: CommentState;
  /** private リポジトリ限定: トークン付きマジックリンクをコメントに含める。 */
  withToken?: boolean;
}

/** PR コメントを 1 件に保つためのマーカー（アプリごと）。 */
export const commentMarker = (app: string): string => `<!-- flarelet:preview:${app} -->`;

interface View {
  app: string;
  stage: string;
  version: string;
  state: CommentState;
  url?: string;
  link?: string;
  prNumber: number;
  protectedByToken: boolean;
  runUrl?: string;
  sha: string;
}

function renderComment(v: View): string {
  const head = `${commentMarker(v.app)}\n### Flarelet preview: \`${v.app}\` (${v.stage}/${v.version})\n`;
  const sha = `Commit: \`${v.sha.slice(0, 7)}\``;
  const run = v.runUrl ? ` · [workflow run](${v.runUrl})` : "";
  if (v.state === "failure") {
    return `${head}\nDeployment failed.${run ? `\n\nSee the${run.replace(" · ", " ")}.` : ""}\n\n${sha}\n`;
  }
  if (v.state === "inactive") {
    return `${head}\nThis preview has been removed.\n`;
  }
  const lines = [head, `**URL:** ${v.url}`, ""];
  if (v.link) {
    lines.push(`**Access link (contains the preview token; keep it private):** ${v.link}`, "");
  } else if (v.protectedByToken) {
    lines.push(
      "This preview is protected by Flarelet preview auth. Get an access link with:",
      "",
      "```",
      `flarelet env url --pr ${v.prNumber} --with-token`,
      "```",
      "",
    );
  }
  lines.push(`${sha}${run}`, "");
  return lines.join("\n");
}

export async function runGithubComment(args: GithubCommentArgs, deps: GithubDeps): Promise<number> {
  const { io, env } = deps;
  const token = env.GITHUB_TOKEN;
  if (!token) {
    io.stderr("Error: GITHUB_TOKEN is not set (pass secrets.GITHUB_TOKEN to this step)");
    return 1;
  }
  const info = await deps.detectGit();
  const ci = info.ci;
  if (!ci?.repository || !ci.sha) {
    io.stderr("Error: flarelet github comment must run in GitHub Actions");
    return 1;
  }
  const repo = ci.repository;
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const { ir, deployment: d } = t;
  const label = `${d.stage}/${d.version}`;
  const environment = `${ir.name}/${d.stage}/${d.version}`;
  const prNumber = info.pr ?? args.pr;
  const api = deps.github({
    token,
    ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}),
  });
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;

  try {
    let url: string | undefined;
    let link: string | undefined;
    let protectedByToken = false;
    if (args.state === "success") {
      const stack = await deps.cloud(t.region).describeStack(stackNames(ir.name, d).version);
      url = stack?.outputs.ApiUrl?.replace(/\/+$/, "");
      if (!stack || !url) {
        io.stderr(`Error: ${ir.name} (${label}) is not deployed`);
        return 1;
      }
      const secretArn = stack.outputs.PreviewTokenSecretArn;
      protectedByToken = secretArn !== undefined;
      if (args.withToken) {
        if (!secretArn) {
          io.stderr(`Error: --with-token is only available for PR previews (${label} is not one)`);
          return 1;
        }
        const repoInfo = await api.getRepo(repo);
        if (!repoInfo.private) {
          io.stderr(
            "Error: --with-token is only allowed for private repositories (the link would be visible to everyone)",
          );
          return 1;
        }
        const secret = (await deps.cloud(t.region).getSecretValue(secretArn)).trim();
        io.stdout(`::add-mask::${secret}`);
        link = `${url}${PREVIEW_AUTH_PATH}?token=${encodeURIComponent(secret)}`;
      }
    }

    if (prNumber !== undefined) {
      const body = renderComment({
        app: ir.name,
        stage: d.stage,
        version: d.version,
        state: args.state,
        ...(url ? { url } : {}),
        ...(link ? { link } : {}),
        prNumber,
        protectedByToken,
        ...(runUrl ? { runUrl } : {}),
        sha: ci.sha,
      });
      const marker = commentMarker(ir.name);
      const existing = (await api.listComments(repo, prNumber)).find(
        (c) => c.userType === "Bot" && c.body.includes(marker),
      );
      if (existing) await api.updateComment(repo, existing.id, body);
      else if (args.state !== "inactive") await api.createComment(repo, prNumber, body);
    }

    if (args.state === "inactive") {
      for (const id of await api.listDeployments(repo, environment)) {
        await api.createDeploymentStatus(repo, id, { state: "inactive" });
      }
    } else {
      const id = await api.createDeployment(repo, {
        ref: ci.sha,
        environment,
        description: `Flarelet ${label}`,
        transient: d.lifecycle === "ephemeral",
        production: d.stage === "prod",
      });
      const state: DeploymentState = args.state;
      await api.createDeploymentStatus(repo, id, {
        state,
        ...(url ? { environmentUrl: url } : {}),
        ...(runUrl ? { logUrl: runUrl } : {}),
      });
    }
    io.stdout(`Updated GitHub for ${ir.name} (${label})${prNumber ? ` on PR #${prNumber}` : ""}`);
    return 0;
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
