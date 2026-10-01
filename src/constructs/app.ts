import { App, Aws, CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { join } from "node:path";
import type { Construct } from "constructs";
import type { FlareonIR } from "../ir/index.js";
import type { Deployment } from "../resolver/index.js";
import { bindingEnvName } from "../runtime/env.js";
import { resolveModel, type ResolvedModel } from "./ai-models.js";
import { Data, removalOf, type Lifetime } from "./data.js";
import { LAUNCHER_HANDLER } from "./launcher.js";
import { domainPrefix, secretsPath, stackNames } from "./names.js";
import { appCode, frontAuthCode } from "./packaging.js";

/** Lambda Web Adapter（arm64）。https://github.com/awslabs/aws-lambda-web-adapter#lambda-functions-packaged-as-zip-package-for-aws-managed-runtimes */
export const LWA_ACCOUNT = "753240598075";
export const LWA_LAYER_VERSION = 30;
export const lwaLayerArn = (region: string): string =>
  `arn:aws:lambda:${region}:${LWA_ACCOUNT}:layer:LambdaAdapterLayerArm64:${LWA_LAYER_VERSION}`;

const PYTHON_RUNTIMES: Record<string, lambda.Runtime> = {
  "3.12": lambda.Runtime.PYTHON_3_12,
  "3.13": lambda.Runtime.PYTHON_3_13,
  "3.14": lambda.Runtime.PYTHON_3_14,
};
const NODE_RUNTIMES: Record<string, lambda.Runtime> = {
  "22": lambda.Runtime.NODEJS_22_X,
  "24": lambda.Runtime.NODEJS_24_X,
};

function lambdaRuntime(ir: FlareonIR): lambda.Runtime {
  const table = ir.runtime.language === "python" ? PYTHON_RUNTIMES : NODE_RUNTIMES;
  const rt = table[ir.runtime.version];
  if (!rt) {
    throw new Error(
      `unsupported ${ir.runtime.language} version "${ir.runtime.version}" (supported: ${Object.keys(table).join(", ")})`,
    );
  }
  return rt;
}

const AUTH_CALLBACK_PATH = "/__flareon/auth/callback";

/** stage スコープ（persistent）の認証基盤。Cognito User Pool + ドメイン + Cookie 署名鍵。 */
interface CognitoAuth {
  userPool: cognito.UserPool;
  domainPrefix: string;
  sessionSecret: secretsmanager.Secret;
}

interface StageStackProps extends StackProps {
  ir: FlareonIR;
  deployment: Deployment;
  account: string | undefined;
}

export class StageStack extends Stack {
  readonly data: Data;
  readonly auth: CognitoAuth | undefined;

  constructor(scope: Construct, id: string, props: StageStackProps) {
    super(scope, id, props);
    this.data = new Data(this, "Data", { ir: props.ir, lifetime: "retain" });
    if (props.ir.http?.auth.enabled) {
      const prefix = domainPrefix(props.ir.name, props.deployment.stage, props.account);
      const userPool = new cognito.UserPool(this, "UserPool", {
        featurePlan: cognito.FeaturePlan.ESSENTIALS,
        selfSignUpEnabled: false,
        signInAliases: { email: true },
        standardAttributes: { email: { required: true, mutable: true } },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: removalOf("retain"),
      });
      userPool.addDomain("Domain", {
        cognitoDomain: { domainPrefix: prefix },
        managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
      });
      const sessionSecret = new secretsmanager.Secret(this, "SessionSecret", {
        description: "Flareon auth cookie signing key",
        generateSecretString: { passwordLength: 64, excludePunctuation: true },
        removalPolicy: removalOf("retain"),
      });
      this.auth = { userPool, domainPrefix: prefix, sessionSecret };
    }
  }
}

interface VersionStackProps extends StackProps {
  ir: FlareonIR;
  deployment: Deployment;
  models: ResolvedModel[];
  /** persistent のときの stage スタックのリソース。PR preview では undefined（自前で作る）。 */
  stage: StageStack | undefined;
  code: { app: lambda.Code; front: () => lambda.Code };
}

export class VersionStack extends Stack {
  constructor(scope: Construct, id: string, props: VersionStackProps) {
    super(scope, id, props);
    const { ir, deployment, models } = props;
    const ephemeral = deployment.lifecycle === "ephemeral";
    const lifetime: Lifetime = ephemeral ? "destroy" : "retain";
    const auth = ir.http?.auth.enabled ? ir.http.auth : null;

    // --- data / auth のスコープ解決 ---
    const data = props.stage?.data ?? new Data(this, "Data", { ir, lifetime });
    let sessionSecret: secretsmanager.Secret | undefined = props.stage?.auth?.sessionSecret;
    let previewToken: secretsmanager.Secret | undefined;
    if (ephemeral && auth) {
      sessionSecret = new secretsmanager.Secret(this, "SessionSecret", {
        description: "Flareon preview auth cookie signing key",
        generateSecretString: { passwordLength: 64, excludePunctuation: true },
        removalPolicy: removalOf(lifetime),
      });
      previewToken = new secretsmanager.Secret(this, "PreviewToken", {
        description: "Flareon preview auth magic-link token",
        generateSecretString: { passwordLength: 32, excludePunctuation: true },
        removalPolicy: removalOf(lifetime),
      });
    }

    // --- app Lambda ---
    const path = secretsPath(ir.name, deployment.stage);
    const environment: Record<string, string> = {
      AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
      PORT: "8080",
      FLAREON_APP: ir.name,
      FLAREON_STAGE: deployment.stage,
      FLAREON_VERSION: deployment.version,
    };
    if (ir.secrets.length) environment.FLAREON_SECRETS_PATH = path;
    for (const [name, table] of Object.entries(data.tables)) {
      environment[bindingEnvName("DATABASE", name, "TABLE")] = table.tableName;
    }
    for (const [name, bucket] of Object.entries(data.buckets)) {
      environment[bindingEnvName("STORAGE", name, "BUCKET")] = bucket.bucketName;
    }
    for (const m of models) environment[bindingEnvName("AI", m.name, "MODEL_ID")] = m.profileId;

    const appFn = new lambda.Function(this, "AppFunction", {
      runtime: lambdaRuntime(ir),
      architecture: lambda.Architecture.ARM_64,
      handler: LAUNCHER_HANDLER,
      code: props.code.app,
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, "LambdaWebAdapter", lwaLayerArn(this.region)),
      ],
      memorySize: 512,
      // app < front <= 30s（front がある場合 app のタイムアウトは front が 504 に変換する）
      timeout: Duration.seconds(auth ? 25 : 29),
      environment,
    });

    // --- least privilege bindings ---
    for (const table of Object.values(data.tables)) table.grantReadWriteData(appFn);
    for (const bucket of Object.values(data.buckets)) bucket.grantReadWrite(appFn);
    if (models.length) {
      appFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          resources: models.flatMap((m) => [
            `arn:aws:bedrock:${this.region}:${Aws.ACCOUNT_ID}:inference-profile/${m.profileId}`,
            `arn:aws:bedrock:*::foundation-model/${m.foundationModelId}`,
          ]),
        }),
      );
    }
    if (ir.secrets.length) {
      const base = `arn:aws:ssm:${this.region}:${Aws.ACCOUNT_ID}:parameter${path.replace(/\/$/, "")}`;
      appFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["ssm:GetParametersByPath"],
          resources: [base, `${base}/*`],
        }),
      );
      appFn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["kms:Decrypt"],
          resources: [`arn:aws:kms:${this.region}:${Aws.ACCOUNT_ID}:key/*`],
          conditions: { StringEquals: { "kms:ViaService": `ssm.${this.region}.amazonaws.com` } },
        }),
      );
    }

    if (!ir.http) return;

    // --- HTTP API。Api → Client → front Lambda env の順で非循環に組む ---
    const api = new apigwv2.HttpApi(this, "Api", { description: `Flareon ${ir.name}` });
    let integrationTarget: lambda.IFunction = appFn;

    if (auth) {
      if (!sessionSecret) throw new Error("internal: session secret missing");
      const frontEnv: Record<string, string> = {
        FLAREON_APP_FUNCTION_NAME: appFn.functionName,
        FLAREON_SESSION_SECRET_ARN: sessionSecret.secretArn,
      };
      if (previewToken) {
        frontEnv.FLAREON_AUTH_MODE = "preview";
        frontEnv.FLAREON_PREVIEW_TOKEN_SECRET_ARN = previewToken.secretArn;
      } else {
        const sa = props.stage?.auth;
        if (!sa) throw new Error("internal: stage auth missing");
        const client = new cognito.UserPoolClient(this, "Client", {
          userPool: sa.userPool,
          generateSecret: false,
          preventUserExistenceErrors: true,
          supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
          oAuth: {
            flows: { authorizationCodeGrant: true },
            scopes: [
              cognito.OAuthScope.OPENID,
              cognito.OAuthScope.EMAIL,
              cognito.OAuthScope.PROFILE,
            ],
            callbackUrls: [`${api.apiEndpoint}${AUTH_CALLBACK_PATH}`],
            logoutUrls: [`${api.apiEndpoint}/`],
          },
        });
        new cognito.CfnManagedLoginBranding(this, "Branding", {
          userPoolId: sa.userPool.userPoolId,
          clientId: client.userPoolClientId,
          useCognitoProvidedValues: true,
        });
        frontEnv.FLAREON_AUTH_MODE = "cognito";
        frontEnv.FLAREON_COGNITO_DOMAIN = `https://${sa.domainPrefix}.auth.${this.region}.amazoncognito.com`;
        frontEnv.FLAREON_COGNITO_CLIENT_ID = client.userPoolClientId;
        frontEnv.FLAREON_COGNITO_USER_POOL_ID = sa.userPool.userPoolId;
      }

      const frontFn = new lambda.Function(this, "FrontAuthFunction", {
        runtime: lambda.Runtime.NODEJS_24_X,
        architecture: lambda.Architecture.ARM_64,
        handler: "index.handler",
        code: props.code.front(),
        memorySize: 256,
        timeout: Duration.seconds(29),
        environment: frontEnv,
      });
      appFn.grantInvoke(frontFn);
      sessionSecret.grantRead(frontFn);
      previewToken?.grantRead(frontFn);
      integrationTarget = frontFn;

      if (previewToken) {
        new CfnOutput(this, "PreviewTokenSecretArn", { value: previewToken.secretArn });
      }
    }

    new apigwv2.HttpRoute(this, "DefaultRoute", {
      httpApi: api,
      routeKey: apigwv2.HttpRouteKey.DEFAULT,
      integration: new HttpLambdaIntegration("Backend", integrationTarget),
    });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
  }
}

