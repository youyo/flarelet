import { afterEach, describe, expect, it } from "vitest";
import { runUserAdd, runUserList, runUserRemove } from "../../src/cli/auth-user.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
`;

let h: Harness;
afterEach(async () => h?.cleanup());

async function withPool() {
  h = await harness(YAML);
  h.cloud.addStack({ name: "flareon-myapp-prod", outputs: { UserPoolId: "pool-1" } });
}

describe("auth user", () => {
  it("invites a user to the stage's user pool", async () => {
    await withPool();
    expect(await runUserAdd({ file: h.file, stage: "prod", email: "a@example.com" }, h.deps)).toBe(
      0,
    );
    expect(h.cloud.calls).toContain("createUser:pool-1:a@example.com");
    expect(h.out.join("\n")).toMatch(/a@example\.com.*temporary password/);
  });

  it("validates the email", async () => {
    await withPool();
    expect(await runUserAdd({ file: h.file, stage: "prod", email: "nope" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("email");
  });

  it("lists and removes users", async () => {
    await withPool();
    await runUserAdd({ file: h.file, stage: "prod", email: "a@example.com" }, h.deps);
    h.out.length = 0;
    expect(await runUserList({ file: h.file, stage: "prod" }, h.deps)).toBe(0);
    expect(h.out.join("\n")).toMatch(/a@example\.com\s+FORCE_CHANGE_PASSWORD\s+enabled/);
    expect(
      await runUserRemove({ file: h.file, stage: "prod", email: "a@example.com" }, h.deps),
    ).toBe(0);
    expect(
      await runUserRemove({ file: h.file, stage: "prod", email: "a@example.com" }, h.deps),
    ).toBe(1);
  });

  it("explains that previews use token auth and that undeployed stages have no users", async () => {
    h = await harness(YAML);
    expect(await runUserList({ file: h.file, pr: 3 }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("--with-token");
    h.err.length = 0;
    expect(await runUserList({ file: h.file, stage: "prod" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("not deployed");
  });
});
