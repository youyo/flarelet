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
  /** アプリが応答するまで待つ時間。 */
  waitMs?: number;
}

export interface DevProxy {
  port: number;
  close(): Promise<void>;
}

const RETRYABLE = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"]);

export function identityHeaders(email: string): Record<string, string> {
  return {
    "x-flareon-user-email": email,
    "x-flareon-user-sub": `dev:${email}`,
    "x-flareon-auth-mode": "dev",
  };
}

function forwardHeaders(h: IncomingHttpHeaders, identity: string | undefined): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (!k.toLowerCase().startsWith("x-flareon-")) out[k] = v;
  }
  return identity ? { ...out, ...identityHeaders(identity) } : out;
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
    const body = await readBody(req);
    const headers = forwardHeaders(req.headers, o.identity);
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
