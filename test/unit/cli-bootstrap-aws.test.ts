import { afterEach, describe, expect, it } from "vitest";
import { PROVIDER_STACK, providerArn } from "../../src/bootstrap/github.js";
import { runBootstrapGithub } from "../../src/cli/bootstrap.js";
import {
  autoBootstrapAllowed,
  isInteractive,
  notBootstrappedMessage,
  runBootstrapAws,
} from "../../src/cli/bootstrap-aws.js";
import { runDeploy } from "../../src/cli/deploy.js";
import { runDev, type DevDeps } from "../../src/cli/dev.js";
import { runInit } from "../../src/cli/init.js";
import { runPlan } from "../../src/cli/synth.js";
import { harness, type Harness } from "./fake-cloud.js";

const ACCOUNT = "123456789012";
const REGION = "ap-northeast-1";
const NOT_BOOTSTRAPPED = `Error: ${ACCOUNT}/${REGION} is not bootstrapped for Flarelet. Run: flarelet bootstrap aws --region ${REGION}`;

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
`;

let h: Harness;
afterEach(async () => h?.cleanup());

async function setup(yaml = YAML, env: Record<string, string> = { AWS_REGION: REGION }) {
  h = await harness(yaml, env);
  return h;
}

const unbootstrap = () => h.cloud.bootstrapVersions.clear();
const out = () => h.out.join("\n");
const err = () => h.err.join("\n");

describe("notBootstrappedMessage", () => {
  it("tells the exact command to run", () => {
    expect(notBootstrappedMessage(ACCOUNT, REGION)).toBe(NOT_BOOTSTRAPPED);
  });

  it("includes a non-default qualifier", () => {
    expect(notBootstrappedMessage(ACCOUNT, REGION, "custom1")).toBe(
      `${NOT_BOOTSTRAPPED} --qualifier custom1`,
    );
  });
});

describe("autoBootstrapAllowed", () => {
  it.each([
    // flag, ci, interactive, expected
    [undefined, false, true, true],
    [undefined, false, false, false],
    [undefined, true, true, false],
    [false, false, true, false],
    [true, false, false, true],
    [true, true, false, true],
  ] as const)("flag=%s ci=%s interactive=%s -> %s", (flag, ci, interactive, expected) => {
    expect(autoBootstrapAllowed({ flag, ci, interactive })).toBe(expected);
  });
});

describe("isInteractive", () => {
  it("requires both stdin and stdout to be terminals", () => {
    expect(isInteractive({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractive({ isTTY: false }, { isTTY: true })).toBe(false);
    expect(isInteractive({ isTTY: true }, {})).toBe(false);
    expect(isInteractive({}, {})).toBe(false);
  });
});

describe("flarelet bootstrap aws", () => {
  it("does nothing when the environment is already bootstrapped", async () => {
    await setup();
    expect(await runBootstrapAws({}, h.deps)).toBe(0);
    expect(h.deployer.bootstraps).toEqual([]);
    expect(out()).toContain(`${ACCOUNT}/${REGION} is already bootstrapped (version 30)`);
    expect(h.cloud.bootstrapChecks).toEqual(["hnb659fds"]);
  });

  it("bootstraps the STS account in the given region when not bootstrapped", async () => {
    await setup();
    unbootstrap();
    expect(await runBootstrapAws({ region: "us-west-2" }, h.deps)).toBe(0);
    expect(h.deployer.bootstraps).toEqual([
      { account: ACCOUNT, region: "us-west-2", qualifier: "hnb659fds" },
    ]);
    const o = out();
    expect(o).toContain(`Bootstrapping ${ACCOUNT}/us-west-2 for Flarelet (qualifier hnb659fds)`);
    expect(o).toContain("  deploying CDKToolkit");
    expect(o).toMatch(/ {4}done \(\d+s\)/);
    expect(o).toContain(`Bootstrapped ${ACCOUNT}/us-west-2 (version 30)`);
  });

  it("passes a custom qualifier and checks that qualifier", async () => {
    await setup();
    expect(await runBootstrapAws({ qualifier: "custom1" }, h.deps)).toBe(0);
    expect(h.cloud.bootstrapChecks[0]).toBe("custom1");
    expect(h.deployer.bootstraps[0]?.qualifier).toBe("custom1");
  });

  it("does not print raw CloudFormation events", async () => {
    await setup();
    unbootstrap();
    h.deployer.bootstrapEvents = [
      { type: "stack-start", stack: "CDKToolkit" },
      {
        type: "resource",
        stack: "CDKToolkit",
        concept: "AWS::S3::Bucket",
        status: "CREATE_IN_PROGRESS",
      },
      { type: "error", message: "Using default execution policy of AdministratorAccess" },
      { type: "stack-end", stack: "CDKToolkit" },
    ];
    expect(await runBootstrapAws({}, h.deps)).toBe(0);
    expect(out() + err()).not.toMatch(/AWS::|CREATE_IN_PROGRESS|AdministratorAccess/);
  });

  it("never touches an existing CDKToolkit stack of another qualifier", async () => {
    await setup();
    unbootstrap();
    h.cloud.addStack({ name: "CDKToolkit" });
    expect(await runBootstrapAws({}, h.deps)).toBe(1);
    expect(h.deployer.bootstraps).toEqual([]);
    expect(err()).toContain("CDKToolkit");
    expect(err()).toContain("/cdk-bootstrap/hnb659fds/version");
  });

  it("reports a bootstrap failure", async () => {
    await setup();
    unbootstrap();
    h.deployer.bootstrapError = new Error("AccessDenied");
    expect(await runBootstrapAws({}, h.deps)).toBe(1);
    expect(err()).toContain("Error: AccessDenied");
  });

  it("fails cleanly when AWS is unreachable", async () => {
    await setup();
    h.cloud.failAccount = new Error("no credentials");
    expect(await runBootstrapAws({}, h.deps)).toBe(1);
    expect(err()).toContain("Error: cannot reach AWS: no credentials");
    expect(h.deployer.bootstraps).toEqual([]);
  });
});

describe("deploy checks the CDK bootstrap first", () => {
  const deploy = (extra: Record<string, unknown> = {}) =>
    runDeploy({ file: h.file, stage: "prod", version: "v1", ...extra }, h.deps);

  it("proceeds without bootstrapping when already bootstrapped", async () => {
    await setup();
    h.interactive = true;
    expect(await deploy()).toBe(0);
    expect(h.deployer.bootstraps).toEqual([]);
    expect(h.cloud.bootstrapChecks).toEqual(["hnb659fds"]);
  });

  it("stops before synth and CloudFormation when not interactive", async () => {
    await setup();
    unbootstrap();
    h.interactive = false;
    expect(await deploy()).toBe(1);
    expect(h.err[0]).toBe(NOT_BOOTSTRAPPED);
    expect(err()).toContain("--bootstrap");
    expect(h.synthCalls).toEqual([]);
    expect(h.deployer.outdirs).toEqual([]);
    expect(h.deployer.bootstraps).toEqual([]);
  });

  it("bootstraps automatically in an interactive terminal, then deploys", async () => {
    await setup();
    unbootstrap();
    h.interactive = true;
    expect(await deploy()).toBe(0);
    expect(h.deployer.bootstraps).toEqual([
      { account: ACCOUNT, region: REGION, qualifier: "hnb659fds" },
    ]);
    expect(h.deployer.order).toEqual(["bootstrap", "deploy"]);
    expect(h.out).toContain(`Bootstrapping ${ACCOUNT}/${REGION} for Flarelet (one-time)...`);
    expect(h.out).toContain("Bootstrapped (version 30)");
    expect(out().indexOf("Bootstrapped (version 30)")).toBeLessThan(out().indexOf("Deploying"));
  });

  it("does not bootstrap automatically with --ci", async () => {
    await setup();
    h.deps.detectGit = async () => ({ ci: { event: "push" } });
    unbootstrap();
    h.interactive = true;
    expect(await deploy({ ci: true })).toBe(1);
    expect(err()).toContain(NOT_BOOTSTRAPPED);
    expect(h.deployer.bootstraps).toEqual([]);
  });

  it("does not bootstrap automatically with --no-bootstrap", async () => {
    await setup();
    unbootstrap();
    h.interactive = true;
    expect(await deploy({ bootstrap: false })).toBe(1);
    expect(h.err[0]).toBe(NOT_BOOTSTRAPPED);
    expect(h.deployer.bootstraps).toEqual([]);
  });

  it("bootstraps without a terminal when --bootstrap is given", async () => {
    await setup();
    unbootstrap();
    h.interactive = false;
    expect(await deploy({ bootstrap: true })).toBe(0);
    expect(h.deployer.order).toEqual(["bootstrap", "deploy"]);
  });

  it("stops when the automatic bootstrap fails", async () => {
    await setup();
    unbootstrap();
    h.interactive = true;
    h.deployer.bootstrapError = new Error("AccessDenied");
    expect(await deploy()).toBe(1);
    expect(err()).toContain("AccessDenied");
    expect(h.deployer.outdirs).toEqual([]);
  });

  it("warns and continues when the bootstrap state cannot be read", async () => {
    await setup();
    h.cloud.failBootstrapCheck = new Error("AccessDeniedException");
    expect(await deploy()).toBe(0);
    expect(err()).toContain("Warning: cannot check the CDK bootstrap");
    expect(h.deployer.bootstraps).toEqual([]);
  });
});

describe("dev checks the CDK bootstrap before creating the dev stack", () => {
  const DEV_YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
database: { main: {} }
`;

  function devDeps(): DevDeps {
    return {
      ...h.deps,
      username: () => "naoto",
      synthesizeDev: (o) => {
        h.synthCalls.push(o as never);
        return {
          outdir: o.outdir,
          stacks: [{ name: "flarelet-myapp-preview-local-naoto", kind: "dev" }],
        };
      },
      startLocal: async (o) => ({ url: `http://localhost:${o.port}`, stop: async () => {} }),
      untilStopped: async () => {},
    };
  }

  it("stops without a terminal", async () => {
    await setup(DEV_YAML);
    unbootstrap();
    expect(await runDev({ file: h.file }, devDeps())).toBe(1);
    expect(err()).toContain(NOT_BOOTSTRAPPED);
    expect(h.synthCalls).toEqual([]);
    expect(h.deployer.outdirs).toEqual([]);
  });

  it("bootstraps automatically in a terminal", async () => {
    await setup(DEV_YAML);
    unbootstrap();
    h.interactive = true;
    expect(await runDev({ file: h.file }, devDeps())).toBe(0);
    expect(h.deployer.order).toEqual(["bootstrap", "deploy"]);
    expect(h.out).toContain(`Bootstrapping ${ACCOUNT}/${REGION} for Flarelet (one-time)...`);
  });

  it("respects --no-bootstrap and --bootstrap", async () => {
    await setup(DEV_YAML);
    unbootstrap();
    h.interactive = true;
    expect(await runDev({ file: h.file, bootstrap: false }, devDeps())).toBe(1);
    expect(h.deployer.bootstraps).toEqual([]);
    h.interactive = false;
    expect(await runDev({ file: h.file, bootstrap: true }, devDeps())).toBe(0);
    expect(h.deployer.bootstraps).toHaveLength(1);
  });

  it("does not check when no dev stack is needed", async () => {
    await setup();
    unbootstrap();
    expect(await runDev({ file: h.file }, devDeps())).toBe(0);
    expect(h.cloud.bootstrapChecks).toEqual([]);
  });
});

