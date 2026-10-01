import type { Cloud, LogEvent } from "../aws/cloud.js";
import { stackNames } from "../constructs/names.js";
import { errorMessage, type OpsDeps } from "./ops.js";
import { resolveTarget, type SynthArgs } from "./synth.js";

export interface LogsArgs extends SynthArgs {
  since?: string;
  follow?: boolean;
}

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseSince(v: string): number {
  const m = /^(\d+)([smhd])$/.exec(v.trim());
  if (!m) throw new Error(`invalid --since "${v}" (use e.g. 30s, 10m, 2h, 1d)`);
  return Number(m[1]) * UNITS[m[2]!]!;
}

/** 追従時のポーリング間隔（目標: 3 秒以内に表示）。 */
const POLL_MS = 1000;
/** 取り込み遅延で古いタイムスタンプのイベントが後から届くため、毎回この幅だけ遡って重複排除する。 */
const LOOKBACK_MS = 30_000;
const NOISE = /^(START|END) RequestId: /;

interface Labeled extends LogEvent {
  label: string;
}

async function fetchAll(cloud: Cloud, group: string, label: string, start: number) {
  const out: Labeled[] = [];
  let token: string | undefined;
  do {
    const page = await cloud.filterLogs(group, start, token);
    for (const e of page.events) out.push({ ...e, label });
    token = page.nextToken;
  } while (token);
  return out;
}

export async function runLogs(args: LogsArgs, deps: OpsDeps): Promise<number> {
  const { io } = deps;
  let sinceMs: number;
  try {
    sinceMs = parseSince(args.since ?? "10m");
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const cloud = deps.cloud(t.region);
  const name = stackNames(t.ir.name, t.deployment).version;

  try {
    const stack = await cloud.describeStack(name);
    const groups: [string, string][] = [];
    if (stack?.outputs.AppLogGroup) groups.push(["app", stack.outputs.AppLogGroup]);
    if (stack?.outputs.FrontLogGroup) groups.push(["front", stack.outputs.FrontLogGroup]);
    if (!groups.length) {
      io.stderr(
        `Error: ${t.ir.name} (${t.deployment.stage}/${t.deployment.version}) is not deployed`,
      );
      return 1;
    }
    const width = Math.max(...groups.map(([l]) => l.length));
    const seen = new Set<string>();
    const initial = deps.now() - sinceMs;
    let start = initial;
    for (;;) {
      const batch = (
        await Promise.all(groups.map(([label, g]) => fetchAll(cloud, g, label, start)))
      ).flat();
      batch.sort((a, b) => a.timestamp - b.timestamp);
      for (const e of batch) {
        const key = `${e.label}/${e.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const msg = e.message.replace(/\s+$/, "");
        if (NOISE.test(msg)) continue;
        io.stdout(`${new Date(e.timestamp).toISOString()} ${e.label.padEnd(width)} ${msg}`);
      }
      if (!args.follow || deps.signal?.aborted) return 0;
      start = Math.max(initial, deps.now() - LOOKBACK_MS);
      await deps.sleep(POLL_MS);
      if (deps.signal?.aborted) return 0;
    }
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
