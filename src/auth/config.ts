import { IDP_KINDS, type AllowPolicy, type IdpKind } from "./allow.js";
import type { AuthMode } from "./types.js";

interface Base {
  mode: AuthMode;
  appFunctionName: string;
  sessionSecretArn: string;
}

export interface CognitoConfig extends Base {
  mode: "cognito";
  cognito: {
    domain: string;
    clientId: string;
    userPoolId: string;
    /** 外部 IdP（Google / OIDC）を使う場合の Cognito 上の IdP 名。Managed Login の選択画面を飛ばす。 */
    identityProvider?: string;
    /** User Pool のサインイン方法（allow の判定方法が変わる）。 */
    provider: IdpKind;
    /** http.auth.allow。未指定なら IdP で認証できた人は誰でも可。 */
    allow?: AllowPolicy;
  };
}

export interface PreviewConfig extends Base {
  mode: "preview";
  previewTokenSecretArn: string;
}

export type AuthConfig = CognitoConfig | PreviewConfig;

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const v = env[name];
  if (v === undefined || v === "") throw new Error(`${name} is required`);
  return v;
}

const list = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);

function parseProvider(v: string | undefined): IdpKind {
  if (v === undefined || v === "") return "cognito";
  if (!(IDP_KINDS as readonly string[]).includes(v)) {
    throw new Error(
      `FLAREON_AUTH_PROVIDER must be one of ${IDP_KINDS.join(", ")} (got ${JSON.stringify(v)})`,
    );
  }
  return v as IdpKind;
}

/** front auth Lambda の環境変数契約（DECISIONS.md）をパースする。 */
export function parseAuthConfig(env: Env): AuthConfig {
  const mode = env["FLAREON_AUTH_MODE"];
  if (mode !== "cognito" && mode !== "preview") {
    throw new Error(
      `FLAREON_AUTH_MODE must be "cognito" or "preview" (got ${JSON.stringify(mode)})`,
    );
  }
  const base = {
    appFunctionName: required(env, "FLAREON_APP_FUNCTION_NAME"),
    sessionSecretArn: required(env, "FLAREON_SESSION_SECRET_ARN"),
  };
  if (mode === "preview") {
    return {
      mode,
      ...base,
      previewTokenSecretArn: required(env, "FLAREON_PREVIEW_TOKEN_SECRET_ARN"),
    };
  }
  const domains = list(env["FLAREON_AUTH_ALLOW_DOMAINS"]);
  const emails = list(env["FLAREON_AUTH_ALLOW_EMAILS"]);
  return {
    mode,
    ...base,
    cognito: {
      provider: parseProvider(env["FLAREON_AUTH_PROVIDER"]),
      ...(domains.length || emails.length ? { allow: { domains, emails } } : {}),
      domain: required(env, "FLAREON_COGNITO_DOMAIN").replace(/\/+$/, ""),
      clientId: required(env, "FLAREON_COGNITO_CLIENT_ID"),
      userPoolId: required(env, "FLAREON_COGNITO_USER_POOL_ID"),
      ...(env["FLAREON_COGNITO_IDENTITY_PROVIDER"]
        ? { identityProvider: env["FLAREON_COGNITO_IDENTITY_PROVIDER"] }
        : {}),
    },
  };
}