describe("bootstrap github requires the CDK bootstrap", () => {
  it("stops before deploying the role, even in a terminal", async () => {
    await setup();
    unbootstrap();
    h.interactive = true;
    h.cloud.oidcProvider = providerArn(ACCOUNT);
    const synthed: unknown[] = [];
    const code = await runBootstrapGithub(
      { repo: "youyo/myapp" },
      {
        ...h.deps,
        synthBootstrap: (spec) => {
          synthed.push(spec);
          return { outdir: spec.outdir, stacks: [{ name: PROVIDER_STACK, kind: "provider" }] };
        },
      },
    );
    expect(code).toBe(1);
    expect(err()).toContain(NOT_BOOTSTRAPPED);
    expect(synthed).toEqual([]);
    expect(h.deployer.bootstraps).toEqual([]);
    expect(h.deployer.outdirs).toEqual([]);
  });

  it("checks the qualifier given to bootstrap github", async () => {
    await setup();
    unbootstrap();
    const code = await runBootstrapGithub(
      { repo: "youyo/myapp", qualifier: "custom1" },
      { ...h.deps, synthBootstrap: () => ({ outdir: "", stacks: [] }) },
    );
    expect(code).toBe(1);
    expect(h.cloud.bootstrapChecks).toEqual(["custom1"]);
    expect(err()).toContain("--qualifier custom1");
  });
});

