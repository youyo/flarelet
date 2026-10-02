// awsCloud().deleteRetained: 削除保護付き DynamoDB テーブル（永続 stage の Data）も --stage-resources で消せる。
import { DeleteTableCommand, DynamoDBClient, UpdateTableCommand } from "@aws-sdk/client-dynamodb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awsCloud } from "../../src/aws/real.js";

afterEach(() => vi.restoreAllMocks());

const table = { logicalId: "T", physicalId: "tbl", type: "AWS::DynamoDB::Table" };

function fakeDdb(opts: { missing?: boolean } = {}) {
  const sent: { name: string; input: unknown }[] = [];
  vi.spyOn(DynamoDBClient.prototype, "send").mockImplementation((async (cmd: unknown) => {
    const name = (cmd as { constructor: { name: string } }).constructor.name;
    sent.push({ name, input: (cmd as { input: unknown }).input });
    if (opts.missing) {
      throw Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
    }
    return {};
  }) as never);
  return sent;
}

describe("awsCloud().deleteRetained (DynamoDB)", () => {
  it("disables deletion protection before deleting the table", async () => {
    const sent = fakeDdb();
    await awsCloud("ap-northeast-1").deleteRetained(table);
    expect(sent.map((s) => s.name)).toEqual([UpdateTableCommand.name, DeleteTableCommand.name]);
    expect(sent[0]?.input).toEqual({ TableName: "tbl", DeletionProtectionEnabled: false });
    expect(sent[1]?.input).toEqual({ TableName: "tbl" });
  });

  it("ignores a table that is already gone", async () => {
    fakeDdb({ missing: true });
    await expect(awsCloud("ap-northeast-1").deleteRetained(table)).resolves.toBeUndefined();
  });
});
