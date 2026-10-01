import type { Stack } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { conceptOf } from "../../src/aws/concepts.js";
import { parseConfig } from "../../src/config/index.js";
import { buildApp, idpSecretName } from "../../src/constructs/index.js";
import { toIR } from "../../src/ir/index.js";
import type { Deployment } from "../../src/resolver/index.js";

const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};

const prod: Deployment = { stage: "prod", version: "v1", lifecycle: "persistent" };
const pr: Deployment = { stage: "preview", version: "pr-7", lifecycle: "ephemeral" };

const GOOGLE = `version: 1
name: myapp
runtime: { language: python }
http:
  auth:
    provider: google
`;
const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const ENTRA = `version: 1
name: myapp
runtime: { language: python }
http:
  auth:
    provider: entra
    tenant: ${TENANT}
`;
const frontEnv = (version: Stack) => {
  const fns = Template.fromStack(version).findResources("AWS::Lambda::Function");
  const front = Object.values(fns).find((f) =>
    JSON.stringify(f).includes("FLARELET_AUTH_MODE"),
  ) as {
    Properties: { Environment: { Variables: Record<string, unknown> } };
  };
  return front.Properties.Environment.Variables;
};
const poolSchema = (stage: Stack) =>
  Object.values(Template.fromStack(stage).findResources("AWS::Cognito::UserPool"))[0]!.Properties
    .Schema as { Name: string }[];

const OIDC = `version: 1
name: myapp
runtime: { language: python }
http:
  auth:
    provider: oidc
    issuer: https://idp.example.com
    name: Okta
`;

function build(yaml: string, d: Deployment, idpSecretVersions?: Record<string, string>) {
  return buildApp({
    ir: ir(yaml),
    deployment: d,
    region: "ap-northeast-1",
    ...(idpSecretVersions ? { idpSecretVersions } : {}),
    code: {
      app: lambda.Code.fromInline("def handler(e, c): pass"),
      front: lambda.Code.fromInline("exports.handler = async () => ({})"),
    },
  });
}

const sm = (name: string, version = "") =>
  `{{resolve:secretsmanager:${name}:SecretString:::${version}}}`;

describe("external IdP: google", () => {
  it("adds a Google identity provider to the stage user pool with Secrets Manager references", () => {
    const { stage } = build(GOOGLE, prod);
    const t = Template.fromStack(stage!);
    t.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    t.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "Google",
      ProviderType: "Google",
      UserPoolId: { Ref: Match.stringLikeRegexp("UserPool") },
      ProviderDetails: {
        client_id: sm("flarelet/myapp/prod/auth/GOOGLE_CLIENT_ID"),
        client_secret: sm("flarelet/myapp/prod/auth/GOOGLE_CLIENT_SECRET"),
        authorize_scopes: "openid email profile",
      },
      AttributeMapping: { email: "email", email_verified: "email_verified", "custom:hd": "hd" },
    });
  });

  it("adds custom:hd to the user pool (always for google, so adding allow later never changes the schema)", () => {
    const { stage } = build(GOOGLE, prod);
    expect(poolSchema(stage!)).toContainEqual(
      expect.objectContaining({ Name: "hd", AttributeDataType: "String", Mutable: true }),
    );
  });

  it("lets the app client read custom:hd and write the mapped attributes", () => {
    const { version } = build(GOOGLE, prod);
    const client = Object.values(
      Template.fromStack(version).findResources("AWS::Cognito::UserPoolClient"),
    )[0]!.Properties as { ReadAttributes: string[]; WriteAttributes: string[] };
    expect([...client.ReadAttributes].sort()).toEqual(["custom:hd", "email", "email_verified"]);
    // email_verified はクライアントの書き込み属性に指定できない（Cognito が拒否する）
    expect([...client.WriteAttributes].sort()).toEqual(["custom:hd", "email"]);
  });

  it("passes the provider and allow lists to the front Lambda", () => {
    const { version } = build(
      GOOGLE +
        "    allow:\n      domains: [example.com, example.org]\n      emails: [a@gmail.com]\n",
      prod,
    );
    expect(frontEnv(version)).toMatchObject({
      FLARELET_AUTH_PROVIDER: "google",
      FLARELET_AUTH_ALLOW_DOMAINS: "example.com,example.org",
      FLARELET_AUTH_ALLOW_EMAILS: "a@gmail.com",
    });
  });

  it("pins the secret versions when known so a rotated secret updates the provider", () => {
    const { stage } = build(GOOGLE, prod, {
      GOOGLE_CLIENT_ID: "v-id-1",
      GOOGLE_CLIENT_SECRET: "v-secret-2",
    });
    Template.fromStack(stage!).hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderDetails: {
        client_id: sm("flarelet/myapp/prod/auth/GOOGLE_CLIENT_ID", "v-id-1"),
        client_secret: sm("flarelet/myapp/prod/auth/GOOGLE_CLIENT_SECRET", "v-secret-2"),
      },
    });
  });

  it("never puts a secret value into the template", () => {
    const { stage } = build(GOOGLE, prod, { GOOGLE_CLIENT_SECRET: "v1" });
    const json = JSON.stringify(Template.fromStack(stage!).toJSON());
    expect(json).not.toMatch(/ssm-secure/);
    expect(json.match(/client_secret":"([^"]*)"/)?.[1]).toMatch(/^\{\{resolve:secretsmanager:/);
  });

  it("makes the version's app client use only Google and tells the front Lambda", () => {
    const { version } = build(GOOGLE, prod);
    const t = Template.fromStack(version);
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["Google"],
    });
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ FLARELET_COGNITO_IDENTITY_PROVIDER: "Google" }),
      },
    });
  });

  it("PR previews keep preview-token auth and have no IdP", () => {
    const { stage, version } = build(GOOGLE, pr);
    expect(stage).toBeUndefined();
    Template.fromStack(version).resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
  });
});

