// PoC1（Python）+ PoC2（Cognito 認証 / Managed Login）+ PoC3（DB / Storage / AI / secrets）+ PoC4（stage/version）
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { chromium, type Browser, type BrowserContext } from "playwright";
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
  REGION,
  removeDir,
  stackOutputs,
  track,
  uniqueName,
  urlFrom,
} from "./helpers.js";

const SCREENSHOTS = process.env.FLAREON_E2E_SCREENSHOTS ?? join(process.cwd(), ".flareon", "e2e");

describe.runIf(ENABLED)("real AWS: python app with auth and bindings", () => {
  const app = uniqueName("py");
  const tracked = newTracked();
  const email = `e2e-${randomBytes(3).toString("hex")}@example.com`;
  const password = `Fl-${randomBytes(12).toString("base64url")}9a!`;
  const secretValue = randomBytes(16).toString("hex");
  const target = ["--default-branch", "main"];
  let dir: string;
  let browser: Browser | undefined;
  let ctx: BrowserContext;
  const urls: Record<string, string> = {};

  beforeAll(async () => {
    dir = await prepareApp(
      "python",
      `version: 1
name: ${app}
runtime: { language: python, version: "3.13" }
http: true
database: { main: {} }
storage: { files: {} }
ai: { models: [haiku] }
secrets: [E2E_SECRET]
git:
  production: { branch: "release/*", version: branch }
  preview: { branch: default }
  pullRequests: true
`,
    );
    browser = await chromium.launch();
    ctx = await browser.newContext();
  }, LONG);

  afterAll(async () => {
    try {
      await browser?.close();
      if (dir) {
        await track(app, tracked).catch(() => {});
        for (const v of ["v2", "v1"]) {
          const r = await cli(["destroy", "--branch", `release/${v}`, ...target], dir);
          log(`destroy ${app} prod/${v}: exit ${r.code} (${r.ms}ms)`);
        }
        const r = await cli(
          ["destroy", "--branch", "release/v1", ...target, "--stage-resources", "--yes"],
          dir,
        );
        log(`destroy ${app} prod stage resources: exit ${r.code} (${r.ms}ms)\n${r.stdout}`);
      }
    } finally {
      await forceCleanup(app, tracked);
      const left = await leftoversSettled(app, tracked);
      await removeDir(dir);
      expect(left, `leftover resources for ${app}`).toEqual([]);
    }
  }, LONG);

  /** Managed Login でサインインする（Cognito セッションが残っていればフォームは出ない）。 */
  async function signIn(url: string, path: string): Promise<unknown> {
    const page = await ctx.newPage();
    try {
      await page.goto(`${url}${path}`);
      if (page.url().includes("amazoncognito.com")) {
        await page.locator('input[name="username"]').fill(email);
        await page.locator('input[name="password"]').fill(password);
        await page.getByRole("button", { name: "Sign in" }).click();
      }
      await page.waitForURL((u) => u.href.startsWith(`${url}${path}`), { timeout: 60_000 });
      return JSON.parse((await page.textContent("body")) ?? "null");
    } catch (e) {
      await page.screenshot({ path: join(SCREENSHOTS, `${app}-signin.png`) }).catch(() => {});
      throw e;
    } finally {
      await page.close();
    }
  }

  const call = async (
    url: string,
    method: "get" | "put" | "post",
    path: string,
    data?: unknown,
  ) => {
    const r = await ctx.request[method](`${url}${path}`, data === undefined ? {} : { data });
    return { status: r.status(), body: await r.text() };
  };

  it(
    "deploys release/v1 to prod/v1 (stage + version stacks)",
    async () => {
      const r = await cli(["deploy", "--branch", "release/v1", ...target], dir);
      log(`deploy ${app} prod/v1: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain(`Deploying ${app} (prod/v1)`);
      expect(r.stdout).toContain("stage resources (prod)");
      expect(r.stdout).toContain("database.main");
      expect(r.stdout).not.toMatch(/AWS::|_IN_PROGRESS/);
      urls.v1 = urlFrom(r.stdout);
      await track(app, tracked);
    },
    LONG,
  );

  it("PoC2: redirects browsers to Cognito Managed Login and rejects other clients with 401", async () => {
    const url = urls.v1!;
    const nav = await get(`${url}/whoami`, { accept: "text/html" });
    expect(nav.status).toBe(302);
    const login = nav.headers.get("location")!;
    expect(login).toContain("/__flareon/auth/login");
    const login2 = await get(new URL(login, url).href, { accept: "text/html" });
    expect(login2.status).toBe(302);
    const authorize = new URL(login2.headers.get("location")!);
    expect(authorize.hostname).toMatch(/\.auth\.ap-northeast-1\.amazoncognito\.com$/);
    expect(authorize.pathname).toBe("/oauth2/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");

    const api = await get(`${url}/whoami`, { accept: "application/json" });
    expect(api.status).toBe(401);
    // クライアントが偽装した identity ヘッダは信用されない
    const spoof = await get(`${url}/whoami`, { "x-flareon-user-email": "evil@example.com" });
    expect(spoof.status).toBe(401);
  });

  it(
    "PoC2: a user created in the pool signs in and the app sees x-flareon-user-email",
    async () => {
      const pool = (await stackOutputs(`flareon-${app}-prod`))?.UserPoolId;
      expect(pool).toBeTruthy();
      const idp = new CognitoIdentityProviderClient({ region: REGION });
      await idp.send(
        new AdminCreateUserCommand({
          UserPoolId: pool,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          MessageAction: "SUPPRESS",
        }),
      );
      await idp.send(
        new AdminSetUserPasswordCommand({
          UserPoolId: pool,
          Username: email,
          Password: password,
          Permanent: true,
        }),
      );
      const list = await cli(["auth", "user", "list", "--stage", "prod"], dir);
      expect(list.code, list.stderr).toBe(0);
      expect(list.stdout).toMatch(new RegExp(`${email.replace(/\./g, "\\.")}\\s+CONFIRMED`));

      const who = (await signIn(urls.v1!, "/whoami")) as Record<string, string>;
      expect(who).toMatchObject({ email, mode: "cognito", version: "v1" });
      expect(who.sub).toBeTruthy();
      // PoC1（python）: 認証済みで / が 200
      const index = await call(urls.v1!, "get", "/");
      expect(index.status).toBe(200);
      expect(JSON.parse(index.body)).toMatchObject({ app: "python", user: email });
    },
    LONG,
  );

  it(
    "PoC3: the app uses DynamoDB, S3 and Bedrock through Flareon bindings",
    async () => {
      const url = urls.v1!;
      const put = await call(url, "put", "/db/shared", { value: "written-by-v1" });
      expect(put.status, put.body).toBe(200);
      const got = await call(url, "get", "/db/shared");
      expect(JSON.parse(got.body)).toMatchObject({ value: "written-by-v1" });

      const fput = await call(url, "put", "/files/hello.txt", "hello storage");
      expect(fput.status, fput.body).toBe(200);
      const fget = await call(url, "get", "/files/hello.txt");
      expect(fget).toEqual({ status: 200, body: "hello storage" });

      const ai = await call(url, "post", "/ai");
      expect(ai.status, ai.body).toBe(200);
      const aiBody = JSON.parse(ai.body) as { model: string; text: string };
      expect(aiBody.model).toBe("global.anthropic.claude-haiku-4-5-20251001-v1:0");
      expect(aiBody.text.length).toBeGreaterThan(0);
      log(`bedrock replied: ${JSON.stringify(aiBody.text)}`);
    },
    LONG,
  );

  it(
    "PoC3: flareon secret set makes the value available to the app as an env var",
    async () => {
      const url = urls.v1!;
      expect(JSON.parse((await call(url, "get", "/secret")).body)).toEqual({
        present: false,
        sha256: null,
      });
      const set = await cli(["secret", "set", "E2E_SECRET", "--stage", "prod"], dir, secretValue);
      expect(set.code, set.stderr).toBe(0);
      expect(set.stdout + set.stderr).not.toContain(secretValue);
      expect(set.stdout).toContain("Restarted prod (v1)");
      const list = await cli(["secret", "list", "--stage", "prod"], dir);
      expect(list.stdout).toMatch(/E2E_SECRET\s+set/);
      expect(list.stdout).not.toContain(secretValue);

      const s = JSON.parse((await call(url, "get", "/secret")).body);
      expect(s).toEqual({
        present: true,
        sha256: createHash("sha256").update(secretValue).digest("hex"),
      });
    },
    LONG,
  );

  it(
    "PoC4: release/v2 deploys prod/v2 sharing the stage database but with its own compute",
    async () => {
      const r = await cli(["deploy", "--branch", "release/v2", ...target], dir);
      log(`deploy ${app} prod/v2: exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain(`Deploying ${app} (prod/v2)`);
      urls.v2 = urlFrom(r.stdout);
      expect(urls.v2).not.toBe(urls.v1);
      await track(app, tracked);

      const who2 = (await signIn(urls.v2, "/whoami")) as Record<string, string>;
      expect(who2).toMatchObject({ email, version: "v2" });
      const who1 = JSON.parse((await call(urls.v1!, "get", "/whoami")).body);
      expect(who2.function).not.toBe(who1.function);

      const v1 = JSON.parse((await call(urls.v1!, "get", "/db/shared")).body);
      const v2 = JSON.parse((await call(urls.v2, "get", "/db/shared")).body);
      expect(v2).toEqual({ value: "written-by-v1", table: v1.table });
      // secrets も stage スコープ
      expect(JSON.parse((await call(urls.v2, "get", "/secret")).body).present).toBe(true);

      const list = await cli(["env", "list"], dir);
      expect(list.stdout).toMatch(/prod\s+v1\s+persistent\s+release\/v1\s+ready/);
      expect(list.stdout).toMatch(/prod\s+v2\s+persistent\s+release\/v2\s+ready/);
    },
    LONG,
  );

  it(
    "destroying a version keeps the stage resources; --stage-resources needs --yes",
    async () => {
      const r = await cli(["destroy", "--branch", "release/v2", ...target], dir);
      expect(r.code, r.stderr).toBe(0);
      expect(r.stdout).toContain("are kept");
      expect(await stackOutputs(`flareon-${app}-prod-v2`)).toBeUndefined();
      expect(await stackOutputs(`flareon-${app}-prod`)).toBeDefined();
      // v1 からはまだ読める（データは stage スコープで残る）
      expect(JSON.parse((await call(urls.v1!, "get", "/db/shared")).body).value).toBe(
        "written-by-v1",
      );
      const refuse = await cli(
        ["destroy", "--branch", "release/v1", ...target, "--stage-resources"],
        dir,
      );
      expect(refuse.code).toBe(1);
      expect(await stackOutputs(`flareon-${app}-prod-v1`)).toBeDefined();

      const rm = await cli(["auth", "user", "remove", email, "--stage", "prod"], dir);
      expect(rm.code, rm.stderr).toBe(0);
    },
    LONG,
  );
});
