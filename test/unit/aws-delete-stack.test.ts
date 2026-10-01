// awsCloud().deleteStack: CDK が作成時に使った CloudFormation 実行ロール（cfn-exec）で削除する。
// CI ロールは削除対象リソースへの直接権限を持たず、cfn-exec の PassRole だけを持つ（bootstrap github）。
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awsCloud } from "../../src/aws/real.js";

const ROLE =
  "arn:aws:iam::123456789012:role/cdk-hnb659fds-cfn-exec-role-123456789012-ap-northeast-1";
const ID = "arn:aws:cloudformation:ap-northeast-1:123456789012:stack/flarelet-app-preview-pr-1/x";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fakeCfn(stack: Record<string, unknown>) {
  const deletes: Record<string, unknown>[] = [];
  let deleted = false;
  vi.spyOn(CloudFormationClient.prototype, "send").mockImplementation((async (cmd: unknown) => {
    if (cmd instanceof DeleteStackCommand) {
      deletes.push({ ...cmd.input });
      deleted = true;
      return {};
    }
    if (cmd instanceof DescribeStacksCommand) {
      return {
        Stacks: [
          { StackId: ID, ...stack, StackStatus: deleted ? "DELETE_COMPLETE" : "CREATE_COMPLETE" },
        ],
      };
    }
    throw new Error(`unexpected ${String(cmd)}`);
  }) as never);
  return deletes;
}

async function runDelete(): Promise<void> {
  vi.useFakeTimers();
  const p = awsCloud("ap-northeast-1").deleteStack("flarelet-app-preview-pr-1", () => {});
  await vi.advanceTimersByTimeAsync(5000);
  await p;
}

describe("awsCloud().deleteStack", () => {
  it("deletes with the stack's CloudFormation service role (the cfn-exec role CDK deployed with)", async () => {
    const deletes = fakeCfn({ StackName: "flarelet-app-preview-pr-1", RoleARN: ROLE });
    await runDelete();
    expect(deletes).toEqual([{ StackName: ID, RoleARN: ROLE }]);
  });

  it("deletes without a role when the stack has none", async () => {
    const deletes = fakeCfn({ StackName: "flarelet-app-preview-pr-1" });
    await runDelete();
    expect(deletes).toEqual([{ StackName: ID }]);
  });
});
