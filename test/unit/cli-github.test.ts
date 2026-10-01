import { afterEach, describe, expect, it } from "vitest";
import { commentMarker, runGithubComment, type GithubDeps } from "../../src/cli/github.js";
import type { DeploymentState, GhComment, GithubApi } from "../../src/github/api.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
`;

class FakeGithub implements GithubApi {
  calls: string[] = [];
  comments: GhComment[] = [];
  isPrivate = false;
  deployments: number[] = [];
  statuses: { id: number; state: DeploymentState; url?: string }[] = [];
  created: unknown[] = [];
  async getRepo() {
    return { private: this.isPrivate };
  }
  async listComments() {
    return this.comments;
  }
  async createComment(_r: string, _i: number, body: string) {
    this.calls.push("create");
    this.comments.push({ id: 100 + this.comments.length, body, userType: "Bot" });
  }
  async updateComment(_r: string, id: number, body: string) {
    this.calls.push(`update:${id}`);
    const c = this.comments.find((x) => x.id === id)!;
    c.body = body;
  }
  async createDeployment(_r: string, d: unknown) {
    this.created.push(d);
    this.deployments.push(900 + this.deployments.length);
    return this.deployments.at(-1)!;
  }
  async listDeployments() {
    return this.deployments;
  }
  async createDeploymentStatus(
    _r: string,
    id: number,
    s: { state: DeploymentState; environmentUrl?: string },
  ) {
    this.statuses.push({
      id,
      state: s.state,
      ...(s.environmentUrl ? { url: s.environmentUrl } : {}),
    });
  }
}

let h: Harness;
let gh: FakeGithub;
afterEach(async () => h?.cleanup());

async function setup(env: Record<string, string> = {}, prNumber: number | null = 12) {
  h = await harness(YAML, {
    GITHUB_ACTIONS: "true",
    GITHUB_TOKEN: "ghs_secret",
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_RUN_ID: "55",
    ...env,
  });
  gh = new FakeGithub();
  h.deps.detectGit = async () => ({
    ...(prNumber !== null ? { pr: prNumber } : {}),
    branch: prNumber !== null ? "feat/x" : "main",
    defaultBranch: "main",
    ci: {
      event: prNumber !== null ? "pull_request" : "push",
      repository: "o/r",
      sha: "abc123",
    },
  });
  (h.deps as GithubDeps).github = () => gh;
  h.cloud.addStack({
    name: "flareon-myapp-preview-pr-12",
    outputs: {
      ApiUrl: "https://abc.execute-api.ap-northeast-1.amazonaws.com/",
      PreviewTokenSecretArn: "arn:secret",
    },
  });
  h.cloud.secrets.set("arn:secret", "TOKEN123\n");
  return h.deps as GithubDeps;
}

describe("runGithubComment", () => {
  it("creates one PR comment and a successful deployment with the URL (no token)", async () => {
    const deps = await setup();
    expect(await runGithubComment({ file: h.file, state: "success" }, deps)).toBe(0);
    expect(gh.comments).toHaveLength(1);
    const body = gh.comments[0]!.body;
    expect(body).toContain(commentMarker("myapp"));
    expect(body).toContain("https://abc.execute-api.ap-northeast-1.amazonaws.com");
    expect(body).toContain("flareon env url --pr 12 --with-token");
    expect(body).not.toContain("TOKEN123");
    expect(gh.created[0]).toMatchObject({
      ref: "abc123",
      environment: "myapp/preview/pr-12",
      transient: true,
      production: false,
    });
    expect(gh.statuses).toEqual([
      { id: 900, state: "success", url: "https://abc.execute-api.ap-northeast-1.amazonaws.com" },
    ]);
  });

  it("updates the existing marker comment instead of adding another", async () => {
    const deps = await setup();
    gh.comments.push({ id: 7, body: `${commentMarker("myapp")}\nold`, userType: "Bot" });
    gh.comments.push({ id: 8, body: "unrelated", userType: "User" });
    await runGithubComment({ file: h.file, state: "success" }, deps);
    await runGithubComment({ file: h.file, state: "success" }, deps);
    expect(gh.calls).toEqual(["update:7", "update:7"]);
    expect(gh.comments).toHaveLength(2);
  });

  it("ignores marker comments written by non-bot users", async () => {
    const deps = await setup();
    gh.comments.push({ id: 7, body: `${commentMarker("myapp")} fake`, userType: "User" });
    await runGithubComment({ file: h.file, state: "success" }, deps);
    expect(gh.calls).toEqual(["create"]);
  });

  it("includes the magic link only with --with-token on a private repository", async () => {
    const deps = await setup();
    gh.isPrivate = true;
    expect(await runGithubComment({ file: h.file, state: "success", withToken: true }, deps)).toBe(
      0,
    );
    expect(gh.comments[0]!.body).toContain("/__flareon/auth/preview?token=TOKEN123");
    // ログでマスクされるよう ::add-mask:: を出す
    expect(h.out.join("\n")).toContain("::add-mask::TOKEN123");
    expect(h.out.join("\n")).not.toMatch(/token=TOKEN123/);
  });

  it("refuses --with-token on a public repository", async () => {
    const deps = await setup();
    gh.isPrivate = false;
    expect(await runGithubComment({ file: h.file, state: "success", withToken: true }, deps)).toBe(
      1,
    );
    expect(h.err.join("\n")).toMatch(/private/);
    expect(gh.comments).toHaveLength(0);
  });

  it("reports a failed deployment without a URL", async () => {
    const deps = await setup();
    expect(await runGithubComment({ file: h.file, state: "failure" }, deps)).toBe(0);
    expect(gh.comments[0]!.body).toMatch(/failed/i);
    expect(gh.comments[0]!.body).toContain("https://github.com/o/r/actions/runs/55");
    expect(gh.statuses[0]!.state).toBe("failure");
  });

  it("marks deployments inactive and updates the comment after destroy", async () => {
    const deps = await setup();
    await runGithubComment({ file: h.file, state: "success" }, deps);
    h.cloud.stacks.clear();
    expect(await runGithubComment({ file: h.file, state: "inactive" }, deps)).toBe(0);
    expect(gh.statuses.at(-1)).toEqual({ id: 900, state: "inactive" });
    expect(gh.comments[0]!.body).toMatch(/removed/i);
    expect(gh.calls.at(-1)).toBe("update:100");
  });

  it("posts only a deployment for push events (no PR comment)", async () => {
    const deps = await setup({}, null);
    h.cloud.addStack({
      name: "flareon-myapp-prod-current",
      outputs: { ApiUrl: "https://prod.example/" },
    });
    expect(
      await runGithubComment(
        { file: h.file, state: "success", stage: "prod", version: "current" },
        deps,
      ),
    ).toBe(0);
    expect(gh.comments).toHaveLength(0);
    expect(gh.created[0]).toMatchObject({
      environment: "myapp/prod/current",
      transient: false,
      production: true,
    });
  });

  it("requires GITHUB_TOKEN and a GitHub Actions environment", async () => {
    const deps = await setup({ GITHUB_TOKEN: "" });
    expect(await runGithubComment({ file: h.file, state: "success" }, deps)).toBe(1);
    expect(h.err.join("\n")).toContain("GITHUB_TOKEN");
  });

  it("fails when the preview is not deployed", async () => {
    const deps = await setup();
    h.cloud.stacks.clear();
    expect(await runGithubComment({ file: h.file, state: "success" }, deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/not deployed/);
  });
});
