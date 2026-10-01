import { afterEach, describe, expect, it } from "vitest";
import { parseSince, runLogs } from "../../src/cli/logs.js";
import type { Cloud } from "../../src/aws/cloud.js";
import { harness, type Harness } from "./fake-cloud.js";

const YAML = `version: 1
name: myapp
runtime: { language: python }
http: true
`;

let h: Harness;
afterEach(async () => h?.cleanup());

describe("parseSince", () => {
  it("parses s/m/h/d durations", () => {
    expect(parseSince("30s")).toBe(30_000);
    expect(parseSince("10m")).toBe(600_000);
    expect(parseSince("2h")).toBe(7_200_000);
    expect(parseSince("1d")).toBe(86_400_000);
    expect(() => parseSince("10")).toThrow(/--since/);
    expect(() => parseSince("abc")).toThrow(/--since/);
  });
});

async function deployed() {
  h = await harness(YAML);
  h.cloud.addStack({
    name: "flarelet-myapp-prod-v1",
    outputs: { AppLogGroup: "/app", FrontLogGroup: "/front" },
  });
}

describe("runLogs", () => {
  it("prints recent app and front logs merged by time, without Lambda START/END noise", async () => {
    await deployed();
    const t = 1_000_000;
    h.cloud.logs.set("/app", [
      { id: "a1", timestamp: t + 2000, message: "INFO handled /\n" },
      { id: "a0", timestamp: t + 500, message: "START RequestId: x Version: $LATEST\n" },
      { id: "a2", timestamp: t + 3000, message: "END RequestId: x\n" },
    ]);
    h.cloud.logs.set("/front", [{ id: "f1", timestamp: t + 1000, message: "auth ok" }]);
    h.deps.now = () => t + 60_000;
    expect(await runLogs({ file: h.file, stage: "prod", version: "v1", since: "1m" }, h.deps)).toBe(
      0,
    );
    expect(h.out).toEqual([
      `${new Date(t + 1000).toISOString()} front auth ok`,
      `${new Date(t + 2000).toISOString()} app   INFO handled /`,
    ]);
    expect(h.cloud.calls).toContain(`filterLogs:/app:${t}`);
  });

  it("--follow keeps polling, de-duplicates and stops on abort", async () => {
    await deployed();
    let now = 10_000_000;
    h.deps.now = () => now;
    const ac = new AbortController();
    h.deps.signal = ac.signal;
    let polls = 0;
    h.deps.sleep = async (ms) => {
      expect(ms).toBeLessThanOrEqual(1000);
      polls++;
      now += 1000;
      if (polls === 1) {
        h.cloud.logs.set("/app", [{ id: "n1", timestamp: now - 500, message: "new line" }]);
      }
      if (polls === 3) ac.abort();
    };
    h.cloud.logs.set("/app", [{ id: "o1", timestamp: now - 1000, message: "old line" }]);
    expect(
      await runLogs(
        { file: h.file, stage: "prod", version: "v1", since: "5m", follow: true },
        h.deps,
      ),
    ).toBe(0);
    expect(h.out.filter((l) => l.includes("old line"))).toHaveLength(1);
    expect(h.out.filter((l) => l.includes("new line"))).toHaveLength(1);
    expect(polls).toBe(3);
  });

  it("fails when the version is not deployed", async () => {
    h = await harness(YAML);
    expect(await runLogs({ file: h.file, stage: "prod", version: "v1" }, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("not deployed");
  });

  describe("--follow with CloudWatch Logs Live Tail", () => {
    type Tail = NonNullable<Cloud["liveTail"]>;
    const args = { file: "", stage: "prod", version: "v1", since: "5m", follow: true };

    const waitAbort = (signal: AbortSignal) =>
      new Promise<void>((r) =>
        signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true }),
      );

    it("streams live events after the backlog without polling, de-duplicating the overlap", async () => {
      await deployed();
      const now = 10_000_000;
      h.deps.now = () => now;
      const ac = new AbortController();
      h.deps.signal = ac.signal;
      h.cloud.logs.set("/app", [{ id: "o1", timestamp: now - 1000, message: "old line" }]);
      let groupsSeen: string[] = [];
      const tail: Tail = async (groups, onEvent, signal, onStarted) => {
        groupsSeen = groups;
        onStarted();
        // バックログと重なる行（再表示されない）と、新しい行
        onEvent({ group: "/app", timestamp: now - 1000, message: "old line\n" });
        onEvent({ group: "/front", timestamp: now + 10, message: "live front" });
        onEvent({ group: "/app", timestamp: now + 20, message: "live app\n" });
        ac.abort();
        await waitAbort(signal);
      };
      h.cloud.liveTail = tail;
      expect(await runLogs({ ...args, file: h.file }, h.deps)).toBe(0);
      expect(groupsSeen.sort()).toEqual(["/app", "/front"]);
      expect(h.out.filter((l) => l.includes("old line"))).toHaveLength(1);
      expect(h.out.some((l) => l.endsWith("front live front"))).toBe(true);
      expect(h.out.some((l) => l.endsWith("app   live app"))).toBe(true);
      expect(h.cloud.calls.filter((c) => c.startsWith("filterLogs"))).toHaveLength(2);
      expect(h.err).toEqual([]);
    });

    it("falls back to polling (with a notice) when Live Tail is unavailable", async () => {
      await deployed();
      let now = 10_000_000;
      h.deps.now = () => now;
      const ac = new AbortController();
      h.deps.signal = ac.signal;
      h.cloud.liveTail = async () => {
        throw new Error("AccessDeniedException: not allowed");
      };
      let polls = 0;
      h.deps.sleep = async () => {
        now += 1000;
        if (++polls === 1) {
          h.cloud.logs.set("/app", [{ id: "n1", timestamp: now - 500, message: "polled line" }]);
        }
        if (polls === 2) ac.abort();
      };
      expect(await runLogs({ ...args, file: h.file }, h.deps)).toBe(0);
      expect(h.err.join("\n")).toMatch(/Live Tail.*AccessDenied.*polling/s);
      expect(h.out.filter((l) => l.includes("polled line"))).toHaveLength(1);
    });

    it("restarts the session when it ends on its own", async () => {
      await deployed();
      const now = 10_000_000;
      h.deps.now = () => now;
      const ac = new AbortController();
      h.deps.signal = ac.signal;
      let sessions = 0;
      h.cloud.liveTail = async (_g, onEvent, signal, onStarted) => {
        onStarted();
        sessions++;
        onEvent({ group: "/app", timestamp: now + sessions, message: `session ${sessions}` });
        if (sessions === 2) {
          ac.abort();
          await waitAbort(signal);
        }
      };
      expect(await runLogs({ ...args, file: h.file }, h.deps)).toBe(0);
      expect(sessions).toBe(2);
      expect(h.out.filter((l) => l.includes("session "))).toHaveLength(2);
    });

    it("does not use Live Tail without --follow", async () => {
      await deployed();
      let used = false;
      h.cloud.liveTail = async () => {
        used = true;
      };
      await runLogs({ file: h.file, stage: "prod", version: "v1" }, h.deps);
      expect(used).toBe(false);
    });
  });
});
