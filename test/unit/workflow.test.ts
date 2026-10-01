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
  const text = (branches: string[]) => workflowTemplate({ runtime: "python", branches });
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

describe("pushBranchesOf", () => {
  it("reads on.push.branches, null when absent or unparsable", () => {
    expect(pushBranchesOf("on:\n  push:\n    branches: [a, b]\n")).toEqual(["a", "b"]);
    expect(pushBranchesOf("on:\n  push:\n")).toBeNull();
    expect(pushBranchesOf("mine: true\n")).toBeNull();
    expect(pushBranchesOf(": : :\n\t[")).toBeNull();
  });
});

describe("checkWorkflowDrift", () => {
  const wf = (branches: string[]) => workflowTemplate({ runtime: "python", branches });
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