describe("external IdP: oidc", () => {
  it("adds an OIDC identity provider with issuer, scopes and email mapping", () => {
    const { stage } = build(OIDC, prod);
    Template.fromStack(stage!).hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "Okta",
      ProviderType: "OIDC",
      ProviderDetails: Match.objectLike({
        client_id: sm("flarelet/myapp/prod/auth/OIDC_CLIENT_ID"),
        client_secret: sm("flarelet/myapp/prod/auth/OIDC_CLIENT_SECRET"),
        oidc_issuer: "https://idp.example.com",
        authorize_scopes: "openid email profile",
      }),
      AttributeMapping: { email: "email", email_verified: "email_verified" },
    });
  });

  it("does not add custom attributes to the user pool", () => {
    const { stage } = build(OIDC, prod);
    expect(poolSchema(stage!).map((a) => a.Name)).toEqual(["email"]);
  });

  it("restricts the app client to the OIDC provider", () => {
    const { version } = build(OIDC, prod);
    Template.fromStack(version).hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["Okta"],
    });
  });
});

describe("external IdP: entra", () => {
  it("adds Entra ID as a single-tenant OIDC provider", () => {
    const { stage } = build(ENTRA, prod);
    const t = Template.fromStack(stage!);
    t.resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 1);
    t.hasResourceProperties("AWS::Cognito::UserPoolIdentityProvider", {
      ProviderName: "EntraID",
      ProviderType: "OIDC",
      ProviderDetails: {
        client_id: sm("flarelet/myapp/prod/auth/ENTRA_CLIENT_ID"),
        client_secret: sm("flarelet/myapp/prod/auth/ENTRA_CLIENT_SECRET"),
        oidc_issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
        authorize_scopes: "openid email profile",
        attributes_request_method: "GET",
      },
      AttributeMapping: { email: "email", preferred_username: "preferred_username" },
    });
    expect(poolSchema(stage!).map((a) => a.Name)).toEqual(["email"]);
  });

  it("restricts the app client to Entra ID and tells the front Lambda", () => {
    const { version } = build(ENTRA + "    allow: { domains: [contoso.com] }\n", prod);
    Template.fromStack(version).hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["EntraID"],
    });
    expect(frontEnv(version)).toMatchObject({
      FLARELET_COGNITO_IDENTITY_PROVIDER: "EntraID",
      FLARELET_AUTH_PROVIDER: "entra",
      FLARELET_AUTH_ALLOW_DOMAINS: "contoso.com",
    });
  });
});

describe("allow with the built-in Cognito sign-in", () => {
  it("passes the allow lists to the front Lambda and leaves the user pool unchanged", () => {
    const yaml =
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp:\n  auth:\n    allow: { emails: [a@example.com] }\n";
    const { stage, version } = build(yaml, prod);
    expect(frontEnv(version)).toMatchObject({
      FLARELET_AUTH_PROVIDER: "cognito",
      FLARELET_AUTH_ALLOW_EMAILS: "a@example.com",
    });
    expect(frontEnv(version)).not.toHaveProperty("FLARELET_AUTH_ALLOW_DOMAINS");
    const plain = build(
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp: true\n",
      prod,
    );
    expect(Template.fromStack(stage!).toJSON()).toEqual(Template.fromStack(plain.stage!).toJSON());
  });

  it("PR previews (preview-token auth) do not get the allow lists", () => {
    const { version } = build(GOOGLE + "    allow: { domains: [example.com] }\n", pr);
    expect(frontEnv(version)).not.toHaveProperty("FLARELET_AUTH_ALLOW_DOMAINS");
  });
});

describe("default cognito auth is unchanged", () => {
  it("has no IdP and uses COGNITO", () => {
    const yaml = "version: 1\nname: myapp\nruntime: { language: python }\nhttp: true\n";
    const { stage, version } = build(yaml, prod);
    Template.fromStack(stage!).resourceCountIs("AWS::Cognito::UserPoolIdentityProvider", 0);
    const t = Template.fromStack(version);
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      SupportedIdentityProviders: ["COGNITO"],
    });
    const fns = t.findResources("AWS::Lambda::Function");
    expect(JSON.stringify(fns)).not.toContain("FLARELET_COGNITO_IDENTITY_PROVIDER");
    expect(JSON.stringify(fns)).not.toContain("FLARELET_AUTH_ALLOW_");
    expect(poolSchema(stage!).map((a) => a.Name)).toEqual(["email"]);
    const client = Object.values(t.findResources("AWS::Cognito::UserPoolClient"))[0]!.Properties;
    expect(client).not.toHaveProperty("ReadAttributes");
    expect(client).not.toHaveProperty("WriteAttributes");
  });
});

describe("naming and concepts", () => {
  it("idpSecretName is stage scoped", () => {
    expect(idpSecretName("myapp", "prod", "GOOGLE_CLIENT_ID")).toBe(
      "flarelet/myapp/prod/auth/GOOGLE_CLIENT_ID",
    );
  });

  it("the identity provider is part of authentication", () => {
    expect(conceptOf("flarelet-myapp-prod/IdentityProvider/Resource")).toBe("authentication");
  });
});
