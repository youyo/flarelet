// Preview（PoC5 の CLI 部分）: --pr N → preview/pr-N、Preview Auth（トークン）、destroy でスタックごと削除
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE } from "../../../src/auth/session.js";
import {
  cli,
  ENABLED,
  eventually,
  forceCleanup,
  get,
  leftoversSettled,
  log,
  LONG,
  newTracked,
  prepareApp,
  REGION,
  removeDir,
  stackOutputs,
  track,
  uniqueName,
  urlFrom,
} from "./helpers.js";

const sm = new SecretsManagerClient({ region: REGION });

describe.runIf(ENABLED)("real AWS: PR preview", () => {
  const app = uniqueName("pr");
  const tracked = newTracked();
  const stack = `flareon-${app}-preview-pr-1`;
  let dir: string;
  let url: string;
  let cookie: string;

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
      cookie = cookies.map((c) => c.split(";")[0]).join("; ");

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
    "auth revoke-sessions --pr 1 signs out existing preview sessions",
    async () => {
      expect((await get(`${url}/whoami`, { cookie })).status).toBe(200);
      const r = await cli(["auth", "revoke-sessions", "--pr", "1"], dir);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("Revoked all sessions of preview/pr-1");
      // front はセッション世代を 60 秒キャッシュする（コンテナごと）
      const status = await eventually(
        async () => {
          const s = (await get(`${url}/whoami`, { cookie })).status;
          return s === 200 ? undefined : s;
        },
        150_000,
        5_000,
      );
      expect(status).toBe(401);
      // 新しいマジックリンクで入り直せる
      const link = (await cli(["env", "url", "--pr", "1", "--with-token"], dir)).stdout.trim();
      const again = (await get(link)).headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      expect((await get(`${url}/whoami`, { cookie: again })).status).toBe(200);
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

// http.auth: false でも PR preview は Preview Auth で保護される（仕様 §9: 誤って無認証公開にしない）
describe.runIf(ENABLED)("real AWS: PR preview of a public (auth: false) app", () => {
  const app = uniqueName("prpub");
  const tracked = newTracked();
  const stack = `flareon-${app}-preview-pr-2`;
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
        const r = await cli(["destroy", "--pr", "2"], dir);
        log(`destroy ${app} preview/pr-2: exit ${r.code} (${r.ms}ms)`);
      }
    } finally {
      await forceCleanup(app, tracked);
      const left = await leftoversSettled(app, tracked);
      await removeDir(dir);
      expect(left, `leftover resources for ${app}`).toEqual([]);
    }
  }, LONG);

  it(
    "deploys with Preview Auth forced and says so",
    async () => {
      const plan = await cli(["plan", "--pr", "2"], dir);
      expect(plan.code, plan.stderr).toBe(0);
      expect(plan.stdout).toContain("preview authentication (forced for pull request previews)");

      const r = await cli(["deploy", "--pr", "2"], dir);
      log(`deploy ${app} preview/pr-2: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain("Auth  preview token (forced for pull request previews)");
      expect(r.stdout).not.toContain("none (public)");
      url = urlFrom(r.stdout);
      await track(app, tracked);
      expect([...tracked.stacks]).toEqual([stack]);
    },
    LONG,
  );

  it("rejects unauthenticated requests, including forged identity headers", async () => {
    expect((await get(`${url}/`)).status).toBe(401);
    const forged = await get(`${url}/whoami`, {
      "x-flareon-user-sub": "admin",
      "x-flareon-auth-mode": "cognito",
    });
    expect(forged.status).toBe(401);
  });

  it(
    "the magic link grants a __Host- session cookie and redirects to a URL without the token",
    async () => {
      const r = await cli(["env", "url", "--pr", "2", "--with-token"], dir);
      expect(r.code, r.stderr).toBe(0);
      const link = r.stdout.trim();
      const res = await get(link);
      expect(res.status).toBe(302);
      // トークンを含む URL を履歴・Referer に残さない
      expect(res.headers.get("location")).toBe("/");
      const cookies = res.headers.getSetCookie();
      const session = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`));
      expect(session).toBeDefined();
      expect(session).toMatch(/; Secure/);
      expect(session).toMatch(/; Path=\/(;|$)/);
      expect(session).not.toMatch(/Domain=/i);

      const who = await get(`${url}/whoami`, {
        cookie: session!.split(";")[0]!,
        // クライアントが付けた x-flareon-* は front が剥がして付け直す
        "x-flareon-user-sub": "admin",
      });
      expect(who.status).toBe(200);
      expect(await who.json()).toMatchObject({
        sub: "preview",
        mode: "preview",
        version: "pr-2",
        authEnabled: "true",
      });

      // CI ロールが読めるのは flareon:stage=preview かつ flareon:lifecycle=ephemeral のシークレットだけ
      const arn = (await stackOutputs(stack))?.PreviewTokenSecretArn;
      expect(arn).toBeDefined();
      const d = await sm.send(new DescribeSecretCommand({ SecretId: arn }));
      const tags = Object.fromEntries((d.Tags ?? []).map((t) => [t.Key, t.Value]));
      expect(tags).toMatchObject({ "flareon:stage": "preview", "flareon:lifecycle": "ephemeral" });
    },
    LONG,
  );

  it(
    "destroy --pr 2 removes the whole preview",
    async () => {
      const r = await cli(["destroy", "--pr", "2"], dir);
      expect(r.code, r.stderr).toBe(0);
      expect(await stackOutputs(stack)).toBeUndefined();
      expect(await leftoversSettled(app, tracked)).toEqual([]);
    },
    LONG,
  );
});
