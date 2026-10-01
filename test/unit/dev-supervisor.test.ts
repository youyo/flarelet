import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSupervisor,
  isIgnoredPath,
  type ChildLike,
  type SupervisorDeps,
} from "../../src/dev/supervisor.js";

class FakeChild extends EventEmitter implements ChildLike {
  killed: string[] = [];
  constructor(
    public cmd: string,
    public args: string[],
    public opts: { cwd: string; env: Record<string, string> },
    private exitOn = ["SIGTERM", "SIGINT", "SIGKILL"],
  ) {
    super();
  }
  kill(sig: NodeJS.Signals = "SIGTERM") {
    this.killed.push(sig);
    if (this.exitOn.includes(sig)) queueMicrotask(() => this.emit("exit", null, sig));
    return true;
  }
}

function setup(
  o: {
    prepare?: () => Promise<void>;
    stubborn?: boolean;
    commandEnv?: Record<string, string>;
  } = {},
) {
  const children: FakeChild[] = [];
  let onChange: ((f: string) => void) | undefined;
  let closed = false;
  const logs: string[] = [];
  const deps: SupervisorDeps = {
    spawn: (cmd, args, opts) => {
      const c = new FakeChild(cmd, args, opts, o.stubborn ? ["SIGKILL"] : undefined);
      children.push(c);
      return c;
    },
    watch: (_dir, cb) => {
      onChange = cb;
      return {
        close: () => {
          closed = true;
        },
      };
    },
  };
  const sup = createSupervisor(
    {
      watchDir: "/app/app",
      command: async () => {
        await o.prepare?.();
        return {
          cmd: "python",
          args: ["-m", "uvicorn"],
          cwd: "/app/app",
          ...(o.commandEnv ? { env: o.commandEnv } : {}),
        };
      },
      env: { PORT: "9999", X: "1" },
      log: (l) => logs.push(l),
      debounceMs: 100,
      killTimeoutMs: 1000,
    },
    deps,
  );
  return {
    sup,
    children,
    logs,
    change: (f: string) => onChange?.(f),
    isClosed: () => closed,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("supervisor", () => {
  it("starts the app with the given command, cwd and environment", async () => {
    const s = setup();
    await s.sup.start();
    expect(s.children).toHaveLength(1);
    expect(s.children[0]!.cmd).toBe("python");
    expect(s.children[0]!.opts).toEqual({ cwd: "/app/app", env: { PORT: "9999", X: "1" } });
  });

  it("adds the command's own environment (e.g. PYTHONDONTWRITEBYTECODE) on top", async () => {
    const s = setup({ commandEnv: { PYTHONDONTWRITEBYTECODE: "1", X: "2" } });
    await s.sup.start();
    expect(s.children[0]!.opts.env).toEqual({
      PORT: "9999",
      X: "2",
      PYTHONDONTWRITEBYTECODE: "1",
    });
  });

  it("restarts once after a burst of changes (debounced)", async () => {
    const s = setup();
    await s.sup.start();
    s.change("main.py");
    s.change("main.py");
    s.change("util.py");
    await vi.advanceTimersByTimeAsync(150);
    expect(s.children).toHaveLength(2);
    expect(s.children[0]!.killed).toEqual(["SIGTERM"]);
    expect(s.logs.join("\n")).toMatch(/main\.py.*restarting/);
  });

  it("ignores dependency, cache and editor files", async () => {
    const s = setup();
    await s.sup.start();
    for (const f of [
      "node_modules/x/index.js",
      "__pycache__/main.cpython-313.pyc",
      ".venv/lib/a.py",
      ".flarelet/dev/index.mjs",
      ".main.py.swp",
      "main.py~",
    ]) {
      s.change(f);
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(s.children).toHaveLength(1);
  });

  it("force-kills an app that ignores SIGTERM", async () => {
    const s = setup({ stubborn: true });
    await s.sup.start();
    s.change("main.py");
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(1100);
    expect(s.children[0]!.killed).toEqual(["SIGTERM", "SIGKILL"]);
    expect(s.children).toHaveLength(2);
  });

  it("reports a crashed app and waits for the next change", async () => {
    const s = setup();
    await s.sup.start();
    s.children[0]!.emit("exit", 1, null);
    expect(s.logs.join("\n")).toMatch(/exited with code 1.*waiting for changes/);
    s.change("main.py");
    await vi.advanceTimersByTimeAsync(150);
    expect(s.children).toHaveLength(2);
  });

  it("keeps watching when preparing the app fails (e.g. a build error)", async () => {
    let fail = true;
    const s = setup({
      prepare: async () => {
        if (fail) throw new Error("index.ts:3: syntax error");
      },
    });
    await s.sup.start();
    expect(s.children).toHaveLength(0);
    expect(s.logs.join("\n")).toMatch(/syntax error/);
    fail = false;
    s.change("index.ts");
    await vi.advanceTimersByTimeAsync(150);
    expect(s.children).toHaveLength(1);
  });

  it("stop() closes the watcher and terminates the app", async () => {
    const s = setup();
    await s.sup.start();
    await s.sup.stop();
    expect(s.isClosed()).toBe(true);
    expect(s.children[0]!.killed).toEqual(["SIGTERM"]);
    s.change("main.py");
    await vi.advanceTimersByTimeAsync(500);
    expect(s.children).toHaveLength(1);
  });
});

describe("isIgnoredPath", () => {
  it.each([
    ["main.py", false],
    ["routes/users.py", false],
    ["src/index.ts", false],
    ["node_modules/a.js", true],
    ["a/__pycache__/b.pyc", true],
    [".git/HEAD", true],
    ["foo.pyc", true],
    [".DS_Store", true],
  ])("%s -> %s", (p, ignored) => {
    expect(isIgnoredPath(p)).toBe(ignored);
  });
});
