import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_STACK, providerArn, synthGithubBootstrap } from "../../src/bootstrap/github.js";
import { runBootstrapGithub, type BootstrapDeps } from "../../src/cli/bootstrap.js";
import { harness, type Harness } from "./fake-cloud.js";

const ROLE_STACK = "flareon-bootstrap-github-youyo-myapp";
const PROVIDER = providerArn("123456789012");

let h: Harness;
let deps: BootstrapDeps;
let synthed: Parameters<typeof synthGithubBootstrap>[0][];
afterEach(async () => h?.cleanup());

async function setup(env: Record<string, string> = { AWS_REGION: "ap-northeast-1" }) {
  h = await harness("version: 1\nname: x\nruntime: { language: python }\n", env);
  synthed = [];
  deps = {
    ...h.deps,
    synthBootstrap: (spec) => {
      synthed.push(spec);
      const stacks = [
        ...(spec.createProvider ? [{ name: PROVIDER_STACK, kind: "provider" as const }] : []),
        { name: ROLE_STACK, kind: "role" as const },
      ];
      return { outdir: spec.outdir, stacks };
    },
  };
  h.deployer.result = [
    {
      name: ROLE_STACK,
      outputs: { RoleArn: "arn:aws:iam::123456789012:role/flareon-github-youyo-myapp" },
    },
  ];
}

describe("flareon bootstrap github", () => {
  it("reuses an existing OIDC provider and prints the role ARN and gh commands", async () => {
    await setup();
    h.cloud.oidcProvider = PROVIDER;
    expect(await runBootstrapGithub({ repo: "youyo/myapp" }, deps)).toBe(0);
    expect(synthed[0]).toMatchObject({
      createProvider: false,
      account: "123456789012",
      region: "ap-northeast-1",
      qualifier: "hnb659fds",
      repo: { owner: "youyo", name: "myapp" },
    });
    expect(h.deployer.outdirs).toHaveLength(1);
    const out = h.out.join("\n");
    expect(out).toContain("reusing");
    expect(out).toContain("arn:aws:iam::123456789012:role/flareon-github-youyo-myapp");
    expect(out).toContain(
      "gh variable set FLAREON_AWS_ROLE_ARN --repo youyo/myapp --body arn:aws:iam::123456789012:role/flareon-github-youyo-myapp",
    );
    expect(out).toContain(
      "gh variable set FLAREON_AWS_REGION --repo youyo/myapp --body ap-northeast-1",
    );
  });

  it("creates the provider only when the account has none", async () => {
    await setup();
    expect(await runBootstrapGithub({ repo: "youyo/myapp" }, deps)).toBe(0);
    expect(synthed[0]!.createProvider).toBe(true);
    expect(h.out.join("\n")).toContain("creating");
  });

  it("keeps managing the provider stack Flareon created earlier", async () => {
    await setup();
    h.cloud.oidcProvider = PROVIDER;
    h.cloud.addStack({
      name: PROVIDER_STACK,
      tags: { "flareon:bootstrap": "github-oidc-provider" },
    });
    await runBootstrapGithub({ repo: "youyo/myapp" }, deps);
    expect(synthed[0]!.createProvider).toBe(false);
  });

  it("refuses when the provider stack exists but the provider is gone", async () => {
    await setup();
    h.cloud.addStack({
      name: PROVIDER_STACK,
      tags: { "flareon:bootstrap": "github-oidc-provider" },
    });
    expect(await runBootstrapGithub({ repo: "youyo/myapp" }, deps)).toBe(1);
    expect(h.err.join("\n")).toContain(PROVIDER_STACK);
    expect(h.deployer.outdirs).toEqual([]);
  });

  it("rejects an invalid repo before touching AWS", async () => {
    await setup();
    expect(await runBootstrapGithub({ repo: "youyo/*" }, deps)).toBe(1);
    expect(h.err.join("\n")).toContain("owner/name");
    expect(h.cloud.calls).toEqual([]);
  });

  it("refuses a stack that belongs to a different repository (name collision)", async () => {
    await setup();
    h.cloud.oidcProvider = PROVIDER;
    h.cloud.addStack({
      name: ROLE_STACK,
      tags: { "flareon:bootstrap": "github-role", "flareon:repo": "youyo-x/myapp" },
    });
    expect(await runBootstrapGithub({ repo: "youyo/myapp" }, deps)).toBe(1);
    expect(h.err.join("\n")).toContain("youyo-x/myapp");
    expect(h.deployer.outdirs).toEqual([]);
  });

  it("reports deployment failures", async () => {
    await setup();
    h.cloud.oidcProvider = PROVIDER;
    h.deployer.error = new Error("boom");
    expect(await runBootstrapGithub({ repo: "youyo/myapp" }, deps)).toBe(1);
    expect(h.err.join("\n")).toContain("boom");
  });
});

