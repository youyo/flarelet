import * as lambda from "aws-cdk-lib/aws-lambda";
import { Match, Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { buildApp, domainPrefix, stackNames } from "../../src/constructs/index.js";
import { toIR } from "../../src/ir/index.js";
import type { Deployment } from "../../src/resolver/index.js";

const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};

const FULL = `version: 1
name: myapp
runtime: { language: python, version: "3.13" }
http: true
database: { main: {}, sessions: {} }
storage: { files: {} }
ai: { models: [sonnet, nova-micro] }
secrets: [EXTERNAL_API_KEY]
`;

const prod: Deployment = { stage: "prod", version: "v1", lifecycle: "persistent" };
const pr: Deployment = { stage: "preview", version: "pr-123", lifecycle: "ephemeral" };

function build(yaml: string, deployment: Deployment, region = "us-east-1") {
  return buildApp({
    ir: ir(yaml),
    deployment,
    region,
    code: {
      app: lambda.Code.fromInline("def handler(e, c): pass"),
      front: lambda.Code.fromInline("exports.handler = async () => ({})"),
    },
  });
}

type Tpl = Record<string, unknown>;
const stmts = (t: Template) =>
  Object.values(t.findResources("AWS::IAM::Policy")).flatMap((p) => {
    const s = (p as { Properties: { PolicyDocument: { Statement: unknown[] } } }).Properties
      .PolicyDocument.Statement;
    return s as {
      Action: string | string[];
      Resource: unknown;
      Effect: string;
      Condition?: unknown;
    }[];
  });

/** リソース間の Ref / GetAtt / DependsOn グラフに循環が無いことを確認する。 */
function findCycle(template: Tpl): string[] | null {
  const resources = (template.Resources ?? {}) as Record<string, unknown>;
  const edges = new Map<string, Set<string>>();
  const collect = (v: unknown, into: Set<string>) => {
    if (Array.isArray(v)) return v.forEach((x) => collect(x, into));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (k === "Ref" && typeof x === "string" && x in resources) into.add(x);
        else if (
          k === "Fn::GetAtt" &&
          Array.isArray(x) &&
          typeof x[0] === "string" &&
          x[0] in resources
        )
          into.add(x[0]);
        else collect(x, into);
      }
    }
  };
  for (const [id, r] of Object.entries(resources)) {
    const s = new Set<string>();
    collect((r as { Properties?: unknown }).Properties, s);
    const dep = (r as { DependsOn?: string | string[] }).DependsOn;
    for (const d of [dep ?? []].flat()) s.add(d);
    edges.set(id, s);
  }
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const m of edges.get(n) ?? []) {
      const c = visit(m);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const id of edges.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return null;
}

describe("test helper: findCycle", () => {
  it("detects a cycle (so the acyclic assertions are meaningful)", () => {
    const t = {
      Resources: {
        A: { Properties: { x: { "Fn::GetAtt": ["B", "Arn"] } } },
        B: { Properties: { y: { Ref: "A" } } },
      },
    };
    expect(findCycle(t)).not.toBeNull();
    expect(
      findCycle({ Resources: { A: { Properties: {} }, B: { Properties: { y: { Ref: "A" } } } } }),
    ).toBeNull();
  });
});

describe("names", () => {
  it("builds stack names", () => {
    expect(stackNames("myapp", prod)).toEqual({
      stage: "flarelet-myapp-prod",
      version: "flarelet-myapp-prod-v1",
    });
    expect(stackNames("myapp", pr).stage).toBeUndefined();
    expect(stackNames("myapp", pr).version).toBe("flarelet-myapp-preview-pr-123");
  });

  it("domain prefix is deterministic, valid for Cognito and varies with the account", () => {
    const a = domainPrefix("myapp", "prod");
    expect(a).toMatch(/^myapp-prod-[0-9a-f]{6}$/);
    expect(domainPrefix("myapp", "prod")).toBe(a);
    expect(domainPrefix("myapp", "prod", "111111111111")).not.toBe(a);
    expect(domainPrefix("myapp", "prod", "111111111111")).not.toBe(
      domainPrefix("myapp", "prod", "222222222222"),
    );
  });

  it("rejects app names Cognito forbids in a domain prefix", () => {
    expect(() => domainPrefix("my-aws-app", "prod")).toThrow(/aws|amazon|cognito/);
  });
});

