import { describe, expect, it } from "vitest";
import { detectGit, type GitExec } from "../../src/git/index.js";

const fake =
  (answers: Record<string, string | null>): GitExec =>
  async (args) =>
    answers[args.join(" ")] ?? null;

describe("detectGit", () => {
  it("detects branch and default branch from origin/HEAD", async () => {
    const r = await detectGit({
      exec: fake({
        "rev-parse --abbrev-ref HEAD": "feature/x",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/main",
      }),
      env: {},
    });
    expect(r).toEqual({ branch: "feature/x", defaultBranch: "main" });
  });

  it("falls back to a local main/master branch for the default branch", async () => {
    const r = await detectGit({
      exec: fake({
        "rev-parse --abbrev-ref HEAD": "main",
        "show-ref --verify --quiet refs/heads/master": "",
      }),
      env: {},
    });
    expect(r.defaultBranch).toBe("master");
  });

  it("uses GITHUB_REF_NAME when HEAD is detached", async () => {
    const r = await detectGit({
      exec: fake({ "rev-parse --abbrev-ref HEAD": "HEAD" }),
      env: { GITHUB_REF_NAME: "release/v1" },
    });
    expect(r.branch).toBe("release/v1");
  });

  it("returns empty when not a git repository", async () => {
    expect(await detectGit({ exec: fake({}), env: {} })).toEqual({});
  });
});

describe("detectGit: pull requests", () => {
  it("reads the PR number from GITHUB_REF", async () => {
    const r = await detectGit({
      exec: fake({ "rev-parse --abbrev-ref HEAD": "HEAD" }),
      env: { GITHUB_REF: "refs/pull/123/merge", GITHUB_REF_NAME: "123/merge" },
    });
    expect(r.pr).toBe(123);
  });
});

describe("detectGit in GitHub Actions", () => {
  const files: Record<string, string> = {
    "/ev/pr.json": JSON.stringify({
      action: "closed",
      number: 7,
      pull_request: { number: 7, head: { sha: "abc123", ref: "feat/x" } },
      repository: { default_branch: "trunk", full_name: "o/r", private: true },
    }),
    "/ev/push.json": JSON.stringify({ repository: { default_branch: "trunk", full_name: "o/r" } }),
  };
  const readFile = async (p: string) => {
    if (!(p in files)) throw new Error("ENOENT");
    return files[p]!;
  };

  it("derives PR number, head branch, default branch and action from the pull_request event", async () => {
    const r = await detectGit({
      exec: fake({}),
      readFile,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: "/ev/pr.json",
        GITHUB_REF: "refs/pull/7/merge",
        GITHUB_REF_NAME: "7/merge",
        GITHUB_HEAD_REF: "feat/x",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_SHA: "mergesha",
      },
    });
    expect(r).toMatchObject({ pr: 7, branch: "feat/x", defaultBranch: "trunk" });
    expect(r.ci).toEqual({
      event: "pull_request",
      action: "closed",
      repository: "o/r",
      sha: "abc123",
      private: true,
    });
  });

  it("uses GITHUB_REF_NAME and the payload default branch for push events", async () => {
    const r = await detectGit({
      exec: fake({ "rev-parse --abbrev-ref HEAD": "HEAD" }),
      readFile,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: "/ev/push.json",
        GITHUB_REF: "refs/heads/trunk",
        GITHUB_REF_NAME: "trunk",
        GITHUB_REF_TYPE: "branch",
        GITHUB_REPOSITORY: "o/r",
        GITHUB_SHA: "pushsha",
      },
    });
    expect(r).toMatchObject({ branch: "trunk", defaultBranch: "trunk" });
    expect(r.pr).toBeUndefined();
    expect(r.ci).toMatchObject({ event: "push", sha: "pushsha", repository: "o/r" });
  });

  it("survives a missing event payload", async () => {
    const r = await detectGit({
      exec: fake({}),
      readFile,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: "/nope.json",
        GITHUB_REF: "refs/pull/9/merge",
        GITHUB_HEAD_REF: "b",
      },
    });
    expect(r).toMatchObject({ pr: 9, branch: "b" });
  });

  it("ignores CI variables outside GitHub Actions", async () => {
    const r = await detectGit({ exec: fake({}), env: { GITHUB_EVENT_NAME: "push" } });
    expect(r.ci).toBeUndefined();
  });
});
