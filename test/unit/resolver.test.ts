import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { toIR } from "../../src/ir/index.js";
import { resolveDeployment, ResolveError } from "../../src/resolver/index.js";

const gitIR = (git: string) => {
  const r = parseConfig(`version: 1\nname: myapp\nruntime: { language: python }\n${git}`);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config).git;
};
const personal = gitIR(
  'git:\n  production: { branch: "release/*", version: branch }\n  preview: { branch: default }\n  pullRequests: true\n',
);
const defaults = gitIR("");
const branch = (name: string) => ({ type: "branch" as const, name });
const pr = (n: number) => ({ type: "pr" as const, number: n });

describe("resolveDeployment: default mapping", () => {
  it("default branch -> prod/current (persistent)", () => {
    expect(
      resolveDeployment({ git: defaults, defaultBranch: "main", ref: branch("main") }),
    ).toEqual({
      stage: "prod",
      version: "current",
      lifecycle: "persistent",
    });
  });
  it("PR -> preview/pr-N (ephemeral)", () => {
    expect(resolveDeployment({ git: defaults, defaultBranch: "main", ref: pr(123) })).toEqual({
      stage: "preview",
      version: "pr-123",
      lifecycle: "ephemeral",
    });
  });
  it("other branch -> error", () => {
    expect(() =>
      resolveDeployment({ git: defaults, defaultBranch: "main", ref: branch("feature/x") }),
    ).toThrow(ResolveError);
  });
});

describe("resolveDeployment: spec section 8 example", () => {
  const r = (ref: ReturnType<typeof branch> | ReturnType<typeof pr>) =>
    resolveDeployment({ git: personal, defaultBranch: "main", ref });
  it("main -> preview/current (persistent)", () => {
    expect(r(branch("main"))).toEqual({
      stage: "preview",
      version: "current",
      lifecycle: "persistent",
    });
  });
  it("release/v1 -> prod/v1", () => {
    expect(r(branch("release/v1"))).toEqual({
      stage: "prod",
      version: "v1",
      lifecycle: "persistent",
    });
  });
  it("release/v2 -> prod/v2", () => {
    expect(r(branch("release/v2")).version).toBe("v2");
  });
  it("PR #123 -> preview/pr-123", () => {
    expect(r(pr(123))).toEqual({ stage: "preview", version: "pr-123", lifecycle: "ephemeral" });
  });
  it("sanitizes branch-derived versions for stack names", () => {
    expect(r(branch("release/v1.2")).version).toBe("v1-2");
    expect(r(branch("release/V3_Beta")).version).toBe("v3-beta");
  });
  it("unmatched branch -> error mentioning the branch", () => {
    expect(() => r(branch("feature/login"))).toThrow(/feature\/login/);
  });
  it("release/ with empty match -> error", () => {
    expect(() => r(branch("release/"))).toThrow(ResolveError);
  });
  it("* does not cross slashes", () => {
    expect(() => r(branch("release/v1/hotfix"))).toThrow(ResolveError);
  });
  it("glob metacharacters are literal (dots do not match any char)", () => {
    const git = gitIR('git:\n  production: { branch: "rel.*" }\n');
    expect(() => resolveDeployment({ git, defaultBranch: "main", ref: branch("relx1") })).toThrow(
      ResolveError,
    );
    expect(resolveDeployment({ git, defaultBranch: "main", ref: branch("rel.1") }).stage).toBe(
      "prod",
    );
  });
});

