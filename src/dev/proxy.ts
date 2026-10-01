import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * `flareon dev` の前段プロキシ。本番の front auth Lambda と同様にクライアント由来の `x-flareon-*` を必ず消す。
 * ローカルでは認証しないので identity は付けない。`--as <email>` のときだけ擬似 identity を付ける。
 * アプリの再起動中はしばらく待ってから転送する。
 */
export interface ProxyOptions {
  port: number;
  /** 既定 127.0.0.1（擬似 identity を付けられるので外部に公開しない）。 */
  host?: string;
  targetPort: number;
  identity?: string;
  /**
   * 転送するリクエストに付ける `x-flareon-dev-secret`。アプリ側（flareon/runtime の identity()）は
   * FLAREON_DEV_SECRET と一致するときだけ identity ヘッダを信用する（プロキシを経由しない直接アクセス対策）。
   */
  secret?: string;
  /** アプリが応答するまで待つ時間。 */
  waitMs?: number;
}

export interface DevProxy {
  port: number;
  close(): Promise<void>;
}

const RETRYABLE = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"]);

export const DEV_SECRET_HEADER = "x-flareon-dev-secret";

export function identityHeaders(email: string): Record<string, string> {
  return {
    "x-flareon-user-email": email,
    // 利用者が自分で指定した擬似ユーザーなので検証済みとして扱う
    "x-flareon-user-email-verified": "true",
    "x-flareon-user-sub": `dev:${email}`,
    "x-flareon-auth-mode": "dev",
  };
}

function forwardHeaders(
  h: IncomingHttpHeaders,
  identity: string | undefined,
  secret: string | undefined,
): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (!k.toLowerCase().startsWith("x-flareon-")) out[k] = v;
  }
  if (identity) Object.assign(out, identityHeaders(identity));
  if (secret) out[DEV_SECRET_HEADER] = secret;
  return out;
}

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

/**
 * DNS rebinding 対策: ブラウザは攻撃者のドメイン名を Host に入れて送ってくるので、ループバックの名前以外は拒否する。
 */
export function isLoopbackHost(host: string | undefined): boolean {
  return host !== undefined && LOOPBACK_HOST.test(host.trim().toLowerCase());
}

/**
 * `--as` では擬似 identity が付くので、他サイトのページからのリクエスト（CSRF）を拒否する。
 * Origin があれば自オリジン（http://<Host>）と一致すること、Sec-Fetch-Site が cross-site でないこと。
 */
export function isCrossSite(h: IncomingHttpHeaders): boolean {
  if (h["sec-fetch-site"]?.toLowerCase() === "cross-site") return true;
  const origin = h["origin"];
  if (origin === undefined) return false;
  return origin.toLowerCase() !== `http://${(h["host"] ?? "").trim().toLowerCase()}`;
}

function forbid(res: ServerResponse, why: string): void {
  res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
  res.end(`Flareon dev: ${why}\n`);
}

function sendOnce(
  port: number,
  req: IncomingMessage,
  headers: IncomingHttpHeaders,
  body: Buffer,
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const up = request(
      { host: "127.0.0.1", port, method: req.method, path: req.url, headers },
      resolve,
    );
    up.on("error", reject);
    up.end(body);
  });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function startProxy(o: ProxyOptions): Promise<DevProxy> {
  const waitMs = o.waitMs ?? 15_000;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackHost(req.headers.host)) {
      forbid(res, "requests must be addressed to localhost, 127.0.0.1 or [::1]");
      return;
    }
    if (o.identity && isCrossSite(req.headers)) {
      forbid(res, "cross-site requests are refused while --as simulates a signed-in user");
      return;
    }
    const body = await readBody(req);
    const headers = forwardHeaders(req.headers, o.identity, o.secret);
    const deadline = Date.now() + waitMs;
    for (;;) {
      try {
        const up = await sendOnce(o.targetPort, req, headers, body);
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
        return;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? "";
        if (RETRYABLE.has(code) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(
          `Flareon dev: the app is not responding on port ${o.targetPort} (${code || String(e)}). Check the terminal for errors.\n`,
        );
        return;
      }
    }
  };
  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", (e: NodeJS.ErrnoException) => {
      reject(
        e.code === "EADDRINUSE"
          ? new Error(`port ${o.port} is in use; pass --port to use another one`)
          : e,
      );
    });
    server.listen(o.port, o.host ?? "127.0.0.1", () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () =>
          new Promise((r) => {
            server.closeAllConnections();
            server.close(() => r());
          }),
      });
    });
  });
}
