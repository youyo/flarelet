import { stdin, stderr } from "node:process";

/** シークレット値を読む。パイプなら stdin 全体、TTY ならエコーせずに 1 行読む。値はどこにも出力しない。 */
export async function readSecretInput(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const c of stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
    return Buffer.concat(chunks).toString("utf8");
  }
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      stderr.write("\n");
      fn();
    };
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\r" || c === "\n") return done(() => resolve(value));
        if (c === "\u0003") return done(() => reject(new Error("cancelled")));
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else value += c;
      }
    };
    stdin.on("data", onData);
  });
}
