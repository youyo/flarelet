import type { AuthMode } from "./types.js";

interface Base {
  mode: AuthMode;
  appFunctionName: string;
  sessionSecretArn: string;
}

export interface CognitoConfig extends Base {
  mode: "cognito";
  cognito: { domain: string; clientId: string; userPoolId: string };
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
  return {
    mode,
    ...base,
    cognito: {
      domain: required(env, "FLAREON_COGNITO_DOMAIN").replace(/\/+$/, ""),
      clientId: required(env, "FLAREON_COGNITO_CLIENT_ID"),
      userPoolId: required(env, "FLAREON_COGNITO_USER_POOL_ID"),
    },
  };
}
