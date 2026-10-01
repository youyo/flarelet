// flareon logs --follow（CloudWatch Logs Live Tail）の遅延計測。
// 軽量なテスト用スタック（Lambda + ロググループ + Outputs）を CloudFormation で直接作り、flareon.yaml の
// アプリ名に対応するスタック名（flareon-<app>-prod-v1）にして CLI から読む。
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CloudFormationClient,
  CreateStackCommand,
  DeleteStackCommand,
  waitUntilStackCreateComplete,
  waitUntilStackDeleteComplete,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  DescribeLogGroupsCommand,
  FilterLogEventsCommand,
  PutLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cliStream,
  ENABLED,
  eventually,
  log,
  LONG,
  REGION,
  removeDir,
  stackOutputs,
  uniqueName,
} from "./helpers.js";

const cfn = new CloudFormationClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });
const lambda = new LambdaClient({ region: REGION });

const TEMPLATE = {
  Resources: {
    Role: {
      Type: "AWS::IAM::Role",
      Properties: {
        AssumeRolePolicyDocument: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        },
        ManagedPolicyArns: ["arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"],
      },
    },
    AppLogs: {
      Type: "AWS::Logs::LogGroup",
      DeletionPolicy: "Delete",
      Properties: { RetentionInDays: 1 },
    },
    Fn: {
      Type: "AWS::Lambda::Function",
      Properties: {
        Runtime: "nodejs22.x",
        Handler: "index.handler",
        Role: { "Fn::GetAtt": ["Role", "Arn"] },
        Code: {
          ZipFile:
            'exports.handler = async (e) => { console.log("e2e-live " + e.marker); return {}; };',
        },
        LoggingConfig: { LogGroup: { Ref: "AppLogs" } },
      },
    },
  },
  Outputs: {
    AppLogGroup: { Value: { Ref: "AppLogs" } },
    FnName: { Value: { Ref: "Fn" } },
  },
};

/** マーカーを含むイベントを CloudWatch Logs が受理した時刻（ingestionTime、エポックミリ秒）。 */
async function ingestionTime(group: string, marker: string, since: number): Promise<number> {
  return eventually(
    async () => {
      const out = await logs.send(
        new FilterLogEventsCommand({
          logGroupName: group,
          filterPattern: `"${marker}"`,
          startTime: since - 60_000,
        }),
      );
      return out.events?.[0]?.ingestionTime;
    },
    60_000,
    500,
  );
}

