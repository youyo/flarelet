import { cognitoCallback, cognitoLogin, cognitoLogout } from "./cognito.js";
import { parseAuthConfig } from "./config.js";
import { previewFormPage, previewLogin, previewLogout, PREVIEW_PATH } from "./preview.js";
import { invokeApp } from "./proxy.js";
import { isBrowserNavigation, json, redirect, unauthorized } from "./responses.js";
import { readSession } from "./session.js";
import type { ApiEvent, ApiResult, AuthDeps } from "./types.js";

const AUTH_PREFIX = "/__flareon/auth/";

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

  return async (event) => {
    const sessionKey = await deps.getSecret(config.sessionSecretArn);
    const path = event.rawPath;

    if (path.startsWith(AUTH_PREFIX)) {
      if (config.mode === "cognito") {
        const ctx = { config, sessionKey, deps };
        if (path === "/__flareon/auth/login") return cognitoLogin(event, ctx);
        if (path === "/__flareon/auth/callback") return cognitoCallback(event, ctx);
        if (path === "/__flareon/auth/logout") return cognitoLogout(event, ctx);
      } else {
        if (path === PREVIEW_PATH) return previewLogin(event, { config, sessionKey, deps });
        if (path === "/__flareon/auth/logout") return previewLogout();
      }
      return json(404, { error: "not_found" });
    }

    const identity = readSession(event, sessionKey, config.mode, deps.now());
    if (!identity) {
      if (config.mode === "preview") {
        return isBrowserNavigation(event) ? previewFormPage() : unauthorized();
      }
      if (isBrowserNavigation(event)) {
        const rt = event.rawQueryString ? `${path}?${event.rawQueryString}` : path;
        return redirect(`/__flareon/auth/login?return_to=${encodeURIComponent(rt)}`);
      }
      return unauthorized();
    }
    return invokeApp(event, identity, config.mode, {
      appFunctionName: config.appFunctionName,
      deps,
    });
  };
}
