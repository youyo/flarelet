import { createHash, timingSafeEqual } from "node:crypto";
import type { PreviewConfig } from "./config.js";
import { escapeHtml, html, json, redirect } from "./responses.js";
import { clearSessionCookie, issueSessionCookie } from "./session.js";
import type { ApiEvent, ApiResult, AuthDeps } from "./types.js";

export const PREVIEW_PATH = "/__flareon/auth/preview";
export const PREVIEW_IDENTITY = { sub: "preview" } as const;

export interface PreviewContext {
  config: PreviewConfig;
  sessionKey: string;
  deps: AuthDeps;
}

function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** トークン入力フォーム。 */
export function previewFormPage(error?: string): ApiResult {
  const msg = error ? `<p style="color:#b00020">${escapeHtml(error)}</p>` : "";
  return html(
    401,
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Preview access</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:24rem;margin:4rem auto;padding:0 1rem">` +
      `<h1>Preview access</h1>${msg}` +
      `<form method="post" action="${PREVIEW_PATH}">` +
      `<label>Access token<br><input type="password" name="token" autocomplete="off" required style="width:100%"></label>` +
      `<p><button type="submit">Continue</button></p></form></body></html>`,
  );
}

function bodyToken(event: ApiEvent): string | undefined {
  if (!event.body) return undefined;
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  return new URLSearchParams(raw).get("token") ?? undefined;
}

/** /__flareon/auth/preview（GET ?token= / POST form）。 */
export async function previewLogin(event: ApiEvent, ctx: PreviewContext): Promise<ApiResult> {
  const method = event.requestContext.http.method.toUpperCase();
  let token: string | undefined;
  if (method === "POST") token = bodyToken(event);
  else if (method === "GET")
    token = new URLSearchParams(event.rawQueryString).get("token") ?? undefined;
  else return json(405, { error: "method_not_allowed" });

  if (token === undefined || token === "") return previewFormPage();
  const expected = await ctx.deps.getSecret(ctx.config.previewTokenSecretArn);
  if (!safeEqual(token, expected.trim())) return previewFormPage("Invalid token.");
  return redirect("/", [
    issueSessionCookie(PREVIEW_IDENTITY, "preview", ctx.sessionKey, ctx.deps.now()),
  ]);
}

export function previewLogout(): ApiResult {
  return redirect("/", [clearSessionCookie()]);
}
