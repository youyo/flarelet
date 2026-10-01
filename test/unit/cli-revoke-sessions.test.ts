// F4: flareon auth revoke-sessions / auth user remove はセッション世代を進めて既存セッションを失効させる。
import { afterEach, describe, expect, it } from "vitest";
import { runRevokeSessions, runUserRemove } from "../../src/cli/auth-user.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
`;
const PROD_EPOCH = "/flareon/myapp/prod/auth/session-epoch";
const PR_EPOCH = "/flareon/myapp/preview/auth/pr-3/session-epoch";

let h: Harness;
afterEach(async () => h?.cleanup());

const seed = (name: string) =>
  h.cloud.params.set(name, { value: "initial", lastModified: new Date(0) });

describe("auth revoke-sessions", () => {
  it("rotates the stage's session epoch", async () => {
    h = await harness(YAML);
    seed(PROD_EPOCH);
    expect(await runRevokeSessions({ file: h.file, stage: "prod" }, h.deps)).toBe(0);
    expect(h.cloud.calls).toContain(`rotateParameter:${PROD_EPOCH}`);
    expect(h.cloud.params.get(PROD_EPOCH)!.value).not.toBe("initial");
    expect(h.out.join("\n")).toMatch(/Revoked all sessions of prod.*60 seconds/);
  });

  it("rotates a PR preview's own epoch", async () => {
    h = await harness(YAML);
    seed(PR_EPOCH);
    expect(await runRevokeSessions({ file: h.file, pr: 3 }, h.deps)).toBe(0);
    expect(h.cloud.calls).toContain(`rotateParameter:${PR_EPOCH}`);
  });

  it("does not create the parameter when the environment is not deployed (or predates it)", async () => {
    h = await harness(YAML);
    expect(await runRevokeSessions({ file: h.file, stage: "prod" }, h.deps)).toBe(1);
    expect(h.cloud.params.has(PROD_EPOCH)).toBe(false);
    expect(h.err.join("\n")).toMatch(/flareon deploy/);
  });

  it("refuses stages without authentication", async () => {
    h = await harness(YAML.replace("http: true", "http:\n  auth: false"));
    expect(await runRevokeSessions({ file: h.file, stage: "prod" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("authentication is disabled");
    expect(h.cloud.calls.some((c) => c.startsWith("rotateParameter"))).toBe(false);
  });
});

describe("auth user remove revokes sessions", () => {
  it("rotates the epoch after deleting the user so their session stops working", async () => {
    h = await harness(YAML);
    h.cloud.addStack({ name: "flareon-myapp-prod", outputs: { UserPoolId: "pool-1" } });
    await h.cloud.createUser("pool-1", "a@example.com");
    seed(PROD_EPOCH);
    expect(
      await runUserRemove({ file: h.file, stage: "prod", email: "a@example.com" }, h.deps),
    ).toBe(0);
    const i = h.cloud.calls.indexOf("deleteUser:pool-1:a@example.com");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(h.cloud.calls.indexOf(`rotateParameter:${PROD_EPOCH}`)).toBeGreaterThan(i);
    expect(h.out.join("\n")).toMatch(/signed out/i);
  });

  it("warns (but succeeds) when the stage predates session revocation", async () => {
    h = await harness(YAML);
    h.cloud.addStack({ name: "flareon-myapp-prod", outputs: { UserPoolId: "pool-1" } });
    await h.cloud.createUser("pool-1", "a@example.com");
    expect(
      await runUserRemove({ file: h.file, stage: "prod", email: "a@example.com" }, h.deps),
    ).toBe(0);
    expect(h.err.join("\n")).toMatch(/Warning: .*flareon deploy/);
  });
});
