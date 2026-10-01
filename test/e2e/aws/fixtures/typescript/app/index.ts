import { serve } from "@hono/node-server";
import { Hono } from "hono";

// 実 AWS E2E 用の最小アプリ（PoC1: auth なし / Preview: preview token 認証）
const app = new Hono();
app.get("/", (c) =>
  c.json({
    app: "typescript",
    message: "hello from flareon",
    version: process.env.FLAREON_VERSION,
  }),
);
app.get("/whoami", (c) =>
  c.json({
    sub: c.req.header("x-flareon-user-sub") ?? null,
    mode: c.req.header("x-flareon-auth-mode") ?? null,
    table: process.env.FLAREON_DATABASE_MAIN_TABLE ?? null,
    // front auth が x-flareon-* を剥がしているか（false なら flareon/runtime の identity() は常に null）
    authEnabled: process.env.FLAREON_AUTH_ENABLED ?? null,
    version: process.env.FLAREON_VERSION,
  }),
);
app.get("/log", (c) => {
  console.log(`e2e-log-marker ${c.req.query("id") ?? ""}`);
  return c.json({ ok: true });
});
// Lambda では Lambda Web Adapter が 127.0.0.1 にアクセスし、flareon dev は HOST=127.0.0.1 を渡す。
// 全インターフェースで listen すると、同じネットワークから identity ヘッダを偽装して直接アクセスできてしまう
serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 8080),
  hostname: process.env.HOST ?? "127.0.0.1",
});
