/* eslint-disable @typescript-eslint/no-explicit-any -- 生成された YAML を緩く検査する */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runWorkflowGenerate } from "../../src/cli/workflow-generate.js";
import {
  checkWorkflowDrift,
  pushBranchesOf,
  toActionsBranchPattern,
  workflowBranches,
  workflowTemplate,
} from "../../src/cli/workflow.js";
import type { GitIR } from "../../src/ir/index.js";

const git = (over: Partial<GitIR> = {}): GitIR => ({
  production: { branch: "default", version: "current" },
  preview: null,
  pullRequests: true,
  ...over,
});

describe("toActionsBranchPattern", () => {
  it("keeps * and ** (same semantics as GitHub branch filters)", () => {
    expect(toActionsBranchPattern("release/*")).toBe("release/*");
    expect(toActionsBranchPattern("feature/**")).toBe("feature/**");
    expect(toActionsBranchPattern("main")).toBe("main");
  });
  it("escapes characters that are special only in GitHub filters", () => {
    expect(toActionsBranchPattern("a+b")).toBe("a\\+b");
    expect(toActionsBranchPattern("a?b")).toBe("a\\?b");
    expect(toActionsBranchPattern("v[1]")).toBe("v\\[1\\]");
    expect(toActionsBranchPattern("!x")).toBe("\\!x");
    expect(toActionsBranchPattern("x!")).toBe("x!");
  });
});

describe("workflowBranches", () => {
  it("defaults to the default branch only", () => {
    expect(workflowBranches(git(), "trunk")).toEqual(["trunk"]);
  });
  it("production release/* + preview default -> [main, release/*] order is production first", () => {
    expect(
      workflowBranches(
        git({
          production: { branch: "release/*", version: "branch" },
          preview: { branch: "default" },
        }),
        "main",
      ),
    ).toEqual(["release/*", "main"]);
  });
  it("production default + preview release/* -> [main, release/*]", () => {
    expect(workflowBranches(git({ preview: { branch: "release/*" } }), "main")).toEqual([
      "main",
      "release/*",
    ]);
  });
  it("removes duplicates", () => {
    expect(workflowBranches(git({ preview: { branch: "default" } }), "main")).toEqual(["main"]);
    expect(
      workflowBranches(
        git({ production: { branch: "main", version: "x" }, preview: { branch: "default" } }),
        "main",
      ),
    ).toEqual(["main"]);
  });
});

