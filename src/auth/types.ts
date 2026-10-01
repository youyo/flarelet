import type { JWTVerifyGetKey } from "jose";

/** API Gateway HTTP API payload v2 のうち front auth が使う部分。 */
export interface ApiEvent {
  version?: string;
  routeKey?: string;
  rawPath: string;
  rawQueryString: string;
  cookies?: string[];
  headers: Record<string, string | undefined>;
  queryStringParameters?: Record<string, string | undefined>;
  requestContext: {
    domainName?: string;
    http: { method: string; path?: string; [k: string]: unknown };
    [k: string]: unknown;
  };
  body?: string;
  isBase64Encoded: boolean;
  [k: string]: unknown;
}

/** HTTP API payload v2 のレスポンス。 */
export interface ApiResult {
  statusCode: number;
  headers?: Record<string, string>;
  multiValueHeaders?: Record<string, string[]>;
  cookies?: string[];
  body?: string;
  isBase64Encoded?: boolean;
}

export interface Identity {
  sub: string;
  email?: string;
}

export type AuthMode = "cognito" | "preview";

export interface InvokeResult {
  functionError?: string;
  payload: string;
}

/** 外部 I/O（テストで差し替える）。 */
export interface AuthDeps {
  /** 現在時刻（ミリ秒）。 */
  now(): number;
  getSecret(arn: string): Promise<string>;
  /** app Lambda を RequestResponse で同期 Invoke する。 */
  invoke(functionName: string, payload: string): Promise<InvokeResult>;
  fetch: typeof fetch;
  /** id_token 検証用の鍵取得。未指定なら Cognito の JWKS を使う。 */
  getVerificationKey?: JWTVerifyGetKey;
}
