import { describe, expect, it } from "vitest";
import { FlareletIoHost, type ProgressEvent } from "../../src/aws/iohost.js";

const msg = (code: string, data: unknown, level = "info", message = "") => ({
  time: new Date(),
  level,
  action: "deploy",
  code,
  message,
  data,
});

function host() {
  const events: ProgressEvent[] = [];
  return { events, h: new FlareletIoHost((e) => events.push(e)) };
}

describe("FlareletIoHost", () => {
  it("translates stack monitoring into Flarelet progress events", async () => {
    const { events, h } = host();
    await h.notify(msg("CDK_TOOLKIT_I5501", { stackName: "flarelet-a-prod" }) as never);
    await h.notify(
      msg("CDK_TOOLKIT_I5502", {
        event: {
          LogicalResourceId: "DataDatabasemain1",
          ResourceStatus: "CREATE_IN_PROGRESS",
          StackName: "flarelet-a-prod",
          ResourceType: "AWS::DynamoDB::Table",
        },
        metadata: { constructPath: "Data/Database-main" },
      }) as never,
    );
    await h.notify(
      msg("CDK_TOOLKIT_I5502", {
        event: {
          LogicalResourceId: "UserPool",
          ResourceStatus: "CREATE_FAILED",
          ResourceStatusReason: "Domain already exists",
          StackName: "flarelet-a-prod",
        },
        metadata: { constructPath: "/flarelet-a-prod/UserPool/Resource" },
      }) as never,
    );
    await h.notify(msg("CDK_TOOLKIT_I5503", { stackName: "flarelet-a-prod" }) as never);
    expect(events).toEqual([
      { type: "stack-start", stack: "flarelet-a-prod" },
      {
        type: "resource",
        stack: "flarelet-a-prod",
        concept: "database.main",
        status: "CREATE_IN_PROGRESS",
      },
      {
        type: "resource",
        stack: "flarelet-a-prod",
        concept: "authentication",
        status: "CREATE_FAILED",
        reason: "Domain already exists",
      },
      { type: "stack-end", stack: "flarelet-a-prod" },
    ]);
  });

  it("reports asset publishing once and forwards errors", async () => {
    const { events, h } = host();
    await h.notify(msg("CDK_TOOLKIT_I5210", {}) as never);
    await h.notify(msg("CDK_TOOLKIT_I5220", {}) as never);
    await h.notify(msg("CDK_TOOLKIT_E5500", {}, "error", "boom") as never);
    await h.notify(msg("CDK_TOOLKIT_I9999", {}, "debug", "noise") as never);
    expect(events).toEqual([{ type: "assets" }, { type: "error", message: "boom" }]);
  });

  it("auto-approves deploy/destroy confirmations (non-interactive)", async () => {
    const { h } = host();
    const req = (code: string, defaultResponse: unknown) =>
      ({ ...msg(code, {}), defaultResponse }) as never;
    expect(await h.requestResponse(req("CDK_TOOLKIT_I5060", false))).toBe(true);
    expect(await h.requestResponse(req("CDK_TOOLKIT_I7010", false))).toBe(true);
    expect(await h.requestResponse(req("CDK_TOOLKIT_I3110", "x"))).toBe("x");
  });
});
