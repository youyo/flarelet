import { policyFingerprint } from "./allow.js";
import { cognitoCallback, cognitoLogin, cognitoLogout } from "./cognito.js";
import { parseAuthConfig } from "./config.js";
import { previewFormPage, previewLogin, previewLogout, PREVIEW_PATH } from "./preview.js";
import { invokeApp } from "./proxy.js";
import { isBrowserNavigation, json, redirect, unauthorized } from "./responses.js";
import { readSession } from "./session.js";
import type { ApiEvent, ApiResult, AuthDeps } from "./types.js";

const AUTH_PREFIX = "/__flarelet/auth/";

/** セッション世代のキャッシュ時間。失効（revoke-sessions）の反映はこの時間だけ遅れる。 */
export const EPOCH_TTL_MS = 60_000;

/** SSM パラメータのバージョンを TTL 付きでキャッシュする（失敗はキャッシュしない）。 */
function epochReader(deps: AuthDeps, name: string): () => Promise<number> {
  let cached: { value: number; at: number } | undefined;
  return async () => {
    const now = deps.now();
    if (cached && now - cached.at < EPOCH_TTL_MS) return cached.value;
    const value = await deps.getParameterVersion(name);
    cached = { value, at: now };
    return value;
  };
}

/** secret を取得後キャッシュする getSecret ラッパ（失敗はキャッシュしない）。 */
function cached(deps: AuthDeps): AuthDeps {
  const cache = new Map<string, Promise<string>>();
  return {
    ...deps,
    getSecret(arn) {
      let p = cache.get(arn);
      if (!p) {
        p = deps.getSecret(arn);
        cache.set(arn, p);
        p.catch(() => cache.delete(arn));
      }
      return p;
    },
  };
}

/** 設定をパースし（不備なら即例外）、イベントハンドラを作る。 */
export function createHandler(
  env: Record<string, string | undefined>,
  rawDeps: AuthDeps,
): (event: ApiEvent) => Promise<ApiResult> {
  const config = parseAuthConfig(env);
  const deps = cached(rawDeps);
  const epoch = epochReader(deps, config.sessionEpochParam);
  const policy =
    config.mode === "cognito"
      ? policyFingerprint(config.cognito.provider, config.cognito.allow)
      : undefined;

  return async (event) => {
    const sessionKey = await deps.getSecret(config.sessionSecretArn);
    const path = event.rawPath;

    if (path.startsWith(AUTH_PREFIX)) {
      if (config.mode === "cognito") {
        const ctx = { config, sessionKey, deps, epoch };
        if (path === "/__flarelet/auth/login") return cognitoLogin(event, ctx);
        if (path === "/__flarelet/auth/callback") return cognitoCallback(event, ctx);
        if (path === "/__flarelet/auth/logout") return cognitoLogout(event, ctx);
      } else {
        if (path === PREVIEW_PATH) return previewLogin(event, { config, sessionKey, deps, epoch });
        if (path === "/__flarelet/auth/logout") return previewLogout();
      }
      return json(404, { error: "not_found" });
    }

    let current: number;
    try {
      current = await epoch();
    } catch {
      // 失効の確認ができないときは通さない（fail closed）
      return json(503, { error: "session_epoch_unavailable" });
    }
    const identity = readSession(event, sessionKey, config.mode, deps.now(), policy, current);
    if (!identity) {
      if (config.mode === "preview") {
        return isBrowserNavigation(event) ? previewFormPage() : unauthorized();
      }
      if (isBrowserNavigation(event)) {
        const rt = event.rawQueryString ? `${path}?${event.rawQueryString}` : path;
        return redirect(`/__flarelet/auth/login?return_to=${encodeURIComponent(rt)}`);
      }
      return unauthorized();
    }
    return invokeApp(event, identity, config.mode, {
      appFunctionName: config.appFunctionName,
      deps,
    });
  };
}
