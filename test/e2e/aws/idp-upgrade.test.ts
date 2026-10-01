// 既存 stage（組み込み Cognito サインイン、ユーザーあり）を provider: google + allow に切り替えても、
// User Pool が置換されず（＝ユーザーが消えず）、custom:hd 属性が追加されることを確認する。
// Google の資格情報はダミー（Cognito は作成時に Google へ問い合わせない）。実 Google ログインは範囲外。
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  DescribeUserPoolCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DescribeSecretCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
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

const yaml = (app: string, auth: string) => `version: 1
name: ${app}
runtime: { language: python, version: "3.13" }
http:
  auth:
${auth}`;

describe.runIf(ENABLED)("real AWS: switching an existing stage to google + allow", () => {
  const app = uniqueName("idp");
  const tracked = newTracked();
  const email = `e2e-${randomBytes(3).toString("hex")}@example.com`;
  const target = ["--stage", "prod", "--version", "v1"];
  const idp = new CognitoIdentityProviderClient({ region: REGION });
  const sm = new SecretsManagerClient({ region: REGION });
  let dir: string;
  let poolId: string;

  beforeAll(async () => {
    dir = await prepareApp("python", yaml(app, "    allow: { emails: [" + email + "] }\n"));
  }, LONG);

  afterAll(async () => {
    try {
      if (dir) {
        await track(app, tracked).catch(() => {});
        const r = await cli(["destroy", ...target, "--stage-resources", "--yes"], dir);
        log(`destroy ${app}: exit ${r.code} (${r.ms}ms)\n${r.stdout}${r.stderr}`);
      }
    } finally {
      await forceCleanup(app, tracked);
      for (const n of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) {
        // 安全網（destroy --stage-resources が消すはず）
        const id = `flarelet/${app}/prod/auth/${n}`;
        const gone = await sm
          .send(new DescribeSecretCommand({ SecretId: id }))
          .then((d) => Boolean(d.DeletedDate))
          .catch(() => true);
        expect(gone, `${id} left over`).toBe(true);
      }
      const left = await leftoversSettled(app, tracked);
      await removeDir(dir);
      expect(left, `leftover resources for ${app}`).toEqual([]);
    }
  }, LONG);

  it(
    "deploys with the built-in sign-in and an allow list",
    async () => {
      const r = await cli(["deploy", ...target], dir);
      log(`deploy ${app} (cognito): exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      await track(app, tracked);
      poolId = (await stackOutputs(`flarelet-${app}-prod`))!.UserPoolId!;
      await idp.send(
        new AdminCreateUserCommand({
          UserPoolId: poolId,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          MessageAction: "SUPPRESS",
        }),
      );
      const pool = await idp.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
      expect((pool.UserPool?.SchemaAttributes ?? []).map((a) => a.Name)).not.toContain("custom:hd");
    },
    LONG,
  );

  it(
    "switching to google adds custom:hd in place: same user pool, users kept",
    async () => {
      await writeFile(
        join(dir, "flarelet.yaml"),
        yaml(app, "    provider: google\n    allow: { domains: [example.com] }\n"),
      );
      for (const [n, v] of [
        ["GOOGLE_CLIENT_ID", "dummy-client-id.apps.googleusercontent.com"],
        ["GOOGLE_CLIENT_SECRET", `dummy-${randomBytes(8).toString("hex")}`],
      ] as const) {
        const s = await cli(["secret", "set", n, "--stage", "prod"], dir, v);
        expect(s.code, s.stderr).toBe(0);
      }
      const plan = await cli(["plan", ...target], dir);
      expect(plan.code, plan.stderr).toBe(0);
      log(`plan:\n${plan.stdout}`);

      const r = await cli(["deploy", ...target], dir);
      log(`deploy ${app} (google): exit ${r.code} in ${r.ms}ms`);
      expect(r.code, r.stderr + r.stdout).toBe(0);
      await track(app, tracked);

      expect((await stackOutputs(`flarelet-${app}-prod`))!.UserPoolId).toBe(poolId);
      const user = await idp.send(new AdminGetUserCommand({ UserPoolId: poolId, Username: email }));
      expect(user.Username).toBeTruthy();
      const pool = await idp.send(new DescribeUserPoolCommand({ UserPoolId: poolId }));
      expect((pool.UserPool?.SchemaAttributes ?? []).map((a) => a.Name)).toContain("custom:hd");

      // front は Google を直接指定して authorize へ送る
      const url = urlFrom(r.stdout);
      const login = await get(`${url}/__flarelet/auth/login`, { accept: "text/html" });
      expect(login.status).toBe(302);
      const authorize = new URL(login.headers.get("location")!);
      expect(authorize.searchParams.get("identity_provider")).toBe("Google");
      const client = await idp.send(
        new DescribeUserPoolClientCommand({
          UserPoolId: poolId,
          ClientId: authorize.searchParams.get("client_id")!,
        }),
      );
      expect(client.UserPoolClient?.ReadAttributes).toContain("custom:hd");
      expect(client.UserPoolClient?.WriteAttributes).toContain("custom:hd");
      expect(client.UserPoolClient?.SupportedIdentityProviders).toEqual(["Google"]);
    },
    LONG,
  );
});