describe("persistent stage: stage stack", () => {
  const { stage } = build(FULL, prod);
  const t = Template.fromStack(stage!);

  it("is named per lifecycle scope and tagged", () => {
    expect(stage!.stackName).toBe("flarelet-myapp-prod");
    expect(stage!.tags.tagValues()).toMatchObject({
      "flarelet:app": "myapp",
      "flarelet:stage": "prod",
    });
  });

  it("has a Cognito user pool with a Managed Login domain", () => {
    t.resourceCountIs("AWS::Cognito::UserPool", 1);
    t.hasResourceProperties("AWS::Cognito::UserPool", {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: true },
    });
    t.hasResourceProperties("AWS::Cognito::UserPoolDomain", {
      Domain: domainPrefix("myapp", "prod"),
      ManagedLoginVersion: 2,
    });
  });

  it("has retained on-demand DynamoDB tables with PITR (pk/sk strings)", () => {
    t.resourceCountIs("AWS::DynamoDB::Table", 2);
    t.allResourcesProperties("AWS::DynamoDB::Table", {
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
    });
    for (const r of Object.values(t.findResources("AWS::DynamoDB::Table"))) {
      expect(r.DeletionPolicy).toBe("Retain");
    }
  });

  it("has a retained, encrypted, private S3 bucket", () => {
    t.resourceCountIs("AWS::S3::Bucket", 1);
    t.hasResourceProperties("AWS::S3::Bucket", {
      BucketEncryption: Match.objectLike({
        ServerSideEncryptionConfiguration: Match.anyValue(),
      }),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
    for (const r of Object.values(t.findResources("AWS::S3::Bucket"))) {
      expect(r.DeletionPolicy).toBe("Retain");
    }
    t.resourceCountIs("Custom::S3AutoDeleteObjects", 0);
  });

  it("generates the cookie signing key natively in Secrets Manager", () => {
    t.hasResourceProperties("AWS::SecretsManager::Secret", {
      GenerateSecretString: Match.objectLike({ PasswordLength: Match.anyValue() }),
    });
  });

  it("has no compute or API", () => {
    t.resourceCountIs("AWS::Lambda::Function", 0);
    t.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
  });
});

describe("persistent stage: version stack", () => {
  const { stage, version } = build(FULL, prod);
  const t = Template.fromStack(version);

  it("is named, tagged and depends on the stage stack", () => {
    expect(version.stackName).toBe("flarelet-myapp-prod-v1");
    expect(version.tags.tagValues()).toMatchObject({
      "flarelet:app": "myapp",
      "flarelet:stage": "prod",
      "flarelet:version": "v1",
    });
    expect(version.dependencies).toContain(stage);
  });

  it("has an HTTP API whose $default route goes to the front auth Lambda", () => {
    t.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    t.hasResourceProperties("AWS::ApiGatewayV2::Api", { ProtocolType: "HTTP" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Route", { RouteKey: "$default" });
    t.hasResourceProperties("AWS::ApiGatewayV2::Integration", { PayloadFormatVersion: "2.0" });
  });

  it("runs the app on arm64 Lambda with Lambda Web Adapter", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "python3.13",
      Architectures: ["arm64"],
      Handler: "flarelet-launcher.sh",
      Layers: ["arn:aws:lambda:us-east-1:753240598075:layer:LambdaAdapterLayerArm64:30"],
      Environment: {
        Variables: Match.objectLike({
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
          PORT: "8080",
          FLARELET_APP: "myapp",
          FLARELET_STAGE: "prod",
          FLARELET_VERSION: "v1",
          FLARELET_SECRETS_PATH: "/flarelet/myapp/prod/secrets/",
          FLARELET_DATABASE_MAIN_TABLE: Match.anyValue(),
          FLARELET_DATABASE_SESSIONS_TABLE: Match.anyValue(),
          FLARELET_STORAGE_FILES_BUCKET: Match.anyValue(),
          FLARELET_AI_SONNET_MODEL_ID: "global.anthropic.claude-sonnet-5-5",
          FLARELET_AI_NOVA_MICRO_MODEL_ID: "us.amazon.nova-micro-v1:0",
        }),
      },
    });
  });

  it("creates a front auth Lambda wired per the env contract", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      Runtime: "nodejs24.x",
      Architectures: ["arm64"],
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          FLARELET_AUTH_MODE: "cognito",
          FLARELET_APP_FUNCTION_NAME: Match.anyValue(),
          FLARELET_SESSION_SECRET_ARN: Match.anyValue(),
          FLARELET_COGNITO_DOMAIN: Match.anyValue(),
          FLARELET_COGNITO_CLIENT_ID: Match.anyValue(),
          FLARELET_COGNITO_USER_POOL_ID: Match.anyValue(),
        }),
      },
    });
    const domain = JSON.stringify(
      Object.values(t.findResources("AWS::Lambda::Function")).map((f) => f.Properties.Environment),
    );
    expect(domain).toContain(
      `https://${domainPrefix("myapp", "prod")}.auth.us-east-1.amazoncognito.com`,
    );
  });

  it("timeouts: app < front <= 30s", () => {
    const fns = Object.values(t.findResources("AWS::Lambda::Function")).map(
      (f) => [f.Properties.Handler, f.Properties.Timeout] as [string, number],
    );
    const app = fns.find(([h]) => h === "flarelet-launcher.sh")![1];
    const front = fns.find(([h]) => h === "index.handler")![1];
    expect(app).toBeLessThan(front);
    expect(front).toBeLessThanOrEqual(30);
  });

  it("only the front Lambda may invoke the app Lambda (no API Gateway permission on it)", () => {
    const perms = Object.values(t.findResources("AWS::Lambda::Permission"));
    expect(perms).toHaveLength(1); // API Gateway -> front だけ
    const invoke = stmts(t).filter((s) => [s.Action].flat().includes("lambda:InvokeFunction"));
    expect(invoke).toHaveLength(1);
  });

  it("creates a public PKCE client with callback = API URL + /__flarelet/auth/callback", () => {
    t.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
    t.hasResourceProperties("AWS::Cognito::UserPoolClient", {
      GenerateSecret: false,
      AllowedOAuthFlows: ["code"],
      AllowedOAuthFlowsUserPoolClient: true,
      SupportedIdentityProviders: ["COGNITO"],
      CallbackURLs: [Match.anyValue()],
    });
    const client = Object.values(t.findResources("AWS::Cognito::UserPoolClient"))[0]!;
    expect(JSON.stringify(client.Properties.CallbackURLs)).toContain("/__flarelet/auth/callback");
    t.resourceCountIs("AWS::Cognito::UserPool", 0);
    t.resourceCountIs("AWS::Cognito::ManagedLoginBranding", 1);
  });

  it("has no resource cycle (Api -> Client -> auth Lambda env)", () => {
    expect(findCycle(t.toJSON())).toBeNull();
  });

  it("grants least privilege: only the declared tables, bucket, models and secrets path", () => {
    const all = stmts(t);
    const actions = all.flatMap((s) => [s.Action].flat());
    expect(actions).not.toContain("*");
    expect(actions.some((a) => a.endsWith(":*"))).toBe(false);
    for (const s of all) expect(s.Resource).not.toBe("*");

    const bedrock = all.filter((s) => [s.Action].flat().some((a) => a.startsWith("bedrock:")));
    expect(bedrock).toHaveLength(1);
    expect([bedrock[0]!.Action].flat().sort()).toEqual([
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
    ]);
    const res = JSON.stringify(bedrock[0]!.Resource);
    expect(res).toContain("inference-profile/global.anthropic.claude-sonnet-5-5");
    expect(res).toContain("inference-profile/us.amazon.nova-micro-v1:0");
    expect(res).toContain("foundation-model/anthropic.claude-sonnet-5-5");
    expect(res).toContain("foundation-model/amazon.nova-micro-v1:0");
    expect(res).not.toContain("claude-opus");

    // app: secrets パスの GetParametersByPath、front: セッション世代のパラメータ 1 つの GetParameter だけ
    const ssm = all.filter((s) => [s.Action].flat().some((a) => a.startsWith("ssm:")));
    expect(ssm).toHaveLength(2);
    const byPath = ssm.find((s) => s.Action === "ssm:GetParametersByPath")!;
    expect(JSON.stringify(byPath.Resource)).toContain("parameter/flarelet/myapp/prod/secrets");
    const epoch = ssm.find((s) => s.Action === "ssm:GetParameter")!;
    expect(JSON.stringify(epoch.Resource)).toContain(
      "parameter/flarelet/myapp/prod/auth/session-epoch",
    );
    expect(JSON.stringify(epoch.Resource)).not.toContain("*");

    const kms = all.filter((s) => [s.Action].flat().some((a) => a.startsWith("kms:")));
    expect(kms).toHaveLength(1);
    expect(kms[0]!.Condition).toBeDefined();

    const ddb = all.filter((s) => [s.Action].flat().some((a) => a.startsWith("dynamodb:")));
    expect(ddb.length).toBeGreaterThan(0);
    expect(JSON.stringify(ddb.map((s) => s.Resource))).toContain("Fn::ImportValue");
  });

  it("outputs the API URL", () => {
    t.hasOutput("ApiUrl", {});
  });
});

