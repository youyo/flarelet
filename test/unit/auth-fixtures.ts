import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AuthDeps, ApiEvent, ApiResult } from "../../src/auth/types.js";

export const NOW = Date.UTC(2026, 0, 1, 0, 0, 0);
export const SESSION_KEY = "test-session-secret";
export const PREVIEW_TOKEN = "preview-token-123";
export const POOL_ID = "ap-northeast-1_AbCdEf";
export const CLIENT_ID = "client123";
export const COGNITO_DOMAIN = "https://myapp-prod-abc.auth.ap-northeast-1.amazoncognito.com";
export const ISSUER = `https://cognito-idp.ap-northeast-1.amazonaws.com/${POOL_ID}`;

export const COGNITO_ENV = {
  FLAREON_AUTH_MODE: "cognito",
  FLAREON_APP_FUNCTION_NAME: "app-fn",
  FLAREON_SESSION_SECRET_ARN: "arn:session",
  FLAREON_COGNITO_DOMAIN: COGNITO_DOMAIN,
  FLAREON_COGNITO_CLIENT_ID: CLIENT_ID,
  FLAREON_COGNITO_USER_POOL_ID: POOL_ID,
};

export const PREVIEW_ENV = {
  FLAREON_AUTH_MODE: "preview",
  FLAREON_APP_FUNCTION_NAME: "app-fn",
  FLAREON_SESSION_SECRET_ARN: "arn:session",
  FLAREON_PREVIEW_TOKEN_SECRET_ARN: "arn:preview",
};

export function makeEvent(over: Partial<ApiEvent> & { method?: string } = {}): ApiEvent {
  const { method, ...rest } = over;
  return {
    version: "2.0",
    routeKey: "$default",
    rawPath: "/",
    rawQueryString: "",
    headers: { host: "abc.execute-api.ap-northeast-1.amazonaws.com" },
    requestContext: {
      domainName: "abc.execute-api.ap-northeast-1.amazonaws.com",
      http: { method: method ?? "GET", path: rest.rawPath ?? "/" },
    },
    isBase64Encoded: false,
    ...rest,
  } as ApiEvent;
}

export interface FakeDeps extends AuthDeps {
  invocations: { functionName: string; payload: string }[];
  fetchCalls: { url: string; init: RequestInit | undefined }[];
  secretCalls: string[];
  setInvoke(fn: AuthDeps["invoke"]): void;
  setFetch(fn: typeof fetch): void;
}

export async function makeDeps(opts: { now?: number } = {}): Promise<
  FakeDeps & {
    signIdToken(
      claims: Record<string, unknown>,
      o?: { aud?: string; iss?: string; exp?: number },
    ): Promise<string>;
  }
> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  await exportJWK(publicKey);
  const secrets: Record<string, string> = {
    "arn:session": SESSION_KEY,
    "arn:preview": PREVIEW_TOKEN,
  };
  let invokeImpl: AuthDeps["invoke"] = async () => ({
    payload: JSON.stringify({ statusCode: 200, body: "ok" } satisfies ApiResult),
  });
  let fetchImpl: typeof fetch = async () => {
    throw new Error("fetch not stubbed");
  };
  const d = {
    invocations: [] as FakeDeps["invocations"],
    fetchCalls: [] as FakeDeps["fetchCalls"],
    secretCalls: [] as string[],
    now: () => opts.now ?? NOW,
    getSecret: async (arn: string) => {
      d.secretCalls.push(arn);
      const v = secrets[arn];
      if (v === undefined) throw new Error(`no secret ${arn}`);
      return v;
    },
    invoke: async (functionName: string, payload: string) => {
      d.invocations.push({ functionName, payload });
      return invokeImpl(functionName, payload);
    },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      d.fetchCalls.push({ url: String(url), init });
      return fetchImpl(url, init);
    }) as typeof fetch,
    getVerificationKey: async () => publicKey,
    setInvoke(fn: AuthDeps["invoke"]) {
      invokeImpl = fn;
    },
    setFetch(fn: typeof fetch) {
      fetchImpl = fn;
    },
    async signIdToken(
      claims: Record<string, unknown>,
      o: { aud?: string; iss?: string; exp?: number } = {},
    ) {
      return new SignJWT({ token_use: "id", ...claims })
        .setProtectedHeader({ alg: "RS256" })
        .setIssuer(o.iss ?? ISSUER)
        .setAudience(o.aud ?? CLIENT_ID)
        .setIssuedAt(Math.floor(NOW / 1000))
        .setExpirationTime(o.exp ?? Math.floor(NOW / 1000) + 3600)
        .sign(privateKey);
    },
  };
  return d;
}

export function cookieValue(setCookies: string[] | undefined, name: string): string | undefined {
  for (const c of setCookies ?? []) {
    if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(";")[0];
  }
  return undefined;
}
