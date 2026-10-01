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

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
