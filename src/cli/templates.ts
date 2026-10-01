import type { RuntimeLanguage } from "../ir/index.js";

export interface ScaffoldFile {
  path: string;
  content: string;
}

const common = (name: string, runtime: string): string => `version: 1

name: ${name}

runtime:
${runtime}

http:
  auth: true

database:
  main: {}

storage:
  files: {}

ai:
  models:
    - sonnet
`;

const PYTHON_MAIN = `import os

from fastapi import FastAPI, Request

app = FastAPI()


@app.get("/")
def index(request: Request):
    # Flareon が付与する認証済みユーザー情報（x-flareon-* ヘッダ）と、バインディングの環境変数
    return {
        "message": "Hello from Flareon",
        "user": request.headers.get("x-flareon-user-email"),
        "table": os.environ.get("FLAREON_DATABASE_MAIN_TABLE"),
        "bucket": os.environ.get("FLAREON_STORAGE_FILES_BUCKET"),
        "model": os.environ.get("FLAREON_AI_SONNET_MODEL_ID"),
    }
`;

const TS_INDEX = `import { serve } from "@hono/node-server";
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) =>
  c.json({
    message: "Hello from Flareon",
    // Flareon が付与する認証済みユーザー情報（x-flareon-* ヘッダ）と、バインディングの環境変数
    user: c.req.header("x-flareon-user-email") ?? null,
    table: process.env.FLAREON_DATABASE_MAIN_TABLE ?? null,
    bucket: process.env.FLAREON_STORAGE_FILES_BUCKET ?? null,
    model: process.env.FLAREON_AI_SONNET_MODEL_ID ?? null,
  }),
);

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 8080) });
`;

const TS_PACKAGE = {
  private: true,
  type: "module",
  dependencies: { hono: "^4.13.12", "@hono/node-server": "^2.1.3" },
};

export function scaffold(name: string, language: RuntimeLanguage): ScaffoldFile[] {
  if (language === "python") {
    return [
      { path: "flareon.yaml", content: common(name, '  language: python\n  version: "3.13"') },
      { path: "app/main.py", content: PYTHON_MAIN },
      { path: "app/requirements.txt", content: "fastapi>=0.115\nuvicorn>=0.30\n" },
    ];
  }
  return [
    { path: "flareon.yaml", content: common(name, "  language: typescript") },
    { path: "app/index.ts", content: TS_INDEX },
    { path: "app/package.json", content: JSON.stringify(TS_PACKAGE, null, 2) + "\n" },
  ];
}
