import { afterEach, describe, expect, it } from "vitest";
import { runDeploy } from "../../src/cli/deploy.js";
import { runDestroy } from "../../src/cli/destroy.js";
import type { GitInfo } from "../../src/git/index.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
`;

let h: Harness;
afterEach(async () => h?.cleanup());

const prEvent = (action: string): GitInfo => ({
  pr: 12,
  branch: "feat/x",
  defaultBranch: "main",
  ci: { event: "pull_request", action, repository: "o/r", sha: "abc" },
});

async function setup(git: GitInfo | undefined) {
  h = await harness(YAML, git?.ci ? { GITHUB_ACTIONS: "true" } : {});
  h.deps.detectGit = async () => git ?? {};
}

describe("--ci", () => {
  it("deploy --ci resolves the PR from the GitHub event (preview/pr-12)", async () => {
    await setup(prEvent("synchronize"));
    h.cloud.addStack({ name: "flarelet-myapp-preview-pr-12" });
    h.deployer.result = [
      { name: "flarelet-myapp-preview-pr-12", outputs: { ApiUrl: "https://x/" } },
    ];
    expect(await runDeploy({ file: h.file, ci: true }, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("Deploying myapp (preview/pr-12)");
  });

  it("deploy --ci does nothing for a closed pull request", async () => {
    await setup(prEvent("closed"));
    expect(await runDeploy({ file: h.file, ci: true }, h.deps)).toBe(0);
    expect(h.deployer.outdirs).toEqual([]);
    expect(h.out.join("\n")).toMatch(/closed/);
  });

  it("destroy --ci removes the preview of a closed pull request", async () => {
    await setup(prEvent("closed"));
    h.cloud.addStack({ name: "flarelet-myapp-preview-pr-12" });
    expect(await runDestroy({ file: h.file, ci: true }, h.deps)).toBe(0);
    expect(h.cloud.calls).toContain("deleteStack:flarelet-myapp-preview-pr-12");
  });

  it("destroy --ci refuses an open pull request", async () => {
    await setup(prEvent("synchronize"));
    expect(await runDestroy({ file: h.file, ci: true }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/closed pull request/);
    expect(h.cloud.calls).not.toContain("deleteStack:flarelet-myapp-preview-pr-12");
  });

  it("destroy --ci refuses push events", async () => {
    await setup({ branch: "main", defaultBranch: "main", ci: { event: "push" } });
    expect(await runDestroy({ file: h.file, ci: true }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/closed pull request/);
  });

  it("--ci fails outside GitHub Actions", async () => {
    await setup(undefined);
    expect(await runDeploy({ file: h.file, ci: true }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/GitHub Actions/);
  });
});
