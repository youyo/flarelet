import {
  App,
  Aws,
  CfnOutput,
  Duration,
  RemovalPolicy,
  SecretValue,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { join } from "node:path";
import type { Construct } from "constructs";
import { idpSecretNames } from "../config/names.js";
import type { FlareonIR } from "../ir/index.js";
import type { Deployment } from "../resolver/index.js";
import { bindingEnvName } from "../runtime/env.js";
import { resolveModel, type ResolvedModel } from "./ai-models.js";
import { Data, removalOf, type Lifetime } from "./data.js";
import { LAUNCHER_HANDLER } from "./launcher.js";
import { domainPrefix, idpSecretName, secretsPath, stackNames } from "./names.js";
import { appCode, frontAuthCode } from "./packaging.js";
import { HD_CLAIM } from "../auth/allow.js";

/** Entra ID の Cognito 上の IdP 名（Managed Login のボタン表示）。 */
export const ENTRA_IDP_NAME = "EntraID";

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

/** Lambda のロググループ。スタックと一緒に消えるよう明示的に作る（自動作成だとスタック外に残る）。 */
function functionLogGroup(scope: Construct, id: string): logs.LogGroup {
  return new logs.LogGroup(scope, id, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
  });
}

/**
 * ロググループへの書き込みだけを許可した実行ロール。AWSLambdaBasicExecutionRole（logs:CreateLogGroup on *）を
 * 使うと、destroy でロググループを消した直後に Lambda が保留中のログを配信してロググループを作り直し、残ってしまう。
 */
function functionRole(scope: Construct, id: string, logGroup: logs.LogGroup): iam.Role {
  const role = new iam.Role(scope, id, {
    assumedBy: new iam.ServicePrincipal("lambda.amazonaws.com"),
  });
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["logs:CreateLogStream", "logs:PutLogEvents"],
      resources: [logGroup.logGroupArn],
    }),
  );
  return role;
}

/** CloudFormation のタグ値に使えない文字を `-` にする。 */
export const tagValue = (v: string): string =>
  v.replace(/[^\p{L}\p{N}\s_.:/=+\-@]/gu, "-").slice(0, 256);

const AUTH_CALLBACK_PATH = "/__flareon/auth/callback";

/** stage スコープ（persistent）の認証基盤。Cognito User Pool + ドメイン + Cookie 署名鍵。 */
interface CognitoAuth {
  userPool: cognito.UserPool;
  domainPrefix: string;
  sessionSecret: secretsmanager.Secret;
  /** 外部 IdP（Google / OIDC）。app client の SupportedIdentityProviders に使う。 */
  identityProvider: { name: string; resource: cognito.IUserPoolIdentityProvider } | undefined;
}

interface StageStackProps extends StackProps {
  ir: FlareonIR;
  deployment: Deployment;
  account: string | undefined;
  /** 外部 IdP の資格情報シークレットのバージョン ID（名前 → VersionId）。分かれば固定する。 */
  idpSecretVersions: Record<string, string> | undefined;
}

/**
 * 外部 IdP を stage の User Pool に追加する。client id / secret は Secrets Manager の動的参照で渡す
 * （ssm-secure は Cognito IdP では使えない）。値はテンプレートに入らない。
 * バージョン ID を固定すると、シークレットを更新したときにテンプレートが変わり IdP が更新される。
 */
