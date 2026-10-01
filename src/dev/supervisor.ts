/** ローカルアプリのプロセス監督。ファイル変更で再起動する。子プロセスと監視は差し替え可能。 */

export interface ChildLike {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export interface SupervisorDeps {
  spawn(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string> }): ChildLike;
  /** dir 以下の変更を相対パスで通知する。 */
  watch(dir: string, onChange: (file: string) => void): { close(): void };
}

export interface AppCommand {
  cmd: string;
  args: string[];
  cwd: string;
}

export interface SupervisorOptions {
  watchDir: string;
  /** 起動のたびに呼ぶ（TypeScript のバンドル等）。失敗したら次の変更まで待つ。 */
  command: () => Promise<AppCommand>;
  env: Record<string, string>;
  log: (line: string) => void;
  debounceMs?: number;
  /** SIGTERM 後、SIGKILL までの猶予。 */
  killTimeoutMs?: number;
}

export interface Supervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
}

const IGNORED_DIRS = new Set(["node_modules", "__pycache__", "venv"]);

/** 依存・キャッシュ・エディタの一時ファイル・ドットファイルは再起動の契機にしない。 */
export function isIgnoredPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p.startsWith(".") || IGNORED_DIRS.has(p))) return true;
  const base = parts.at(-1) ?? "";
  return /(~|\.pyc|\.pyo|\.swp|\.swx|\.tmp)$/.test(base);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createSupervisor(o: SupervisorOptions, deps: SupervisorDeps): Supervisor {
  const debounceMs = o.debounceMs ?? 150;
  const killTimeoutMs = o.killTimeoutMs ?? 3000;
  let child: ChildLike | undefined;
  const expected = new WeakSet<ChildLike>();
  let watcher: { close(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let stopped = false;
  const pending = new Set<string>();

  async function launch(): Promise<void> {
    let c: AppCommand;
    try {
      c = await o.command();
    } catch (e) {
      o.log(`Error: ${message(e)}`);
      o.log("Waiting for changes...");
      return;
    }
    if (stopped) return;
    const proc = deps.spawn(c.cmd, c.args, { cwd: c.cwd, env: o.env });
    child = proc;
    proc.once("exit", (code, signal) => {
      if (child === proc) child = undefined;
      if (!expected.has(proc)) {
        o.log(`App exited with code ${code ?? signal ?? "?"}; waiting for changes...`);
      }
    });
  }

  function terminate(proc: ChildLike): Promise<void> {
    expected.add(proc);
    return new Promise((resolve) => {
      const t = setTimeout(() => proc.kill("SIGKILL"), killTimeoutMs);
      proc.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  function restart(): void {
    queue = queue.then(async () => {
      if (stopped) return;
      const files = [...pending];
      pending.clear();
      const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? ", ..." : "");
      o.log(`Change detected (${shown}), restarting`);
      if (child) await terminate(child);
      if (!stopped) await launch();
    });
  }

  function onChange(file: string): void {
    if (stopped || isIgnoredPath(file)) return;
    pending.add(file);
    if (timer) clearTimeout(timer);
    timer = setTimeout(restart, debounceMs);
  }

  return {
    async start() {
      watcher = deps.watch(o.watchDir, onChange);
      await launch();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      watcher?.close();
      await queue;
      if (child) await terminate(child);
    },
  };
}
