import type { Cloud, Deployer } from "../aws/cloud.js";
import { stackNames } from "../constructs/names.js";
import type { Deployment } from "../resolver/index.js";
import type { SynthDeps } from "./synth.js";

/** AWS に接続するコマンド（deploy / destroy / env / logs / secret / auth）の依存。すべて差し替え可能。 */
export interface OpsDeps extends SynthDeps {
  cloud: (region: string) => Cloud;
  deployer: (region: string) => Deployer;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** シークレット値の入力（stdin、TTY ならエコーなしプロンプト）。 */
  readSecret: (prompt: string) => Promise<string>;
  /** 対話端末か（deploy / dev の自動 bootstrap の判定）。 */
  interactive: () => boolean;
  /** logs --follow の停止シグナル。 */
  signal?: AbortSignal;
}

export const isOffline = (env: Record<string, string | undefined>): boolean =>
  ["1", "true"].includes(env.FLARELET_OFFLINE ?? "");

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 経過時間を `42s` / `1m05s` で表す。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export const target = (app: string, d: Deployment): string => `${app} (${d.stage}/${d.version})`;

export { stackNames };