describe("http.auth: false", () => {
  const { version } = build(
    "version: 1\nname: myapp\nruntime: { language: python }\nhttp: { auth: false }\ndatabase: { main: {} }\n",
    prod,
  );
  const t = Template.fromStack(version);

  it("connects the API directly to the app Lambda with no front Lambda or Cognito client", () => {
    t.resourceCountIs("AWS::Lambda::Function", 1);
    t.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
    t.resourceCountIs("AWS::ApiGatewayV2::Api", 1);
    t.hasResourceProperties("AWS::Lambda::Permission", { Principal: "apigateway.amazonaws.com" });
    t.hasResourceProperties("AWS::Lambda::Function", { Handler: "flarelet-launcher.sh" });
  });

  it("still keeps data in a stage stack", () => {
    const { stage } = build(
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp: { auth: false }\ndatabase: { main: {} }\n",
      prod,
    );
    expect(stage).toBeDefined();
    Template.fromStack(stage!).resourceCountIs("AWS::Cognito::UserPool", 0);
  });
});

describe("PR preview with http.auth: false (Preview Auth is forced)", () => {
  const PUBLIC =
    "version: 1\nname: myapp\nruntime: { language: typescript }\nhttp: { auth: false }\n";
  const { stage, version } = build(PUBLIC, pr);
  const t = Template.fromStack(version);

  it("still puts the front auth Lambda in preview mode in front of the app", () => {
    expect(stage).toBeUndefined();
    t.resourceCountIs("AWS::Cognito::UserPool", 0);
    t.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
    t.resourceCountIs("AWS::Lambda::Function", 2);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          FLARELET_AUTH_MODE: "preview",
          FLARELET_PREVIEW_TOKEN_SECRET_ARN: Match.anyValue(),
          FLARELET_SESSION_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
    t.resourceCountIs("AWS::SecretsManager::Secret", 2);
    t.hasOutput("PreviewTokenSecretArn", {});
    expect(findCycle(t.toJSON())).toBeNull();
  });

  it("routes the API only to the front Lambda (the app is not reachable directly)", () => {
    const perms = Object.values(t.findResources("AWS::Lambda::Permission"));
    expect(perms).toHaveLength(1);
    const fns = t.findResources("AWS::Lambda::Function");
    const frontId = Object.entries(fns).find(
      ([, f]) => (f as { Properties: { Handler: string } }).Properties.Handler === "index.handler",
    )![0];
    expect(JSON.stringify(perms[0])).toContain(frontId);
    const invoke = stmts(t).filter((s) => [s.Action].flat().includes("lambda:InvokeFunction"));
    expect(invoke).toHaveLength(1);
  });

  it("tells the app that identity headers come from the front Lambda", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "flarelet-launcher.sh",
      Timeout: 25,
      Environment: { Variables: Match.objectLike({ FLARELET_AUTH_ENABLED: "true" }) },
    });
  });
});