describe("resolveDeployment: options", () => {
  it("pullRequests: false -> PR is an error", () => {
    const git = gitIR("git:\n  pullRequests: false\n");
    expect(() => resolveDeployment({ git, defaultBranch: "main", ref: pr(1) })).toThrow(
      ResolveError,
    );
  });
  it("fixed version string for production", () => {
    const git = gitIR('git:\n  production: { branch: "release/*", version: stable }\n');
    expect(
      resolveDeployment({ git, defaultBranch: "main", ref: branch("release/v9") }).version,
    ).toBe("stable");
  });
  it("preview branch given as explicit name", () => {
    const git = gitIR("git:\n  preview: { branch: develop }\n");
    expect(resolveDeployment({ git, defaultBranch: "main", ref: branch("develop") })).toEqual({
      stage: "preview",
      version: "current",
      lifecycle: "persistent",
    });
  });
  it("production takes precedence when default branch matches both", () => {
    const git = gitIR("git:\n  preview: { branch: default }\n");
    expect(resolveDeployment({ git, defaultBranch: "main", ref: branch("main") }).stage).toBe(
      "prod",
    );
  });
});

describe("resolveDeployment: CLI args", () => {
  it("--stage and --version win without any git ref", () => {
    expect(resolveDeployment({ git: personal, stage: "prod", version: "v3" })).toEqual({
      stage: "prod",
      version: "v3",
      lifecycle: "persistent",
    });
  });
  it("pr-N versions are ephemeral", () => {
    expect(resolveDeployment({ git: personal, stage: "preview", version: "pr-5" }).lifecycle).toBe(
      "ephemeral",
    );
  });
  it("--stage only: version from git if resolvable else current", () => {
    expect(resolveDeployment({ git: personal, stage: "prod" }).version).toBe("current");
    expect(
      resolveDeployment({
        git: personal,
        stage: "prod",
        defaultBranch: "main",
        ref: branch("release/v4"),
      }).version,
    ).toBe("v4");
  });
  it("--version only needs git for the stage", () => {
    expect(
      resolveDeployment({
        git: personal,
        version: "v7",
        defaultBranch: "main",
        ref: branch("main"),
      }),
    ).toMatchObject({ stage: "preview", version: "v7" });
    expect(() => resolveDeployment({ git: personal, version: "v7" })).toThrow(ResolveError);
  });
  it("no ref and no args -> error", () => {
    expect(() => resolveDeployment({ git: personal })).toThrow(ResolveError);
  });
  it("validates stage and version names", () => {
    expect(() => resolveDeployment({ git: personal, stage: "Prod!", version: "v1" })).toThrow(
      ResolveError,
    );
    expect(() => resolveDeployment({ git: personal, stage: "prod", version: "v 1" })).toThrow(
      ResolveError,
    );
  });
  it("branch ref needs defaultBranch only when mapping uses 'default'", () => {
    expect(() => resolveDeployment({ git: defaults, ref: branch("main") })).toThrow(ResolveError);
  });
});

describe("resolveDeployment: ephemeral only for PR previews (preview/pr-N)", () => {
  it("release/pr-5 resolves to prod/pr-5 and stays persistent", () => {
    expect(
      resolveDeployment({ git: personal, defaultBranch: "main", ref: branch("release/pr-5") }),
    ).toEqual({ stage: "prod", version: "pr-5", lifecycle: "persistent" });
  });
  it("--pr 5 -> preview/pr-5 (ephemeral)", () => {
    expect(resolveDeployment({ git: defaults, defaultBranch: "main", ref: pr(5) })).toEqual({
      stage: "preview",
      version: "pr-5",
      lifecycle: "ephemeral",
    });
  });
  it("explicit --stage preview --version pr-5 names the PR preview (same as --pr 5)", () => {
    expect(resolveDeployment({ git: defaults, stage: "preview", version: "pr-5" })).toEqual(
      resolveDeployment({ git: defaults, defaultBranch: "main", ref: pr(5) }),
    );
  });
  it("pr-N under any other stage is an ordinary persistent version", () => {
    expect(resolveDeployment({ git: defaults, stage: "prod", version: "pr-5" }).lifecycle).toBe(
      "persistent",
    );
    expect(
      resolveDeployment({ git: defaults, stage: "staging", defaultBranch: "main", ref: pr(5) }),
    ).toEqual({ stage: "staging", version: "pr-5", lifecycle: "persistent" });
  });
});
