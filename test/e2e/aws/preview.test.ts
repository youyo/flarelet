// Preview（PoC5 の CLI 部分）: --pr N → preview/pr-N、Preview Auth（トークン）、destroy でスタックごと削除
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cli,
  ENABLED,
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

describe.runIf(ENABLED)("real AWS: PR preview", () => {
  const app = uniqueName("pr");
  const tracked = newTracked();
  const stack = `flareon-${app}-preview-pr-1`;
  let dir: string;
  let url: string;

  beforeAll(async () => {
    dir = await prepareApp(
      "typescript",
      `version: 1
name: ${app}
runtime: { language: typescript }
http: true
database: { main: {} }
`,
    );
  }, LONG);

  afterAll(async () => {
    try {
      if (dir) {
        await track(app, tracked).catch(() => {});
        const r = await cli(["destroy", "--pr", "1"], dir);
        log(`destroy ${app} preview/pr-1: exit ${r.code} (${r.ms}ms)`);
      }
    } finally {
      await forceCleanup(app, tracked);
      const left = await leftoversSettled(app, tracked);
      await removeDir(dir);
      expect(left, `leftover resources for ${app}`).toEqual([]);
    }
  }, LONG);

  it(
    "deploys --pr 1 as an ephemeral preview/pr-1 in a single stack",
    async () => {
      const r = await cli(["deploy", "--pr", "1"], dir);
      log(`deploy ${app} preview/pr-1: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain(`Deploying ${app} (preview/pr-1)`);
      expect(r.stdout).toContain("flareon env url --pr 1 --with-token");
      expect(r.stdout).not.toContain("stage resources");
      url = urlFrom(r.stdout);
      await track(app, tracked);
      expect([...tracked.stacks]).toEqual([stack]);
    },
    LONG,
  );

  it("is protected: a form for browsers, 401 for other clients", async () => {
    const page = await get(`${url}/`, { accept: "text/html" });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain("Preview access");
    const api = await get(`${url}/whoami`);
    expect(api.status).toBe(401);
    const bad = await get(`${url}/__flareon/auth/preview?token=wrong`);
    expect(bad.status).toBe(401);
    expect(bad.headers.getSetCookie()).toEqual([]);
  });

  it(
    "the magic link from env url --with-token grants a session cookie",
    async () => {
      const plain = await cli(["env", "url", "--pr", "1"], dir);
      expect(plain.stdout.trim()).toBe(url);
      const r = await cli(["env", "url", "--pr", "1", "--with-token"], dir);
      expect(r.code, r.stderr).toBe(0);
      const link = r.stdout.trim();
      expect(link.startsWith(`${url}/__flareon/auth/preview?token=`)).toBe(true);

      const res = await get(link);
      expect(res.status).toBe(302);
      const cookies = res.headers.getSetCookie();
      expect(cookies.length).toBeGreaterThan(0);
      const cookie = cookies.map((c) => c.split(";")[0]).join("; ");

      const who = await get(`${url}/whoami`, { cookie });
      expect(who.status).toBe(200);
      const body = (await who.json()) as Record<string, string>;
      expect(body).toMatchObject({ mode: "preview", version: "pr-1", sub: "preview" });
      // preview は本番データを使わず専用の空テーブルを持つ
      expect(body.table).toContain(stack);

      const list = await cli(["env", "list"], dir);
      expect(list.stdout).toMatch(/preview\s+pr-1\s+ephemeral\s+-\s+ready/);
    },
    LONG,
  );

  it(
    "destroy --pr 1 removes the whole preview",
    async () => {
      const r = await cli(["destroy", "--pr", "1"], dir);
      log(`destroy ${app} preview/pr-1: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr).toBe(0);
      expect(await stackOutputs(stack)).toBeUndefined();
      const left = await leftoversSettled(app, tracked);
      expect(left).toEqual([]);
    },
    LONG,
  );
});
