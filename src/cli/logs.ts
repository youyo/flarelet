import type { Cloud, LiveLogEvent, LogEvent } from "../aws/cloud.js";
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

type Group = [label: string, name: string];

/** ライブテイルが連続して失敗したらポーリングに切り替える回数。 */
const LIVE_MAX_FAILURES = 3;

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
    const groups: Group[] = [];
    if (stack?.outputs.AppLogGroup) groups.push(["app", stack.outputs.AppLogGroup]);
    if (stack?.outputs.FrontLogGroup) groups.push(["front", stack.outputs.FrontLogGroup]);
    if (!groups.length) {
      io.stderr(
        `Error: ${t.ir.name} (${t.deployment.stage}/${t.deployment.version}) is not deployed`,
      );
      return 1;
    }
    const width = Math.max(...groups.map(([l]) => l.length));
    const print = (label: string, timestamp: number, message: string): void => {
      const msg = message.replace(/\s+$/, "");
      if (NOISE.test(msg)) return;
      io.stdout(`${new Date(timestamp).toISOString()} ${label.padEnd(width)} ${msg}`);
    };
    const initial = deps.now() - sinceMs;

    if (args.follow && cloud.liveTail && !deps.signal?.aborted) {
      const done = await followLive(cloud, groups, initial, print, deps);
      if (done) return 0;
      // ライブテイルが使えなかったので、同じ位置からポーリングを続ける
    }
    return await poll(cloud, groups, initial, print, args.follow === true, deps);
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}

const dedupeKey = (label: string, ts: number, msg: string): string =>
  `${label}\u0000${ts}\u0000${msg.replace(/\s+$/, "")}`;

/**
 * CloudWatch Logs Live Tail で追従する。セッションを先に開始してからバックログを取得し、
 * 取りこぼしを防ぐ（重なった行はキーで除く）。true=終了（中断）、false=フォールバックが必要。
 */
async function followLive(
  cloud: Cloud,
  groups: Group[],
  initial: number,
  print: (label: string, ts: number, msg: string) => void,
  deps: OpsDeps,
): Promise<boolean> {
  const labelOf = new Map(groups.map(([label, g]) => [g, label]));
  const backlog = new Map<string, number>();
  let backlogDone = false;
  const pending: LiveLogEvent[] = [];
  const emit = (e: LiveLogEvent): void => {
    const label = labelOf.get(e.group);
    if (!label) return;
    const key = dedupeKey(label, e.timestamp, e.message);
    const n = backlog.get(key);
    if (n) {
      // バックログで表示済みの行
      if (n === 1) backlog.delete(key);
      else backlog.set(key, n - 1);
      return;
    }
    print(label, e.timestamp, e.message);
  };
  const onEvent = (e: LiveLogEvent): void => {
    if (backlogDone) emit(e);
    else pending.push(e);
  };

  let failures = 0;
  let first = true;
  while (!deps.signal?.aborted) {
    const session = new AbortController();
    const stop = (): void => session.abort();
    deps.signal?.addEventListener("abort", stop, { once: true });
    let isStarted = false;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = () => ((isStarted = true), r())));
    const tail = cloud.liveTail!(
      groups.map(([, g]) => g),
      onEvent,
      session.signal,
      started,
    );
    const ended = tail.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const first_ = await Promise.race([startedP.then(() => "started" as const), ended]);
      if (first_ !== "started" && !isStarted) {
        if (deps.signal?.aborted) return true;
        if (!first_.ok) {
          deps.io.stderr(
            `Warning: Live Tail unavailable (${errorMessage(first_.error)}); polling instead`,
          );
          return false;
        }
        // 開始前に正常終了（想定外）。ポーリングへ
        return false;
      }
      if (first) {
        first = false;
        const events = (
          await Promise.all(groups.map(([label, g]) => fetchAll(cloud, g, label, initial)))
        )
          .flat()
          .sort((a, b) => a.timestamp - b.timestamp);
        const seen = new Set<string>();
        for (const e of events) {
          if (seen.has(`${e.label}/${e.id}`)) continue;
          seen.add(`${e.label}/${e.id}`);
          const key = dedupeKey(e.label, e.timestamp, e.message);
          backlog.set(key, (backlog.get(key) ?? 0) + 1);
          print(e.label, e.timestamp, e.message);
        }
        backlogDone = true;
        for (const e of pending.splice(0)) emit(e);
      }
      const res = await ended;
      if (deps.signal?.aborted) return true;
      if (res.ok) failures = 0;
      else {
        if (++failures >= LIVE_MAX_FAILURES) {
          deps.io.stderr(
            `Warning: Live Tail keeps failing (${errorMessage(res.error)}); polling instead`,
          );
          return false;
        }
      }
      // セッション終了（最大 3 時間）やエラー: 再接続する
      await deps.sleep(1000);
    } finally {
      deps.signal?.removeEventListener("abort", stop);
      session.abort();
      await ended;
    }
  }
  return true;
}

async function poll(
  cloud: Cloud,
  groups: Group[],
  initial: number,
  print: (label: string, ts: number, msg: string) => void,
  follow: boolean,
  deps: OpsDeps,
): Promise<number> {
  const seen = new Set<string>();
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
      print(e.label, e.timestamp, e.message);
    }
    if (!follow || deps.signal?.aborted) return 0;
    start = Math.max(initial, deps.now() - LOOKBACK_MS);
    await deps.sleep(POLL_MS);
    if (deps.signal?.aborted) return 0;
  }
}
