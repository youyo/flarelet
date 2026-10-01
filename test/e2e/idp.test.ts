// 外部 IdP（google / oidc / entra）と http.auth.allow の synth / validate / secret 振る舞い（AWS には接続しない）
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli/index.js");
const ENV = {
  ...process.env,
  FLAREON_SKIP_BUNDLING: "1",
  FLAREON_OFFLINE: "1",
  AWS_REGION: "ap-northeast-1",
  AWS_ACCESS_KEY_ID: "AKIAEXAMPLE",
  AWS_SECRET_ACCESS_KEY: "invalid",
  AWS_SESSION_TOKEN: "",
  AWS_PROFILE: "",
  AWS_ENDPOINT_URL: "http://127.0.0.1:9",
  AWS_MAX_ATTEMPTS: "1",
};

function run(args: string[], cwd: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
    execFile(process.execPath, [CLI, ...args], { cwd, env: ENV }, (err, so, se) => {
      res({
        code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
        stdout: so,
        stderr: se,
      });
    });
  });
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "flareon-e2e-idp-"));
  await mkdir(join(dir, "app"));
  await writeFile(join(dir, "app", "main.py"), "app = None\n");
  await writeFile(join(dir, "app", "requirements.txt"), "uvicorn\n");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const yaml = (auth: string) =>
  `version: 1\nname: idpapp\nruntime: { language: python }\nhttp:\n  auth:\n${auth}`;

type Tpl = { Resources: Record<string, { Type: string; Properties: Record<string, unknown> }> };
const template = async (stack: string): Promise<Tpl> =>
  JSON.parse(await readFile(join(dir, ".flareon", "out", `${stack}.template.json`), "utf8"));
const ofType = (t: Tpl, type: string) => Object.values(t.Resources).filter((r) => r.Type === type);