describe("FLARELET_AUTH_ENABLED (whether a front auth layer strips x-flarelet-* headers)", () => {
  const appEnv = (yaml: string, d: Deployment) =>
    Template.fromStack(build(yaml, d).version).findResources("AWS::Lambda::Function", {
      Properties: { Handler: "flarelet-launcher.sh" },
    });
  const envOf = (r: Record<string, unknown>) =>
    (Object.values(r)[0] as { Properties: { Environment: { Variables: Record<string, string> } } })
      .Properties.Environment.Variables;
  it('is "false" for a public persistent stage and "true" with authentication', () => {
    expect(
      envOf(
        appEnv(
          "version: 1\nname: myapp\nruntime: { language: python }\nhttp: { auth: false }\n",
          prod,
        ),
      ).FLARELET_AUTH_ENABLED,
    ).toBe("false");
    expect(
      envOf(appEnv("version: 1\nname: myapp\nruntime: { language: python }\nhttp: true\n", prod))
        .FLARELET_AUTH_ENABLED,
    ).toBe("true");
  });
});

describe("secret tags (used by the CI role to read only preview tokens)", () => {
  const secretTags = (t: Template) =>
    Object.values(t.findResources("AWS::SecretsManager::Secret")).map((r) =>
      Object.fromEntries(
        (
          (r as { Properties: { Tags?: { Key: string; Value: string }[] } }).Properties.Tags ?? []
        ).map((x) => [x.Key, x.Value]),
      ),
    );
  it("tags PR preview secrets with flarelet:stage=preview and flarelet:lifecycle=ephemeral", () => {
    const tags = secretTags(Template.fromStack(build(FULL, pr).version));
    expect(tags).toHaveLength(2);
    for (const t of tags) {
      expect(t).toMatchObject({ "flarelet:stage": "preview", "flarelet:lifecycle": "ephemeral" });
    }
  });
  it("the persistent stage signing key is tagged with its stage and no ephemeral lifecycle", () => {
    const tags = secretTags(Template.fromStack(build(FULL, prod).stage!));
    expect(tags).toHaveLength(1);
    expect(tags[0]!["flarelet:stage"]).toBe("prod");
    expect(tags[0]!["flarelet:lifecycle"]).toBeUndefined();
  });
});

