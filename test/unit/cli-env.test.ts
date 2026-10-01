import { afterEach, describe, expect, it } from "vitest";
import { runEnvList, runEnvUrl } from "../../src/cli/env.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
`;

let h: Harness;
afterEach(async () => h?.cleanup());

const vtags = (stage: string, version: string, lifecycle: string, branch?: string) => ({
  "flareon:app": "myapp",
  "flareon:stage": stage,
  "flareon:version": version,
  "flareon:lifecycle": lifecycle,
  ...(branch ? { "flareon:branch": branch } : {}),
});

describe("env list", () => {
  it("lists versions with type, branch, status and URL", async () => {
    h = await harness(YAML);
    h.cloud.addStack({
      name: "flareon-myapp-prod",
      tags: { "flareon:app": "myapp", "flareon:stage": "prod" },
    });
    h.cloud.addStack({
      name: "flareon-myapp-prod-v1",
      tags: vtags("prod", "v1", "persistent", "release/v1"),
      outputs: { ApiUrl: "https://v1.example" },
    });
    h.cloud.addStack({
      name: "flareon-myapp-preview-pr-12",
      status: "UPDATE_IN_PROGRESS",
      tags: vtags("preview", "pr-12", "ephemeral"),
      outputs: { ApiUrl: "https://pr12.example" },
    });
    h.cloud.addStack({
      name: "flareon-myapp-preview-pr-13",
      status: "ROLLBACK_COMPLETE",
      // 古いスタック（lifecycle タグ無し）は version 名から推定する
      tags: { "flareon:app": "myapp", "flareon:stage": "preview", "flareon:version": "pr-13" },
    });
    expect(await runEnvList({ file: h.file }, h.deps)).toBe(0);
    const lines = h.out.join("\n").split("\n");
    expect(lines[0]).toMatch(/^STAGE\s+VERSION\s+TYPE\s+BRANCH\s+STATUS\s+URL$/);
    const row = (v: string) => lines.find((l) => l.includes(` ${v} `))!;
    expect(row("v1")).toMatch(/^prod\s+v1\s+persistent\s+release\/v1\s+ready\s+https:\/\/v1/);
    expect(row("pr-12")).toMatch(/^preview\s+pr-12\s+ephemeral\s+-\s+deploying\s+https/);
    expect(row("pr-13")).toMatch(/ephemeral\s+-\s+failed/);
    // stage スタックは行にしない
    expect(lines.filter((l) => l.startsWith("prod"))).toHaveLength(1);
  });

  it("says so when nothing is deployed", async () => {
    h = await harness(YAML);
    expect(await runEnvList({ file: h.file }, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("No environments");
  });
});

describe("env url", () => {
  it("prints the URL of the resolved version", async () => {
    h = await harness(YAML);
    h.cloud.addStack({
      name: "flareon-myapp-prod-v1",
      outputs: { ApiUrl: "https://v1.example" },
    });
    expect(await runEnvUrl({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(h.out).toEqual(["https://v1.example"]);
  });

  it("prints a preview magic link with --with-token", async () => {
    h = await harness(YAML);
    h.cloud.addStack({
      name: "flareon-myapp-preview-pr-4",
      outputs: { ApiUrl: "https://pr4.example", PreviewTokenSecretArn: "arn:tok" },
    });
    h.cloud.secrets.set("arn:tok", "s3cr3t/+=\n");
    expect(await runEnvUrl({ file: h.file, pr: 4, withToken: true }, h.deps)).toBe(0);
    expect(h.out).toEqual([
      `https://pr4.example/__flareon/auth/preview?token=${encodeURIComponent("s3cr3t/+=")}`,
    ]);
  });

  it("rejects --with-token for non-preview environments", async () => {
    h = await harness(YAML);
    h.cloud.addStack({ name: "flareon-myapp-prod-v1", outputs: { ApiUrl: "https://v1" } });
    expect(
      await runEnvUrl({ file: h.file, stage: "prod", version: "v1", withToken: true }, h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toContain("preview");
  });

  it("fails when the version is not deployed", async () => {
    h = await harness(YAML);
    expect(await runEnvUrl({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("not deployed");
  });
});
