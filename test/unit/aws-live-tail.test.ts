import { describe, expect, it } from "vitest";
import { groupFromIdentifier } from "../../src/aws/real.js";

describe("groupFromIdentifier", () => {
  it("handles the account:name form Live Tail returns", () => {
    expect(groupFromIdentifier("123456789012:/aws/lambda/fn")).toBe("/aws/lambda/fn");
    expect(groupFromIdentifier("123456789012:flarelet-app-AppLogs-X")).toBe(
      "flarelet-app-AppLogs-X",
    );
  });
  it("handles ARNs, with or without :*", () => {
    expect(groupFromIdentifier("arn:aws:logs:ap-northeast-1:1234:log-group:/x/y")).toBe("/x/y");
    expect(groupFromIdentifier("arn:aws:logs:ap-northeast-1:1234:log-group:/x/y:*")).toBe("/x/y");
  });
  it("passes plain names through", () => {
    expect(groupFromIdentifier("/x/y")).toBe("/x/y");
  });
});
