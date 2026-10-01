import type { ApiEvent, ApiResult, AuthDeps, AuthMode, Identity } from "./types.js";
import { json } from "./responses.js";
import { SESSION_COOKIE } from "./session.js";

const PREFIX = "x-flareon-";

function isTimeoutError(e: unknown): boolean {
  const name = e instanceof Error ? e.name : "";
  return /timeout|timedout/i.test(name) || (e instanceof Error && /timed? ?out/i.test(e.message));
}

function stripSession(cookies: string[]): string[] {
  return cookies.filter((c) => !c.trim().startsWith(`${SESSION_COOKIE}=`));
}

/** x-flareon-* の除去と identity ヘッダの付与を行った v2 イベントを作る。 */
export function buildAppEvent(event: ApiEvent, identity: Identity, mode: AuthMode): ApiEvent {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers)) {
    if (k.toLowerCase().startsWith(PREFIX)) continue;
    headers[k] = v;
  }
  if (headers["cookie"] !== undefined) {
    const rest = headers["cookie"]
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "" && !s.startsWith(`${SESSION_COOKIE}=`));
    if (rest.length) headers["cookie"] = rest.join("; ");
    else delete headers["cookie"];
  }
  headers["x-flareon-user-sub"] = identity.sub;
  if (identity.email !== undefined) headers["x-flareon-user-email"] = identity.email;
  headers["x-flareon-auth-mode"] = mode;
  const out: ApiEvent = { ...event, headers };
  if (event.cookies) out.cookies = stripSession(event.cookies);
  return out;
}

function isApiResult(v: unknown): v is ApiResult {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { statusCode?: unknown }).statusCode === "number"
  );
}

/** app Lambda を同期 Invoke し、v2 レスポンスをそのまま返す。失敗は 502 / 504。 */
export async function invokeApp(
  event: ApiEvent,
  identity: Identity,
  mode: AuthMode,
  ctx: { appFunctionName: string; deps: AuthDeps },
): Promise<ApiResult> {
  const payload = JSON.stringify(buildAppEvent(event, identity, mode));
  let result;
  try {
    result = await ctx.deps.invoke(ctx.appFunctionName, payload);
  } catch (e) {
    return isTimeoutError(e)
      ? json(504, { error: "gateway_timeout" })
      : json(502, { error: "bad_gateway" });
  }
  if (result.functionError !== undefined) {
    return /task timed out/i.test(result.payload)
      ? json(504, { error: "gateway_timeout" })
      : json(502, { error: "bad_gateway" });
  }
  try {
    const parsed: unknown = JSON.parse(result.payload);
    if (isApiResult(parsed)) return parsed;
  } catch {
    // fallthrough
  }
  return json(502, { error: "bad_gateway" });
}
