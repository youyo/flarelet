/** GitHub REST API の最小クライアント（fetch 直接呼び出し）。fetch は差し替え可能。 */

export interface GhComment {
  id: number;
  body: string;
  /** "Bot" | "User" など。マーカーの偽装コメントを更新しないために使う。 */
  userType: string;
}

export type DeploymentState = "success" | "failure" | "inactive" | "in_progress" | "error";

export interface GithubApi {
  getRepo(repo: string): Promise<{ private: boolean }>;
  listComments(repo: string, issue: number): Promise<GhComment[]>;
  createComment(repo: string, issue: number, body: string): Promise<void>;
  updateComment(repo: string, id: number, body: string): Promise<void>;
  createDeployment(
    repo: string,
    d: {
      ref: string;
      environment: string;
      description: string;
      transient: boolean;
      production: boolean;
    },
  ): Promise<number>;
  listDeployments(repo: string, environment: string): Promise<number[]>;
  createDeploymentStatus(
    repo: string,
    id: number,
    s: { state: DeploymentState; environmentUrl?: string; logUrl?: string; description?: string },
  ): Promise<void>;
}

export interface GithubApiOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

const PER_PAGE = 100;

export function githubApi({
  token,
  apiUrl = "https://api.github.com",
  fetch: doFetch = fetch,
}: GithubApiOptions): GithubApi {
  const base = apiUrl.replace(/\/+$/, "");

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "flarelet",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? msg;
      } catch {
        // JSON 以外はそのまま
      }
      throw new Error(`GitHub API ${method} ${path} failed: ${res.status} ${msg}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    getRepo: async (repo) => {
      const r = await call<{ private?: boolean }>("GET", `/repos/${repo}`);
      return { private: r.private === true };
    },
    async listComments(repo, issue) {
      const out: GhComment[] = [];
      for (let page = 1; ; page++) {
        const items = await call<{ id: number; body?: string; user?: { type?: string } }[]>(
          "GET",
          `/repos/${repo}/issues/${issue}/comments?per_page=${PER_PAGE}&page=${page}`,
        );
        for (const c of items) {
          out.push({ id: c.id, body: c.body ?? "", userType: c.user?.type ?? "" });
        }
        if (items.length < PER_PAGE) return out;
      }
    },
    async createComment(repo, issue, body) {
      await call("POST", `/repos/${repo}/issues/${issue}/comments`, { body });
    },
    async updateComment(repo, id, body) {
      await call("PATCH", `/repos/${repo}/issues/comments/${id}`, { body });
    },
    async createDeployment(repo, d) {
      const r = await call<{ id?: number }>("POST", `/repos/${repo}/deployments`, {
        ref: d.ref,
        environment: d.environment,
        description: d.description,
        auto_merge: false,
        required_contexts: [],
        transient_environment: d.transient,
        production_environment: d.production,
      });
      if (typeof r?.id !== "number") throw new Error("GitHub did not create the deployment");
      return r.id;
    },
    async listDeployments(repo, environment) {
      const items = await call<{ id: number }[]>(
        "GET",
        `/repos/${repo}/deployments?environment=${encodeURIComponent(environment)}&per_page=${PER_PAGE}`,
      );
      return items.map((d) => d.id);
    },
    async createDeploymentStatus(repo, id, s) {
      await call("POST", `/repos/${repo}/deployments/${id}/statuses`, {
        state: s.state,
        auto_inactive: true,
        ...(s.environmentUrl ? { environment_url: s.environmentUrl } : {}),
        ...(s.logUrl ? { log_url: s.logUrl } : {}),
        ...(s.description ? { description: s.description } : {}),
      });
    },
  };
}
