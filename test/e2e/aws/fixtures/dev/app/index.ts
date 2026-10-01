import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

// `flareon dev` の実 AWS E2E 用アプリ。ローカルで動き、Flareon のバインディングで実テーブルに書き込む。
const ddb = new DynamoDBClient({});
const table = process.env.FLAREON_DATABASE_MAIN_TABLE;

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const db = /^\/db\/([\w-]+)$/.exec(url.pathname);
  if (req.method === "PUT" && db) {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const value = (JSON.parse(body) as { value: string }).value;
      ddb
        .send(
          new PutItemCommand({
            TableName: table,
            Item: { pk: { S: "e2e" }, sk: { S: db[1]! }, value: { S: value } },
          }),
        )
        .then(() => send(200, { ok: true, table }))
        .catch((e: Error) => send(500, { error: e.message }));
    });
    return;
  }
  if (url.pathname === "/secret") {
    // 値そのものは返さない（ハッシュで照合する）
    const v = process.env.E2E_SECRET;
    send(200, { sha256: v ? createHash("sha256").update(v).digest("hex") : null });
    return;
  }
  send(200, {
    table,
    version: process.env.FLAREON_VERSION,
    bucket: process.env.FLAREON_STORAGE_FILES_BUCKET,
  });
}).listen(Number(process.env.PORT));