describe("external identity providers (synth)", () => {
  it("google: the stage stack federates Google via Secrets Manager references", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    provider: google\n"));
    const r = await run(["synth", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);

    const stage = await template("flareon-idpapp-prod");
    const [idp] = ofType(stage, "AWS::Cognito::UserPoolIdentityProvider");
    expect(idp?.Properties.ProviderType).toBe("Google");
    const details = idp?.Properties.ProviderDetails as Record<string, string>;
    expect(details.client_id).toBe(
      "{{resolve:secretsmanager:flareon/idpapp/prod/auth/GOOGLE_CLIENT_ID:SecretString:::}}",
    );
    expect(details.client_secret).toBe(
      "{{resolve:secretsmanager:flareon/idpapp/prod/auth/GOOGLE_CLIENT_SECRET:SecretString:::}}",
    );
    expect(idp?.Properties.AttributeMapping).toEqual({
      email: "email",
      email_verified: "email_verified",
      "custom:hd": "hd",
    });
    const [pool] = ofType(stage, "AWS::Cognito::UserPool");
    expect(pool?.Properties.Schema).toContainEqual(expect.objectContaining({ Name: "hd" }));

    const version = await template("flareon-idpapp-prod-v1");
    const [client] = ofType(version, "AWS::Cognito::UserPoolClient");
    expect(client?.Properties.SupportedIdentityProviders).toEqual(["Google"]);
  });

  it("oidc: issuer and display name come from flareon.yaml", async () => {
    await writeFile(
      join(dir, "flareon.yaml"),
      yaml("    provider: oidc\n    issuer: https://login.example.com\n    name: Corp\n"),
    );
    const r = await run(["synth", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);
    const [idp] = ofType(
      await template("flareon-idpapp-prod"),
      "AWS::Cognito::UserPoolIdentityProvider",
    );
    expect(idp?.Properties.ProviderType).toBe("OIDC");
    expect(idp?.Properties.ProviderName).toBe("Corp");
    expect((idp?.Properties.ProviderDetails as Record<string, string>).oidc_issuer).toBe(
      "https://login.example.com",
    );
    const [client] = ofType(
      await template("flareon-idpapp-prod-v1"),
      "AWS::Cognito::UserPoolClient",
    );
    expect(client?.Properties.SupportedIdentityProviders).toEqual(["Corp"]);
  });

  it("entra: single-tenant OIDC with the tenant-specific issuer", async () => {
    const tenant = "72f988bf-86f1-41af-91ab-2d7cd011db47";
    await writeFile(
      join(dir, "flareon.yaml"),
      yaml(`    provider: entra\n    tenant: ${tenant}\n    allow: { domains: [contoso.com] }\n`),
    );
    const r = await run(["synth", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);
    const [idp] = ofType(
      await template("flareon-idpapp-prod"),
      "AWS::Cognito::UserPoolIdentityProvider",
    );
    expect(idp?.Properties.ProviderType).toBe("OIDC");
    expect(idp?.Properties.ProviderName).toBe("EntraID");
    const details = idp?.Properties.ProviderDetails as Record<string, string>;
    expect(details.oidc_issuer).toBe(`https://login.microsoftonline.com/${tenant}/v2.0`);
    expect(details.client_secret).toBe(
      "{{resolve:secretsmanager:flareon/idpapp/prod/auth/ENTRA_CLIENT_SECRET:SecretString:::}}",
    );
    const version = await template("flareon-idpapp-prod-v1");
    const [client] = ofType(version, "AWS::Cognito::UserPoolClient");
    expect(client?.Properties.SupportedIdentityProviders).toEqual(["EntraID"]);
    const vars = JSON.stringify(ofType(version, "AWS::Lambda::Function"));
    expect(vars).toContain('"FLAREON_AUTH_PROVIDER":"entra"');
    expect(vars).toContain('"FLAREON_AUTH_ALLOW_DOMAINS":"contoso.com"');
  });

  it("allow: the built-in Cognito sign-in passes the list to the front Lambda only", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    allow: { emails: [a@example.com] }\n"));
    const r = await run(["synth", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);
    const vars = JSON.stringify(
      ofType(await template("flareon-idpapp-prod-v1"), "AWS::Lambda::Function"),
    );
    expect(vars).toContain('"FLAREON_AUTH_ALLOW_EMAILS":"a@example.com"');
    const [pool] = ofType(await template("flareon-idpapp-prod"), "AWS::Cognito::UserPool");
    expect((pool?.Properties.Schema as { Name: string }[]).map((a) => a.Name)).toEqual(["email"]);
  });

  it("plan lists authentication for an external provider", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    provider: google\n"));
    const r = await run(["plan", "--stage", "prod", "--version", "v1"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("+ authentication");
  });
});

describe("external identity providers (validation)", () => {
  it("saml is rejected as not supported in v0", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    provider: saml\n"));
    const r = await run(["validate"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/http\.auth\.provider: "saml" is not supported in v0/);
  });

  it("entra without a tenant, or with a multi-tenant one, is rejected", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    provider: entra\n"));
    const r = await run(["validate"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/http\.auth\.tenant: is required/);
    await writeFile(join(dir, "flareon.yaml"), yaml("    provider: entra\n    tenant: common\n"));
    const m = await run(["validate"], dir);
    expect(m.code).toBe(1);
    expect(m.stderr).toMatch(/http\.auth\.tenant: must be your own tenant/);
  });

  it("an empty allow is rejected", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    allow: {}\n"));
    const r = await run(["validate"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/http\.auth\.allow: must list at least one/);
  });

  it("oidc without issuer is rejected", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    provider: oidc\n"));
    const r = await run(["validate"], dir);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/http\.auth\.issuer: is required/);
  });

  it("validate summarizes the provider", async () => {
    await writeFile(join(dir, "flareon.yaml"), yaml("    provider: google\n"));
    const r = await run(["validate"], dir);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/authenticated \(google\)/);
  });
});
