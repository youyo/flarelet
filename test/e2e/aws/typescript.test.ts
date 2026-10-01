// PoC1（TypeScript / auth: false）+ default branch → prod/current + plan / env list / logs
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cli,
  cliStream,
  ENABLED,
  eventually,
  forceCleanup,
  get,
  leftoversSettled,
  log,
  LONG,
  newTracked,
  prepareApp,
  removeDir,
  stackOutputs,
  track,
  uniqueName,
  urlFrom,
} from "./helpers.js";

describe.runIf(ENABLED)("real AWS: typescript app without auth", () => {
  const app = uniqueName("ts");
  const tracked = newTracked();
  let dir: string;
  let url: string;

  beforeAll(async () => {
    dir = await prepareApp(
      "typescript",
      `version: 1
name: ${app}
runtime: { language: typescript }
http: { auth: false }
`,
    );
  }, LONG);

  afterAll(async () => {
    try {
      if (dir) {
        await track(app, tracked).catch(() => {});
        const r = await cli(["destroy", "--stage", "prod", "--version", "current"], dir);
        log(`destroy ${app}: exit ${r.code} (${r.ms}ms)`);
      }
    } finally {
      await forceCleanup(app, tracked);
      const left = await leftoversSettled(app, tracked);
      await removeDir(dir);
      expect(left, `leftover resources for ${app}`).toEqual([]);
    }
  }, LONG);

  it(
    "deploys the default branch to prod/current and serves HTTP 200",
    async () => {
      const r = await cli(["deploy", "--branch", "main", "--default-branch", "main"], dir);
      log(`deploy ${app} prod/current: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain(`Deploying ${app} (prod/current)`);
      expect(r.stdout).toContain("Auth  none (public)");
      // 生の CloudFormation イベントは出さない
      expect(r.stdout).not.toMatch(/AWS::|CREATE_IN_PROGRESS|UPDATE_COMPLETE/);
      url = urlFrom(r.stdout);
      await track(app, tracked);

      const res = await get(`${url}/`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        app: "typescript",
        message: "hello from flareon",
        version: "current",
      });
    },
    LONG,
  );

  it(
    "plan reports no changes against the deployed stacks",
    async () => {
      const r = await cli(["plan", "--branch", "main", "--default-branch", "main"], dir);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain(`Flareon will update ${app} (prod/current)`);
      expect(r.stdout).toContain("= application version current");
      expect(r.stdout).toContain("No changes");
    },
    LONG,
  );

  it("env list shows the environment", async () => {
    const r = await cli(["env", "list"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/STAGE\s+VERSION\s+TYPE\s+BRANCH\s+STATUS\s+URL/);
    expect(r.stdout).toMatch(
      new RegExp(`prod\\s+current\\s+persistent\\s+main\\s+ready\\s+${url}`),
    );
  });

  it(
    "logs shows application output and --follow streams new lines quickly",
    async () => {
      const id1 = `a${Date.now()}`;
      expect((await get(`${url}/log?id=${id1}`)).status).toBe(200);
      const found = await eventually(
        async () => {
          const r = await cli(
            ["logs", "--stage", "prod", "--version", "current", "--since", "5m"],
            dir,
          );
          return r.stdout.includes(`e2e-log-marker ${id1}`) ? r.stdout : undefined;
        },
        90_000,
        3000,
      );
      expect(found).toMatch(/app\s+.*e2e-log-marker/);

      const lines: { at: number; line: string }[] = [];
      const child = cliStream(
        ["logs", "--stage", "prod", "--version", "current", "--since", "1m", "--follow"],
        dir,
        (line) => lines.push({ at: Date.now(), line }),
      );
      try {
        await new Promise((r) => setTimeout(r, 3000));
        const id2 = `b${Date.now()}`;
        const sentAt = Date.now();
        expect((await get(`${url}/log?id=${id2}`)).status).toBe(200);
        const hit = await eventually(
          async () => lines.find((l) => l.line.includes(`e2e-log-marker ${id2}`)),
          60_000,
          200,
        );
        log(`logs --follow latency: ${hit.at - sentAt}ms`);
        expect(hit.at - sentAt).toBeLessThan(30_000);
      } finally {
        child.kill("SIGINT");
      }
    },
    LONG,
  );

  it(
    "destroy removes the version",
    async () => {
      const r = await cli(["destroy", "--stage", "prod", "--version", "current"], dir);
      log(`destroy ${app}: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr).toBe(0);
      expect(await stackOutputs(`flareon-${app}-prod-current`)).toBeUndefined();
      const list = await cli(["env", "list"], dir);
      expect(list.stdout).toContain("No environments");
    },
    LONG,
  );
});
