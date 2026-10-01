import { execFile } from "node:child_process";
import { readFile as fsReadFile } from "node:fs/promises";

/** git を実行して stdout（trim 済み）を返す。失敗時は null。 */
export type GitExec = (args: string[]) => Promise<string | null>;

export interface GitInfo {
  branch?: string;
  defaultBranch?: string;
  /** CI（GitHub Actions）の pull_request イベントで検出した PR 番号。 */
  pr?: number;
  /** GitHub Actions 上で実行されているときの CI 情報。 */
  ci?: CiInfo;
}

export interface CiInfo {
  /** GITHUB_EVENT_NAME（push / pull_request など）。 */
  event: string;
  /** イベントの action（pull_request の opened / synchronize / closed など）。 */
  action?: string;
  /** owner/name。 */
  repository?: string;
  /** デプロイ対象のコミット（PR は head sha）。 */
  sha?: string;
  /** リポジトリが private か（payload にあれば）。 */
  private?: boolean;
}

export const gitExec =
  (cwd: string): GitExec =>
  (args) =>
    new Promise((resolve) => {
      execFile("git", args, { cwd }, (err, stdout) => resolve(err ? null : stdout.trim()));
    });

export interface DetectOptions {
  exec: GitExec;
  env?: Record<string, string | undefined>;
  /** イベント payload（GITHUB_EVENT_PATH）の読み込み。テストで差し替える。 */
  readFile?: (path: string) => Promise<string>;
}

interface EventPayload {
  action?: string;
  pull_request?: { number?: number; head?: { sha?: string } };
  repository?: { default_branch?: string; full_name?: string; private?: boolean };
}

async function readPayload(
  env: Record<string, string | undefined>,
  read: (p: string) => Promise<string>,
): Promise<EventPayload> {
  if (!env.GITHUB_EVENT_PATH) return {};
  try {
    return JSON.parse(await read(env.GITHUB_EVENT_PATH)) as EventPayload;
  } catch {
    return {};
  }
}

export async function detectGit({
  exec,
  env = process.env,
  readFile = (p) => fsReadFile(p, "utf8"),
}: DetectOptions): Promise<GitInfo> {
  const out: GitInfo = {};
  const inCi = env.GITHUB_ACTIONS === "true";
  const payload = inCi ? await readPayload(env, readFile) : {};

  const refPr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1];
  const pr = inCi && payload.pull_request?.number ? payload.pull_request.number : Number(refPr);
  if (pr) out.pr = pr;

  let branch = await exec(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") {
    // detached HEAD（CI）。PR は head ref、push はブランチ名（タグは対象外）
    branch = pr
      ? (env.GITHUB_HEAD_REF ?? null)
      : env.GITHUB_REF_TYPE === "tag"
        ? null
        : (env.GITHUB_REF_NAME ?? null);
  }
  if (inCi && pr && env.GITHUB_HEAD_REF) branch = env.GITHUB_HEAD_REF;
  if (branch) out.branch = branch;

  const payloadDefault = payload.repository?.default_branch;
  const origin = payloadDefault
    ? null
    : await exec(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (payloadDefault) {
    out.defaultBranch = payloadDefault;
  } else if (origin) {
    out.defaultBranch = origin.replace(/^origin\//, "");
  } else {
    for (const cand of ["main", "master"]) {
      if ((await exec(["show-ref", "--verify", "--quiet", `refs/heads/${cand}`])) !== null) {
        out.defaultBranch = cand;
        break;
      }
    }
  }

  if (inCi && env.GITHUB_EVENT_NAME) {
    const repository = payload.repository?.full_name ?? env.GITHUB_REPOSITORY;
    const sha = payload.pull_request?.head?.sha ?? env.GITHUB_SHA;
    out.ci = {
      event: env.GITHUB_EVENT_NAME,
      ...(payload.action ? { action: payload.action } : {}),
      ...(repository ? { repository } : {}),
      ...(sha ? { sha } : {}),
      ...(payload.repository?.private !== undefined ? { private: payload.repository.private } : {}),
    };
  }
  return out;
}
