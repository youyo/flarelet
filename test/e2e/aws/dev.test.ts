// flareon dev（既定モード）: preview/local-<user> の dev スタック作成 → ローカルアプリ → 実テーブルへ書き込み → 停止 → destroy
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cli,
  cliStream,
  ENABLED,
  eventually,
  forceCleanup,
  leftoversSettled,
  log,
  LONG,
  newTracked,
  prepareApp,
  REGION,
  removeDir,
  stackOutputs,
  track,
  uniqueName,
} from "./helpers.js";

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}

describe.runIf(ENABLED)("real AWS: flareon dev", () => {
  const app = uniqueName("dev");
  const tracked = newTracked();
  const secretValue = randomBytes(16).toString("hex");
  let dir: string;
  let version: string | undefined;

  beforeAll(async () => {
    dir = await prepareApp(
      "dev",
      `version: 1
name: ${app}
runtime: { language: typescript }
http: true
database: { main: {} }
storage: { files: {} }
secrets: [E2E_SECRET]
`,
    );
  }, LONG);

  afterAll(async () => {
    try {
      if (dir && version) {
        await track(app, tracked).catch(() => {});
        const r = await cli(["destroy", "--stage", "preview", "--version", version], dir);
        log(`destroy ${app}: exit ${r.code} (${r.ms}ms)`);
      }
    } finally {
      await forceCleanup(app, tracked);
      const left = await leftoversSettled(app, tracked);
      await removeDir(dir);
      expect(left, `leftover resources for ${app}`).toEqual([]);
    }
  }, LONG);

  it(
    "creates preview/local-<user>, runs the app locally against the real table, then destroys it",
    async () => {
      const set = await cli(
        ["secret", "set", "E2E_SECRET", "--stage", "preview"],
        dir,
        secretValue,
      );
      expect(set.code, set.stderr).toBe(0);

      const port = await freePort();
      const lines: string[] = [];
      let stderr = "";
      const t0 = Date.now();
      const child = cliStream(
        ["dev", "--port", String(port)],
        dir,
        (l) => lines.push(l),
        (c) => (stderr += c),
      );
      const exited = new Promise<number | null>((r) => child.once("exit", (c) => r(c)));
      try {
        await eventually(
          async () => {
            if (child.exitCode !== null) throw new Error(`dev exited: ${stderr}`);
            return lines.includes("Watching...") ? true : undefined;
          },
          LONG - 120_000,
          500,
        );
        log(`dev ${app} ready in ${Date.now() - t0}ms`);
        const out = lines.join("\n");
        version = /Version\s+(local-[a-z0-9-]+)/.exec(out)?.[1];
        expect(version, out).toBeDefined();
        expect(out).toMatch(/database\.main\s+connected/);
        expect(out).toMatch(/storage\.files\s+connected/);
        expect(out).toMatch(/secrets\.E2E_SECRET\s+loaded/);
        expect(out).not.toContain(secretValue);
        await track(app, tracked);

        const stack = await stackOutputs(`flareon-${app}-preview-${version}`);
        expect(stack?.Bindings).toBeDefined();

        const key = `k${Date.now()}`;
        const value = randomBytes(8).toString("hex");
        const put = await eventually(
          async () => {
            const r = await fetch(`http://localhost:${port}/db/${key}`, {
              method: "PUT",
              body: JSON.stringify({ value }),
            });
            return r.status === 200 ? ((await r.json()) as { table: string }) : undefined;
          },
          60_000,
          1000,
        );
        const item = await new DynamoDBClient({ region: REGION }).send(
          new GetItemCommand({ TableName: put.table, Key: { pk: { S: "e2e" }, sk: { S: key } } }),
        );
        expect(item.Item?.value?.S).toBe(value);
        expect(JSON.parse(stack!.Bindings!).FLAREON_DATABASE_MAIN_TABLE).toBe(put.table);

        const secret = (await (await fetch(`http://localhost:${port}/secret`)).json()) as {
          sha256: string;
        };
        expect(secret.sha256).toBe(createHash("sha256").update(secretValue).digest("hex"));
      } finally {
        child.kill("SIGINT");
      }
      expect(await exited).toBe(0);
      expect(lines.join("\n")).toContain(`flareon destroy --stage preview --version ${version}`);

      const env = await cli(["env", "list"], dir);
      expect(env.stdout).toMatch(new RegExp(`preview\\s+${version}\\s+dev`));

      const destroy = await cli(["destroy", "--stage", "preview", "--version", version!], dir);
      expect(destroy.code, destroy.stderr).toBe(0);
      expect(await stackOutputs(`flareon-${app}-preview-${version}`)).toBeUndefined();
      const del = await cli(["secret", "delete", "E2E_SECRET", "--stage", "preview"], dir);
      expect(del.code, del.stderr).toBe(0);
      version = undefined;
    },
    LONG,
  );
});
