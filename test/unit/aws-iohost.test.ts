import { describe, expect, it } from "vitest";
import { FlareonIoHost, type ProgressEvent } from "../../src/aws/iohost.js";

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
  return { events, h: new FlareonIoHost((e) => events.push(e)) };
}

describe("FlareonIoHost", () => {
  it("translates stack monitoring into Flareon progress events", async () => {
    const { events, h } = host();
    await h.notify(msg("CDK_TOOLKIT_I5501", { stackName: "flareon-a-prod" }) as never);
    await h.notify(
      msg("CDK_TOOLKIT_I5502", {
        event: {
          LogicalResourceId: "DataDatabasemain1",
          ResourceStatus: "CREATE_IN_PROGRESS",
          StackName: "flareon-a-prod",
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
          StackName: "flareon-a-prod",
        },
        metadata: { constructPath: "/flareon-a-prod/UserPool/Resource" },
      }) as never,
    );
    await h.notify(msg("CDK_TOOLKIT_I5503", { stackName: "flareon-a-prod" }) as never);
    expect(events).toEqual([
      { type: "stack-start", stack: "flareon-a-prod" },
      {
        type: "resource",
        stack: "flareon-a-prod",
        concept: "database.main",
        status: "CREATE_IN_PROGRESS",
      },
      {
        type: "resource",
        stack: "flareon-a-prod",
        concept: "authentication",
        status: "CREATE_FAILED",
        reason: "Domain already exists",
      },
      { type: "stack-end", stack: "flareon-a-prod" },
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