export interface BuildOptions {
  ir: FlareonIR;
  deployment: Deployment;
  region: string;
  account?: string;
  outdir?: string;
  /** アプリのディレクトリ（`app/` の親）。code.app を注入しない場合に必要。 */
  appDir?: string;
  /** バンドルの中間生成物置き場（既定: <appDir>/.flareon/cache）。 */
  cacheDir?: string;
  /** Docker/esbuild/pip を使わずソースを詰める（テスト/E2E 用）。 */
  skipBundling?: boolean;
  /** アセットの注入（unit テスト用）。 */
  code?: { app?: lambda.Code; front?: lambda.Code };
}

export interface BuiltApp {
  app: App;
  stage: StageStack | undefined;
  version: VersionStack;
}

export function buildApp(o: BuildOptions): BuiltApp {
  const { ir, deployment } = o;
  const models = ir.aiModels.map((m) => resolveModel(m, o.region));
  const names = stackNames(ir.name, deployment);

  const app = new App({
    ...(o.outdir ? { outdir: o.outdir } : {}),
    analyticsReporting: false,
  });
  const env = { region: o.region, ...(o.account ? { account: o.account } : {}) };
  const baseTags = { "flareon:app": ir.name, "flareon:stage": deployment.stage };

  const stageNeeded =
    ir.databases.length + ir.storages.length > 0 || Boolean(ir.http?.auth.enabled);
  let stage: StageStack | undefined;
  if (names.stage !== undefined && stageNeeded) {
    stage = new StageStack(app, names.stage, {
      stackName: names.stage,
      env,
      tags: baseTags,
      ir,
      deployment,
      account: o.account,
    });
  }

  const cacheDir = (what: string): string => {
    if (o.cacheDir) return o.cacheDir;
    if (o.appDir) return join(o.appDir, ".flareon", "cache");
    throw new Error(`internal: appDir is required to package the ${what}`);
  };
  const appCodeValue =
    o.code?.app ??
    appCode({
      appDir: join(o.appDir ?? cacheDir("app"), "app"),
      language: ir.runtime.language,
      runtimeVersion: ir.runtime.version,
      cacheDir: cacheDir("app"),
      skipBundling: o.skipBundling ?? false,
    });

  const version = new VersionStack(app, names.version, {
    stackName: names.version,
    env,
    tags: { ...baseTags, "flareon:version": deployment.version },
    ir,
    deployment,
    models,
    stage,
    code: {
      app: appCodeValue,
      front: () => o.code?.front ?? frontAuthCode(cacheDir("front auth Lambda")),
    },
  });
  if (stage) version.addStackDependency(stage);
  return { app, stage, version };
}