describe("plan only warns about the CDK bootstrap", () => {
  it("warns when online and not bootstrapped", async () => {
    await setup();
    unbootstrap();
    expect(await runPlan({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(err()).toContain(
      `Warning: ${ACCOUNT}/${REGION} is not bootstrapped for Flarelet; deploy will bootstrap it (or run: flarelet bootstrap aws --region ${REGION})`,
    );
    expect(h.deployer.bootstraps).toEqual([]);
  });

  it("stays silent offline", async () => {
    await setup(YAML, { AWS_REGION: REGION, FLARELET_OFFLINE: "1" });
    unbootstrap();
    expect(await runPlan({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(err()).not.toContain("bootstrap");
    expect(h.cloud.bootstrapChecks).toEqual([]);
  });

  it("ignores a failed check", async () => {
    await setup();
    h.cloud.failBootstrapCheck = new Error("AccessDenied");
    expect(await runPlan({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(0);
    expect(err()).not.toContain("bootstrap");
  });
});

describe("init next steps", () => {
  it("mentions flarelet bootstrap aws once", async () => {
    await setup();
    const lines: string[] = [];
    const dir = `${h.dir}/newapp`;
    expect(
      await runInit({ dir }, { stdout: (l) => lines.push(l), stderr: (l) => lines.push(l) }),
    ).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("flarelet bootstrap aws");
    expect(text.indexOf("flarelet bootstrap aws")).toBeLessThan(
      text.indexOf("flarelet bootstrap github"),
    );
  });
});