describe("no http / empty stage", () => {
  it("has no API gateway when http is absent, and no stage stack when it would be empty", () => {
    const { stage, version } = build(
      "version: 1\nname: myapp\nruntime: { language: typescript }\n",
      prod,
    );
    expect(stage).toBeUndefined();
    const t = Template.fromStack(version);
    t.resourceCountIs("AWS::ApiGatewayV2::Api", 0);
    t.resourceCountIs("AWS::Lambda::Function", 1);
    t.hasResourceProperties("AWS::Lambda::Function", { Runtime: "nodejs24.x" });
    expect(version.dependencies).toHaveLength(0);
  });
});

describe("PR preview (ephemeral)", () => {
  const { stage, version } = build(FULL, pr);
  const t = Template.fromStack(version);

  it("is a single self-contained stack", () => {
    expect(stage).toBeUndefined();
    expect(version.stackName).toBe("flarelet-myapp-preview-pr-123");
    expect(version.tags.tagValues()).toMatchObject({
      "flarelet:stage": "preview",
      "flarelet:version": "pr-123",
    });
  });

  it("has data resources that are destroyed with the stack", () => {
    t.resourceCountIs("AWS::DynamoDB::Table", 2);
    t.resourceCountIs("AWS::S3::Bucket", 1);
    t.resourceCountIs("Custom::S3AutoDeleteObjects", 1);
    for (const r of Object.values({
      ...t.findResources("AWS::DynamoDB::Table"),
      ...t.findResources("AWS::S3::Bucket"),
    })) {
      expect(r.DeletionPolicy).toBe("Delete");
    }
  });

  it("uses Preview Auth instead of Cognito", () => {
    t.resourceCountIs("AWS::Cognito::UserPool", 0);
    t.resourceCountIs("AWS::Cognito::UserPoolClient", 0);
    t.hasResourceProperties("AWS::Lambda::Function", {
      Handler: "index.handler",
      Environment: {
        Variables: Match.objectLike({
          FLARELET_AUTH_MODE: "preview",
          FLARELET_PREVIEW_TOKEN_SECRET_ARN: Match.anyValue(),
          FLARELET_SESSION_SECRET_ARN: Match.anyValue(),
        }),
      },
    });
    t.resourceCountIs("AWS::SecretsManager::Secret", 2);
    expect(findCycle(t.toJSON())).toBeNull();
  });

  it("scopes secrets by stage so previews share the preview stage path", () => {
    t.hasResourceProperties("AWS::Lambda::Function", {
      Environment: {
        Variables: Match.objectLike({ FLARELET_SECRETS_PATH: "/flarelet/myapp/preview/secrets/" }),
      },
    });
  });
});

describe("region handling", () => {
  it("fails clearly if an AI model has no profile in the region", () => {
    expect(() => build(FULL, prod, "sa-east-1")).toThrow(/nova-micro.*sa-east-1/);
  });
});
