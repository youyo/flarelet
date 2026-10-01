import { afterEach, describe, expect, it } from "vitest";
import { runDeploy } from "../../src/cli/deploy.js";
import { runDestroy } from "../../src/cli/destroy.js";
import { runSecretDelete, runSecretList, runSecretSet } from "../../src/cli/secret.js";
import { runPlan } from "../../src/cli/synth.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http:
  auth:
    provider: google
secrets: [API_KEY]
`;
const SM = "flarelet/myapp/prod/auth/";

let h: Harness;
afterEach(async () => h?.cleanup());

const setBoth = (stage = "prod") => {
  h.cloud.smSecrets.set(`flarelet/myapp/${stage}/auth/GOOGLE_CLIENT_ID`, {
    value: "client-id-value",
    versionId: "vid-1",
  });
  h.cloud.smSecrets.set(`flarelet/myapp/${stage}/auth/GOOGLE_CLIENT_SECRET`, {
    value: "client-secret-value",
    versionId: "vsec-2",
  });
};

describe("secret set/list/delete for IdP credentials", () => {
  it("stores GOOGLE_CLIENT_SECRET in Secrets Manager (not SSM) without restarting the app", async () => {
    h = await harness(YAML);
    h.cloud.addStack({
      name: "flarelet-myapp-prod-v1",
      tags: { "flarelet:app": "myapp", "flarelet:stage": "prod", "flarelet:version": "v1" },
      outputs: { AppFunctionName: "fn" },
    });
    h.secretInput = "very-secret\n";
    expect(
      await runSecretSet({ file: h.file, stage: "prod", name: "GOOGLE_CLIENT_SECRET" }, h.deps),
    ).toBe(0);
    expect(h.cloud.smSecrets.get(`${SM}GOOGLE_CLIENT_SECRET`)?.value).toBe("very-secret");
    expect(h.cloud.params.size).toBe(0);
    expect(h.cloud.calls.some((c) => c.startsWith("updateFunctionEnv"))).toBe(false);
    const all = [...h.out, ...h.err].join("\n");
    expect(all).not.toContain("very-secret");
    expect(all).toMatch(/flarelet deploy --stage prod/);
  });

  it("still rejects IdP names when the provider does not use them", async () => {
    h = await harness(YAML);
    h.secretInput = "x";
    expect(
      await runSecretSet({ file: h.file, stage: "prod", name: "OIDC_CLIENT_ID" }, h.deps),
    ).toBe(1);
    expect(h.err.join("\n")).toMatch(/not declared/);
  });

  it("lists IdP credentials with their state, without values", async () => {
    h = await harness(YAML);
    h.cloud.smSecrets.set(`${SM}GOOGLE_CLIENT_ID`, { value: "hidden-id", versionId: "v" });
    expect(await runSecretList({ file: h.file, stage: "prod" }, h.deps)).toBe(0);
    const out = h.out.join("\n");
    expect(out).toMatch(/GOOGLE_CLIENT_ID\s+set.*sign-in/);
    expect(out).toMatch(/GOOGLE_CLIENT_SECRET\s+not set/);
    expect(out).toMatch(/API_KEY\s+not set/);
    expect(out).not.toContain("hidden-id");
  });

  it("deletes an IdP credential from Secrets Manager", async () => {
    h = await harness(YAML);
    setBoth();
    expect(
      await runSecretDelete({ file: h.file, stage: "prod", name: "GOOGLE_CLIENT_ID" }, h.deps),
    ).toBe(0);
    expect(h.cloud.smSecrets.has(`${SM}GOOGLE_CLIENT_ID`)).toBe(false);
  });
});

describe("deploy with an external IdP", () => {
  it("stops before synth when the credentials are not set, naming the commands", async () => {
    h = await harness(YAML);
    h.cloud.smSecrets.set(`${SM}GOOGLE_CLIENT_ID`, { value: "x", versionId: "v" });
    expect(await runDeploy({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(1);
    const err = h.err.join("\n");
    expect(err).toMatch(/GOOGLE_CLIENT_SECRET/);
    expect(err).not.toMatch(/GOOGLE_CLIENT_ID[^_]/);
    expect(err).toContain("flarelet secret set GOOGLE_CLIENT_SECRET --stage prod");
    // IdP 側に登録するリダイレクト URI（Cognito のドメインは app/stage/アカウントから決定的に決まる）
    expect(err).toMatch(
      /redirect URI.*https:\/\/myapp-prod-[0-9a-f]{6}\.auth\.[a-z0-9-]+\.amazoncognito\.com\/oauth2\/idpresponse/,
    );
    expect(h.synthCalls).toHaveLength(0);
    expect(h.deployer.outdirs).toHaveLength(0);
  });

  it("pins the current secret versions into the synthesized stage", async () => {
    h = await harness(YAML);
    setBoth();
    expect(await runDeploy({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(h.synthCalls[0]?.idpSecretVersions).toEqual({
      GOOGLE_CLIENT_ID: "vid-1",
      GOOGLE_CLIENT_SECRET: "vsec-2",
    });
    const out = h.out.join("\n");
    expect(out).toMatch(/Auth\s+sign-in with google/);
    expect(out).not.toContain("auth user add");
  });

  it("does not need IdP credentials for PR previews", async () => {
    h = await harness(YAML);
    expect(await runDeploy({ file: h.file, pr: 3 }, h.deps)).toBe(0);
    expect(h.synthCalls[0]?.idpSecretVersions).toBeUndefined();
  });
});

describe("plan with an external IdP", () => {
  it("uses the secret versions when online", async () => {
    h = await harness(YAML);
    setBoth();
    expect(await runPlan({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(h.synthCalls[0]?.idpSecretVersions).toEqual({
      GOOGLE_CLIENT_ID: "vid-1",
      GOOGLE_CLIENT_SECRET: "vsec-2",
    });
  });

  it("warns (but still plans) when credentials are missing", async () => {
    h = await harness(YAML);
    expect(await runPlan({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(h.err.join("\n")).toMatch(/Warning: .*GOOGLE_CLIENT_ID/);
  });
});

describe("destroy --stage-resources", () => {
  it("also deletes the stage's IdP credentials", async () => {
    h = await harness(YAML);
    setBoth();
    setBoth("preview");
    h.cloud.addStack({
      name: "flarelet-myapp-prod",
      tags: { "flarelet:app": "myapp", "flarelet:stage": "prod" },
    });
    expect(
      await runDestroy(
        { file: h.file, stage: "prod", version: "v1", stageResources: true, yes: true },
        h.deps,
      ),
    ).toBe(0);
    expect([...h.cloud.smSecrets.keys()].filter((k) => k.startsWith(SM))).toEqual([]);
    expect(h.cloud.smSecrets.size).toBe(2);
  });

  it("also deletes credentials of other providers (e.g. after switching to entra)", async () => {
    h = await harness(YAML);
    h.cloud.smSecrets.set(`${SM}ENTRA_CLIENT_ID`, { value: "x", versionId: "v1" });
    h.cloud.smSecrets.set(`${SM}ENTRA_CLIENT_SECRET`, { value: "y", versionId: "v2" });
    h.cloud.addStack({
      name: "flarelet-myapp-prod",
      tags: { "flarelet:app": "myapp", "flarelet:stage": "prod" },
    });
    expect(
      await runDestroy(
        { file: h.file, stage: "prod", version: "v1", stageResources: true, yes: true },
        h.deps,
      ),
    ).toBe(0);
    expect([...h.cloud.smSecrets.keys()]).toEqual([]);
  });
});
