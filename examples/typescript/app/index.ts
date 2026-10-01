import { serve } from "@hono/node-server";
import { Hono } from "hono";

// Flareon が環境変数でバインディングを渡す（`flareon/runtime` の bindings でも読める）。
const app = new Hono();

app.get("/", (c) =>
  c.json({
    user: c.req.header("x-flareon-user-email") ?? null,
    table: process.env.FLAREON_DATABASE_NOTES_TABLE ?? null,
    bucket: process.env.FLAREON_STORAGE_ATTACHMENTS_BUCKET ?? null,
    model: process.env.FLAREON_AI_HAIKU_MODEL_ID ?? null,
    hasApiKey: "EXTERNAL_API_KEY" in process.env,
  }),
);

// Lambda では Lambda Web Adapter が 127.0.0.1 にアクセスし、flareon dev は HOST=127.0.0.1 を渡す。
// 全インターフェースで listen すると、同じネットワークから identity ヘッダを偽装して直接アクセスできてしまう
serve({
  fetch: app.fetch,
  port: Number(process.env.PORT ?? 8080),
  hostname: process.env.HOST ?? "127.0.0.1",
});
