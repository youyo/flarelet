// F2/F6: TypeScript アプリ（init のテンプレート・examples・実 AWS E2E のフィクスチャ）は全インターフェースで listen しない。
// flareon dev は HOST=127.0.0.1 を渡し、Lambda では Lambda Web Adapter が 127.0.0.1:8080 にアクセスする。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffold } from "../../src/cli/templates.js";

const root = resolve(import.meta.dirname, "../..");
const sources: [string, string][] = [
  [
    "flareon init (typescript)",
    scaffold("demo", "typescript").find((f) => f.path === "app/index.ts")!.content,
  ],
  ...[
    "examples/typescript/app/index.ts",
    "test/e2e/aws/fixtures/typescript/app/index.ts",
    "test/e2e/aws/fixtures/dev/app/index.ts",
  ].map((p): [string, string] => [p, readFileSync(resolve(root, p), "utf8")]),
];

describe("TypeScript apps listen on HOST (default 127.0.0.1)", () => {
  it.each(sources)("%s", (_name, src) => {
    expect(src).toContain('process.env.HOST ?? "127.0.0.1"');
    expect(src).not.toContain("0.0.0.0");
  });
});
