import type { ApiEvent, ApiResult } from "./types.js";

export function json(statusCode: number, body: unknown, cookies?: string[]): ApiResult {
  const r: ApiResult = {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
  if (cookies?.length) r.cookies = cookies;
  return r;
}

export function html(statusCode: number, body: string, cookies?: string[]): ApiResult {
  const r: ApiResult = {
    statusCode,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body,
  };
  if (cookies?.length) r.cookies = cookies;
  return r;
}

export function redirect(location: string, cookies?: string[]): ApiResult {
  const r: ApiResult = { statusCode: 302, headers: { location, "cache-control": "no-store" } };
  if (cookies?.length) r.cookies = cookies;
  return r;
}

export function unauthorized(): ApiResult {
  return json(401, { error: "unauthorized" });
}

/** ブラウザによるページ遷移（GET かつ Accept に text/html）か。 */
export function isBrowserNavigation(event: ApiEvent): boolean {
  return (
    event.requestContext.http.method.toUpperCase() === "GET" &&
    (event.headers["accept"] ?? "").toLowerCase().includes("text/html")
  );
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