describe("flareon bootstrap github --destroy", () => {
  const roleTags = { "flareon:bootstrap": "github-role", "flareon:repo": "youyo/myapp" };
  const providerTags = { "flareon:bootstrap": "github-oidc-provider" };

  it("deletes only the role stack and leaves an unmanaged OIDC provider alone", async () => {
    await setup();
    h.cloud.oidcProvider = PROVIDER;
    h.cloud.addStack({ name: ROLE_STACK, tags: roleTags });
    expect(await runBootstrapGithub({ repo: "youyo/myapp", destroy: true }, deps)).toBe(0);
    expect(h.cloud.calls.filter((c) => c.startsWith("deleteStack"))).toEqual([
      `deleteStack:${ROLE_STACK}`,
    ]);
  });

  it("also deletes the provider stack Flareon created when nothing else trusts it", async () => {
    await setup();
    h.cloud.oidcProvider = PROVIDER;
    h.cloud.addStack({ name: ROLE_STACK, tags: roleTags });
    h.cloud.addStack({ name: PROVIDER_STACK, tags: providerTags });
    expect(await runBootstrapGithub({ repo: "youyo/myapp", destroy: true }, deps)).toBe(0);
    expect(h.cloud.calls).toEqual(
      expect.arrayContaining([`deleteStack:${ROLE_STACK}`, `deleteStack:${PROVIDER_STACK}`]),
    );
  });

  it("keeps the provider stack while other roles still trust the provider", async () => {
    await setup();
    h.cloud.oidcProvider = PROVIDER;
    h.cloud.addStack({ name: ROLE_STACK, tags: roleTags });
    h.cloud.addStack({ name: PROVIDER_STACK, tags: providerTags });
    h.cloud.trustingRoles = ["someone-elses-role"];
    expect(await runBootstrapGithub({ repo: "youyo/myapp", destroy: true }, deps)).toBe(0);
    expect(h.cloud.calls).not.toContain(`deleteStack:${PROVIDER_STACK}`);
    expect(h.out.join("\n")).toContain("someone-elses-role");
  });

  it("does nothing when the repository is not bootstrapped", async () => {
    await setup();
    expect(await runBootstrapGithub({ repo: "youyo/myapp", destroy: true }, deps)).toBe(0);
    expect(h.cloud.calls.filter((c) => c.startsWith("deleteStack"))).toEqual([]);
    expect(h.out.join("\n")).toMatch(/not bootstrapped/);
  });

  it("refuses to delete a stack owned by another repository", async () => {
    await setup();
    h.cloud.addStack({
      name: ROLE_STACK,
      tags: { "flareon:bootstrap": "github-role", "flareon:repo": "youyo-x/myapp" },
    });
    expect(await runBootstrapGithub({ repo: "youyo/myapp", destroy: true }, deps)).toBe(1);
    expect(h.cloud.calls.filter((c) => c.startsWith("deleteStack"))).toEqual([]);
  });
});
