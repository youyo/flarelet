import { afterEach, describe, expect, it } from "vitest";
import { parseSince, runLogs } from "../../src/cli/logs.js";
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
    name: "flareon-myapp-prod-v1",
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
});
