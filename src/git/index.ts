import { execFile } from "node:child_process";

/** git を実行して stdout（trim 済み）を返す。失敗時は null。 */
export type GitExec = (args: string[]) => Promise<string | null>;

export interface GitInfo {
  branch?: string;
  defaultBranch?: string;
  /** CI（GitHub Actions）の pull_request イベントで検出した PR 番号。 */
  pr?: number;
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
}

export async function detectGit({ exec, env = process.env }: DetectOptions): Promise<GitInfo> {
  const out: GitInfo = {};

  const pr = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? "")?.[1];
  if (pr) out.pr = Number(pr);

  let branch = await exec(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (!branch || branch === "HEAD") branch = pr ? null : (env.GITHUB_REF_NAME ?? null); // detached HEAD（CI）
  if (branch) out.branch = branch;

  const origin = await exec(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (origin) {
    out.defaultBranch = origin.replace(/^origin\//, "");
  } else {
    for (const cand of ["main", "master"]) {
      if ((await exec(["show-ref", "--verify", "--quiet", `refs/heads/${cand}`])) !== null) {
        out.defaultBranch = cand;
        break;
      }
    }
  }
  return out;
}
