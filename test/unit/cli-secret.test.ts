import { afterEach, describe, expect, it } from "vitest";
import { runSecretDelete, runSecretList, runSecretSet } from "../../src/cli/secret.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
secrets: [API_KEY, OTHER_KEY]
`;
const PATH = "/flarelet/myapp/prod/secrets/";

let h: Harness;
afterEach(async () => h?.cleanup());

async function withVersions() {
  h = await harness(YAML);
  for (const [stage, v] of [
    ["prod", "v1"],
    ["prod", "v2"],
    ["preview", "current"],
  ] as const) {
    h.cloud.addStack({
      name: `flarelet-myapp-${stage}-${v}`,
      tags: { "flarelet:app": "myapp", "flarelet:stage": stage, "flarelet:version": v },
      outputs: { AppFunctionName: `fn-${stage}-${v}` },
    });
  }
}

describe("secret set", () => {
  it("stores the value as a stage-scoped SecureString and restarts that stage's versions", async () => {
    await withVersions();
    h.secretInput = "super-secret-value";
    expect(await runSecretSet({ file: h.file, stage: "prod", name: "API_KEY" }, h.deps)).toBe(0);
    expect(h.cloud.params.get(`${PATH}API_KEY`)?.value).toBe("super-secret-value");
    expect(h.cloud.calls.filter((c) => c.startsWith("updateFunctionEnv")).sort()).toEqual([
      "updateFunctionEnv:fn-prod-v1",
      "updateFunctionEnv:fn-prod-v2",
    ]);
    expect(h.cloud.functionEnv.get("fn-prod-v1")).toHaveProperty("FLARELET_SECRETS_REVISION");
    const all = [...h.out, ...h.err].join("\n");
    expect(all).not.toContain("super-secret-value");
    expect(all).toContain("API_KEY");
    expect(all).toMatch(/v1, v2/);
  });

  it("rejects names not declared in flarelet.yaml", async () => {
    await withVersions();
    h.secretInput = "x";
    expect(await runSecretSet({ file: h.file, stage: "prod", name: "NOPE" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toMatch(/NOPE.*not declared/);
    expect(h.cloud.params.size).toBe(0);
  });

  it("rejects an empty value and strips one trailing newline", async () => {
    await withVersions();
    h.secretInput = "\n";
    expect(await runSecretSet({ file: h.file, stage: "prod", name: "API_KEY" }, h.deps)).toBe(1);
    h.secretInput = "abc\n";
    expect(await runSecretSet({ file: h.file, stage: "prod", name: "API_KEY" }, h.deps)).toBe(0);
    expect(h.cloud.params.get(`${PATH}API_KEY`)?.value).toBe("abc");
  });

  it("notes that the value applies on the next deploy when nothing is deployed", async () => {
    h = await harness(YAML);
    h.secretInput = "v";
    expect(await runSecretSet({ file: h.file, stage: "prod", name: "API_KEY" }, h.deps)).toBe(0);
    expect(h.out.join("\n")).toContain("next deploy");
  });
});

describe("secret list", () => {
  it("shows declared names with their state, without values", async () => {
    h = await harness(YAML);
    h.cloud.params.set(`${PATH}API_KEY`, { value: "hidden", lastModified: new Date(0) });
    h.cloud.params.set(`${PATH}STALE`, { value: "hidden", lastModified: new Date(0) });
    expect(await runSecretList({ file: h.file, stage: "prod" }, h.deps)).toBe(0);
    const out = h.out.join("\n");
    expect(out).toMatch(/API_KEY\s+set/);
    expect(out).toMatch(/OTHER_KEY\s+not set/);
    expect(out).toMatch(/STALE\s+set.*not declared/);
    expect(out).not.toContain("hidden");
  });
});

describe("secret delete", () => {
  it("deletes the parameter and restarts the stage's versions", async () => {
    await withVersions();
    h.cloud.params.set(`${PATH}API_KEY`, { value: "x", lastModified: new Date(0) });
    expect(await runSecretDelete({ file: h.file, stage: "prod", name: "API_KEY" }, h.deps)).toBe(0);
    expect(h.cloud.params.has(`${PATH}API_KEY`)).toBe(false);
    expect(h.cloud.calls).toContain("updateFunctionEnv:fn-prod-v1");
  });

  it("fails when the secret is not set", async () => {
    h = await harness(YAML);
    expect(await runSecretDelete({ file: h.file, stage: "prod", name: "API_KEY" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("not set");
  });
});