describe("workflowTemplate branches", () => {
  const text = (branches: string[]) =>
    workflowTemplate({ runtime: "python", branches, version: "0.0.1" });
  it("quotes patterns that are not plain YAML scalars", () => {
    const doc = parseYaml(text(["main", "release/*", "**", "a\\+b"])) as any;
    expect(doc.on.push.branches).toEqual(["main", "release/*", "**", "a\\+b"]);
    expect(text(["main", "release/*"])).toContain('branches: [main, "release/*"]');
  });
  it("starts with a comment telling to regenerate after changing flarelet.yaml git settings", () => {
    const t = text(["main"]);
    expect(t.split("\n")[0]).toMatch(/^# /);
    expect(t).toContain("flarelet workflow generate --force");
    expect(t).toContain("git");
  });
});

describe("workflowTemplate package pinning", () => {
  const t = (version: string) =>
    workflowTemplate({ runtime: "python", branches: ["main"], version });
  it("pins the install to the given version and keeps the FLARELET_PACKAGE override", () => {
    const doc = parseYaml(t("1.2.3")) as any;
    expect(doc.env.FLARELET_PACKAGE).toBe("${{ vars.FLARELET_PACKAGE || 'flarelet@1.2.3' }}");
    expect(t("1.2.3")).not.toContain("flarelet@latest");
    expect(t("1.2.3")).not.toMatch(/not published/i);
  });
});

describe("pushBranchesOf", () => {
  it("reads on.push.branches, null when absent or unparsable", () => {
    expect(pushBranchesOf("on:\n  push:\n    branches: [a, b]\n")).toEqual(["a", "b"]);
    expect(pushBranchesOf("on:\n  push:\n")).toBeNull();
    expect(pushBranchesOf("mine: true\n")).toBeNull();
    expect(pushBranchesOf(": : :\n\t[")).toBeNull();
  });
});

describe("checkWorkflowDrift", () => {
  const wf = (branches: string[]) =>
    workflowTemplate({ runtime: "python", branches, version: "0.0.1" });
  it("returns null when matching (order-insensitive)", () => {
    expect(
      checkWorkflowDrift(
        wf(["release/*", "main"]),
        git({ preview: { branch: "release/*" } }),
        "main",
      ),
    ).toBeNull();
  });
  it("warns when branches differ", () => {
    const w = checkWorkflowDrift(
      wf(["main"]),
      git({ production: { branch: "release/*", version: "branch" } }),
      "main",
    );
    expect(w).toContain("release/*");
    expect(w).toContain("flarelet workflow generate --force");
  });
  it("is silent when the default branch is unknown but needed, or push has no branch filter", () => {
    expect(checkWorkflowDrift(wf(["main"]), git(), undefined)).toBeNull();
    expect(checkWorkflowDrift("on:\n  push:\n", git(), "main")).toBeNull();
  });
});

describe("runWorkflowGenerate", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "flarelet-wf-"));
  });
  afterEach(async () => rm(dir, { recursive: true, force: true }));
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) },
    };
  };
  const yaml = (extra = "") => `version: 1\nname: demo\nruntime:\n  language: python\n${extra}`;
  const target = () => join(dir, ".github/workflows/flarelet.yml");
  const branches = async () =>
    (parseYaml(await readFile(target(), "utf8")) as any).on.push.branches;

  it("creates the workflow from the git settings", async () => {
    await writeFile(
      join(dir, "flarelet.yaml"),
      yaml(
        "git:\n  production:\n    branch: release/*\n    version: branch\n  preview:\n    branch: default\n",
      ),
    );
    const t = io();
    expect(
      await runWorkflowGenerate(
        { file: join(dir, "flarelet.yaml"), force: false, defaultBranch: "main" },
        t.io,
      ),
    ).toBe(0);
    expect(await branches()).toEqual(["release/*", "main"]);
  });

  it("reports up to date, refuses to overwrite a different file, overwrites with force", async () => {
    const file = join(dir, "flarelet.yaml");
    await writeFile(file, yaml());
    const a = { file, force: false, defaultBranch: "main" };
    expect(await runWorkflowGenerate(a, io().io)).toBe(0);
    const t = io();
    expect(await runWorkflowGenerate(a, t.io)).toBe(0);
    expect(t.out.join("\n")).toContain("up to date");

    await writeFile(file, yaml("git:\n  preview:\n    branch: dev/*\n"));
    const t2 = io();
    expect(await runWorkflowGenerate(a, t2.io)).toBe(1);
    expect(t2.err.join("\n")).toContain("--force");
    expect(await branches()).toEqual(["main"]);

    const t3 = io();
    expect(await runWorkflowGenerate({ ...a, force: true }, t3.io)).toBe(0);
    expect(await branches()).toEqual(["main", "dev/*"]);
  });

  it("fails on missing or invalid flarelet.yaml", async () => {
    const t = io();
    expect(
      await runWorkflowGenerate({ file: join(dir, "flarelet.yaml"), force: false }, t.io),
    ).toBe(1);
    await mkdir(dir, { recursive: true });
  });
});

// Actions は 40 桁コミット SHA で固定し、元のタグをコメントに残す（Dependabot が両方を更新できる形式）。
// checkout は後続ステップが git 資格情報を使わないので persist-credentials: false にする
describe("GitHub Actions pinning", () => {
  const usesLines = (text: string) => text.split("\n").filter((l) => /^\s*-?\s*uses:/.test(l));
  const expectPinned = (text: string) => {
    const lines = usesLines(text);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l, l).toMatch(/uses:\s+[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+# v\d+\S*\s*$/);
    }
  };
  const expectNoPersist = (doc: any) => {
    let checkouts = 0;
    for (const job of Object.values<any>(doc.jobs)) {
      for (const step of job.steps) {
        if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
          checkouts++;
          expect(step.with?.["persist-credentials"]).toBe(false);
        }
      }
    }
    expect(checkouts).toBeGreaterThan(0);
  };

  for (const runtime of ["python", "typescript"] as const) {
    it(`generated workflow (${runtime}) pins every action by SHA and disables persisted credentials`, () => {
      const w = workflowTemplate({ runtime, branches: ["main"], version: "0.0.1" });
      expectPinned(w);
      expectNoPersist(parseYaml(w));
    });
  }

  for (const file of ["ci.yml", "release.yml"]) {
    it(`.github/workflows/${file} pins every action by SHA and disables persisted credentials`, async () => {
      const text = await readFile(join(__dirname, "../../.github/workflows", file), "utf8");
      expectPinned(text);
      expectNoPersist(parseYaml(text));
    });
  }
});