const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe.runIf(ENABLED)("real AWS: logs --follow uses Live Tail", () => {
  const app = uniqueName("logs");
  const stack = `flareon-${app}-prod-v1`;
  let dir: string;
  let group: string;
  let fn: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "flareon-logs-e2e-"));
    await writeFile(
      join(dir, "flareon.yaml"),
      `version: 1\nname: ${app}\nruntime: { language: python }\nhttp: true\n`,
    );
    await cfn.send(
      new CreateStackCommand({
        StackName: stack,
        TemplateBody: JSON.stringify(TEMPLATE),
        Capabilities: ["CAPABILITY_IAM"],
        Tags: [{ Key: "flareon:e2e", Value: "logs-follow" }],
      }),
    );
    await waitUntilStackCreateComplete({ client: cfn, maxWaitTime: 600 }, { StackName: stack });
    const out = (await stackOutputs(stack))!;
    group = out.AppLogGroup!;
    fn = out.FnName!;
    log(`test stack ${stack} ready (log group ${group})`);
  }, LONG);

  afterAll(async () => {
    try {
      if (await stackOutputs(stack)) {
        await cfn.send(new DeleteStackCommand({ StackName: stack }));
        await waitUntilStackDeleteComplete({ client: cfn, maxWaitTime: 600 }, { StackName: stack });
      }
    } finally {
      await removeDir(dir);
    }
    expect(await stackOutputs(stack), "test stack left over").toBeUndefined();
    const left = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group }));
    expect((left.logGroups ?? []).filter((g) => g.logGroupName === group)).toEqual([]);
  }, LONG);

  it(
    "shows new lines within seconds without polling",
    async () => {
      const lines: { at: number; line: string }[] = [];
      let stderr = "";
      const child = cliStream(
        ["logs", "--stage", "prod", "--version", "v1", "--since", "1m", "--follow"],
        dir,
        (line) => lines.push({ at: Date.now(), line }),
        (c) => (stderr += c),
      );
      const seen = (text: string) => lines.find((l) => l.line.includes(text));
      try {
        // ライブテイルのセッションが張られるまで、起動確認用の呼び出しを繰り返す
        let n = 0;
        await eventually(
          async () => {
            await lambda.send(
              new InvokeCommand({
                FunctionName: fn,
                Payload: JSON.stringify({ marker: `warm${n++}` }),
              }),
            );
            await new Promise((r) => setTimeout(r, 1500));
            return seen("e2e-live warm") ? true : undefined;
          },
          90_000,
          100,
        );
        await new Promise((r) => setTimeout(r, 3000));

        // 1) Lambda のログ。Lambda → CloudWatch Logs の配信（AWS 側、数秒〜10 秒程度）は CLI の遅延ではないので、
        //    CloudWatch Logs がイベントを受理した時刻（ingestionTime。API から見えるようになった時刻）→ CLI 表示を測る。
        //    invoke → 表示の通し時間は参考値として記録だけする
        const fromIngest: number[] = [];
        const fromInvoke: number[] = [];
        for (let i = 0; i < 3; i++) {
          const marker = `m${i}-${Date.now()}`;
          await lambda.send(
            new InvokeCommand({ FunctionName: fn, Payload: JSON.stringify({ marker }) }),
          );
          const sentAt = Date.now();
          const hit = await eventually(async () => seen(`e2e-live ${marker}`), 60_000, 50);
          fromInvoke.push(hit.at - sentAt);
          const ingestedAt = await ingestionTime(group, marker, sentAt);
          fromIngest.push(hit.at - ingestedAt);
          await new Promise((r) => setTimeout(r, 2000));
        }

        // 2) CloudWatch Logs への書き込み完了 → CLI の遅延（CLI / Live Tail 側だけ）
        const streamName = `e2e-${Date.now()}`;
        await logs.send(
          new CreateLogStreamCommand({ logGroupName: group, logStreamName: streamName }),
        );
        const fromPut: number[] = [];
        for (let i = 0; i < 5; i++) {
          const marker = `put${i}-${Date.now()}`;
          const ts = Date.now();
          await logs.send(
            new PutLogEventsCommand({
              logGroupName: group,
              logStreamName: streamName,
              logEvents: [{ timestamp: ts, message: `e2e-live ${marker}` }],
            }),
          );
          const sentAt = Date.now();
          const hit = await eventually(async () => seen(`e2e-live ${marker}`), 60_000, 25);
          fromPut.push(hit.at - sentAt);
          await new Promise((r) => setTimeout(r, 1000));
        }
        log(`Lambda invoke returned -> shown (reference, ms): ${fromInvoke.join(", ")}`);
        log(`Lambda log ingested by CloudWatch -> shown (ms): ${fromIngest.join(", ")}`);
        log(`PutLogEvents returned -> shown (ms): ${fromPut.join(", ")}`);
        log(`median: ingest ${median(fromIngest)}ms, put ${median(fromPut)}ms`);

        // 目標: CloudWatch Logs に入ってから CLI に表示されるまで 3 秒以内（ネットワークのゆらぎ用に中央値で判定）。
        // ingestionTime は AWS の時計なので、ローカル時計とのずれ（NTP 同期で通常数百 ms 以内）を含む
        expect(median(fromPut)).toBeLessThan(3000);
        expect(median(fromIngest)).toBeLessThan(3000);
        expect(stderr).not.toMatch(/polling/);
        // ライブテイル利用時はポーリングしないので、同じ行が重複して出ない
        const warm0 = lines.filter((l) => l.line.includes("e2e-live warm0"));
        expect(warm0.length).toBeLessThanOrEqual(1);
      } finally {
        child.kill("SIGINT");
      }
    },
    LONG,
  );
});