function addIdentityProvider(
  scope: Construct,
  userPool: cognito.UserPool,
  props: StageStackProps,
): CognitoAuth["identityProvider"] {
  const auth = props.ir.http?.auth;
  if (!auth?.enabled || auth.provider === "cognito") return undefined;
  const [idName, secretName] = idpSecretNames(auth.provider) as [string, string];
  const ref = (name: string): SecretValue => {
    const versionId = props.idpSecretVersions?.[name];
    return SecretValue.secretsManager(idpSecretName(props.ir.name, props.deployment.stage, name), {
      ...(versionId ? { versionId } : {}),
    });
  };
  if (auth.provider === "google") {
    const resource = new cognito.UserPoolIdentityProviderGoogle(scope, "IdentityProvider", {
      userPool,
      clientId: ref(idName).unsafeUnwrap(),
      clientSecretValue: ref(secretName),
      scopes: ["openid", "email", "profile"],
      attributeMapping: {
        email: cognito.ProviderAttribute.GOOGLE_EMAIL,
        emailVerified: cognito.ProviderAttribute.GOOGLE_EMAIL_VERIFIED,
        // Google Workspace の hosted domain。allow.domains の判定に使う（個人アカウントには無い）
        custom: { [HD_CLAIM]: cognito.ProviderAttribute.other("hd") },
      },
    });
    // providerName はトークン（Ref）になりクロススタック Export を生むので、固定名を使う
    return { name: "Google", resource };
  }
  if (auth.provider === "entra") {
    // Entra ID はシングルテナントの OIDC として扱う。issuer はテナント ID（GUID）形式（スキーマで検証済み）。
    // Entra の id_token は email_verified を出さないのでマッピングしない。email が無い場合に備え preferred_username も取る
    const resource = new cognito.UserPoolIdentityProviderOidc(scope, "IdentityProvider", {
      userPool,
      name: ENTRA_IDP_NAME,
      issuerUrl: `https://login.microsoftonline.com/${auth.entra.tenant}/v2.0`,
      clientId: ref(idName).unsafeUnwrap(),
      clientSecret: ref(secretName).unsafeUnwrap(),
      scopes: ["openid", "email", "profile"],
      attributeRequestMethod: cognito.OidcAttributeRequestMethod.GET,
      attributeMapping: {
        email: cognito.ProviderAttribute.other("email"),
        preferredUsername: cognito.ProviderAttribute.other("preferred_username"),
      },
    });
    return { name: ENTRA_IDP_NAME, resource };
  }
  const resource = new cognito.UserPoolIdentityProviderOidc(scope, "IdentityProvider", {
    userPool,
    name: auth.oidc.name,
    issuerUrl: auth.oidc.issuer,
    clientId: ref(idName).unsafeUnwrap(),
    // 動的参照の文字列（`{{resolve:secretsmanager:...}}`）。値そのものではない
    clientSecret: ref(secretName).unsafeUnwrap(),
    scopes: auth.oidc.scopes,
    attributeRequestMethod: cognito.OidcAttributeRequestMethod.GET,
    attributeMapping: {
      email: cognito.ProviderAttribute.other("email"),
      emailVerified: cognito.ProviderAttribute.other("email_verified"),
    },
  });
  return { name: auth.oidc.name, resource };
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
        // google のときだけ Workspace の hd を入れるカスタム属性を持つ。カスタム属性は追加はできるが変更・削除できない。
        // スキーマへの追加は更新（置換なし）で反映される（DECISIONS.md）。allow の有無に関わらず付けて、後から変えない
        ...(props.ir.http.auth.enabled && props.ir.http.auth.provider === "google"
          ? { customAttributes: { hd: new cognito.StringAttribute({ mutable: true }) } }
          : {}),
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
      const identityProvider = addIdentityProvider(this, userPool, props);
      this.auth = { userPool, domainPrefix: prefix, sessionSecret, identityProvider };
      new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
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

    const appLogs = functionLogGroup(this, "AppLogs");
    const appFn = new lambda.Function(this, "AppFunction", {
      logGroup: appLogs,
      role: functionRole(this, "AppRole", appLogs),
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

    new CfnOutput(this, "AppFunctionName", { value: appFn.functionName });
    new CfnOutput(this, "AppLogGroup", { value: appLogs.logGroupName });

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
        const google = auth.provider === "google";
        const client = new cognito.UserPoolClient(this, "Client", {
          userPool: sa.userPool,
          // カスタム属性は既定では読めない／書けない。マッピングする属性は書き込み可能でなければならない
          // （email_verified はクライアントの書き込み属性に指定できない）
          ...(google
            ? {
                readAttributes: new cognito.ClientAttributes()
                  .withStandardAttributes({ email: true, emailVerified: true })
                  .withCustomAttributes("hd"),
                writeAttributes: new cognito.ClientAttributes()
                  .withStandardAttributes({ email: true })
                  .withCustomAttributes("hd"),
              }
            : {}),
          generateSecret: false,
          preventUserExistenceErrors: true,
          supportedIdentityProviders: [
            sa.identityProvider
              ? cognito.UserPoolClientIdentityProvider.custom(sa.identityProvider.name)
              : cognito.UserPoolClientIdentityProvider.COGNITO,
          ],
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
        frontEnv.FLAREON_AUTH_PROVIDER = auth.provider;
        if (auth.allow?.domains.length) {
          frontEnv.FLAREON_AUTH_ALLOW_DOMAINS = auth.allow.domains.join(",");
        }
        if (auth.allow?.emails.length)
          frontEnv.FLAREON_AUTH_ALLOW_EMAILS = auth.allow.emails.join(",");
        if (sa.identityProvider) {
          // IdP が先に存在しないと client の作成が失敗する（stage → version のスタック依存で保証）
          client.node.addDependency(sa.identityProvider.resource);
          frontEnv.FLAREON_COGNITO_IDENTITY_PROVIDER = sa.identityProvider.name;
        }
      }

      const frontLogs = functionLogGroup(this, "FrontLogs");
      const frontFn = new lambda.Function(this, "FrontAuthFunction", {
        logGroup: frontLogs,
        role: functionRole(this, "FrontRole", frontLogs),
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

      new CfnOutput(this, "FrontLogGroup", { value: frontLogs.logGroupName });
      if (previewToken) {
        new CfnOutput(this, "PreviewTokenSecretArn", { value: previewToken.secretArn });
      }
      if (props.stage?.auth) {
        new CfnOutput(this, "UserPoolId", { value: props.stage.auth.userPool.userPoolId });
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
  /** デプロイ元の Git ブランチ（version スタックの `flareon:branch` タグ。env list の表示用）。 */
  source?: string;
  /** 外部 IdP の資格情報シークレットのバージョン ID（deploy 時に AWS から取得）。 */
  idpSecretVersions?: Record<string, string>;
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
    // CDK CLI が通常付与するコンテキスト。プログラムから synth すると既定で無効なため明示する
    // （plan の差分と deploy の進捗を Flareon の概念に対応付けるのに使う）。
    context: { "aws:cdk:enable-path-metadata": true },
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
      idpSecretVersions: o.idpSecretVersions,
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
    tags: {
      ...baseTags,
      "flareon:version": deployment.version,
      "flareon:lifecycle": deployment.lifecycle,
      ...(o.source ? { "flareon:branch": tagValue(o.source) } : {}),
    },
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
