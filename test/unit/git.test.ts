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
