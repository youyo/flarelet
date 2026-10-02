import { Duration, Stack, Token } from "aws-cdk-lib";
import type * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as sns from "aws-cdk-lib/aws-sns";
import type { Construct } from "constructs";

/**
 * opt-in の CloudWatch アラーム。しきい値は固定（yaml では調整できない。DECISIONS.md）。
 * SNS トピックは作らず、利用者の既存トピックを使う。永続 stage だけで呼ぶこと（呼び出し側の責務）。
 */
const PERIOD = Duration.minutes(5);
const LAMBDA_ERRORS_THRESHOLD = 5;
const API_5XX_THRESHOLD = 5;

/**
 * SystemErrors を合算する操作。CloudWatch のアラームは数式内のメトリクスが 10 個まで（超えると synth エラー）なので、
 * 10 操作に絞る（PartiQL・GetRecords は含めない。DynamoDB Streams は使わない）。
 */
const ALARM_OPERATIONS = [
  dynamodb.Operation.GET_ITEM,
  dynamodb.Operation.PUT_ITEM,
  dynamodb.Operation.UPDATE_ITEM,
  dynamodb.Operation.DELETE_ITEM,
  dynamodb.Operation.QUERY,
  dynamodb.Operation.SCAN,
  dynamodb.Operation.BATCH_GET_ITEM,
  dynamodb.Operation.BATCH_WRITE_ITEM,
  dynamodb.Operation.TRANSACT_GET_ITEMS,
  dynamodb.Operation.TRANSACT_WRITE_ITEMS,
];

export class AlarmSet {
  private readonly action: cw_actions.SnsAction;

  constructor(
    private readonly scope: Construct,
    topicArn: string,
    private readonly namePrefix: string,
  ) {
    assertSameRegion(topicArn, Stack.of(scope));
    this.action = new cw_actions.SnsAction(sns.Topic.fromTopicArn(scope, "AlertsTopic", topicArn));
  }

  private add(
    id: string,
    suffix: string,
    description: string,
    metric: cloudwatch.IMetric,
    threshold: number,
  ): void {
    const alarm = new cloudwatch.Alarm(this.scope, id, {
      alarmName: `${this.namePrefix}-${suffix}`,
      alarmDescription: description,
      metric,
      threshold,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(this.action);
    alarm.addOkAction(this.action);
  }

  lambda(id: string, label: string, fn: lambda.IFunction): void {
    const opts = { period: PERIOD, statistic: "Sum" };
    this.add(
      `${id}Errors`,
      `${label}-errors`,
      `The ${label} Lambda function reported ${LAMBDA_ERRORS_THRESHOLD} or more errors in 5 minutes.`,
      fn.metricErrors(opts),
      LAMBDA_ERRORS_THRESHOLD,
    );
    this.add(
      `${id}Throttles`,
      `${label}-throttles`,
      `The ${label} Lambda function was throttled in the last 5 minutes.`,
      fn.metricThrottles(opts),
      1,
    );
  }

  /** HTTP API の 5xx（AWS/ApiGateway、次元 ApiId + Stage）。 */
  httpApi(api: apigwv2.HttpApi): void {
    this.add(
      "AlarmApi5xx",
      "api-5xx",
      `The HTTP API returned ${API_5XX_THRESHOLD} or more 5xx responses in 5 minutes.`,
      new cloudwatch.Metric({
        namespace: "AWS/ApiGateway",
        metricName: "5xx",
        dimensionsMap: { ApiId: api.apiId, Stage: "$default" },
        period: PERIOD,
        statistic: "Sum",
      }),
      API_5XX_THRESHOLD,
    );
  }

  /**
   * SystemErrors は TableName + Operation の組でしか発行されない（TableName だけの次元では常にデータ無し）ので、
   * CDK の操作ごとの合計式を使う。スロットルは ReadThrottleEvents + WriteThrottleEvents（TableName 次元）。
   */
  table(name: string, table: dynamodb.Table): void {
    const opts = { period: PERIOD, statistic: "Sum" };
    this.add(
      `AlarmDatabase-${name}SystemErrors`,
      `database-${name}-system-errors`,
      `The DynamoDB table "${name}" returned system errors (HTTP 500) in the last 5 minutes.`,
      table.metricSystemErrorsForOperations({ ...opts, operations: ALARM_OPERATIONS }),
      1,
    );
    const metric = (metricName: string) =>
      new cloudwatch.Metric({
        namespace: "AWS/DynamoDB",
        metricName,
        dimensionsMap: { TableName: table.tableName },
        ...opts,
      });
    this.add(
      `AlarmDatabase-${name}Throttles`,
      `database-${name}-throttles`,
      `The DynamoDB table "${name}" throttled read or write requests in the last 5 minutes.`,
      new cloudwatch.MathExpression({
        expression: "reads + writes",
        usingMetrics: {
          reads: metric("ReadThrottleEvents"),
          writes: metric("WriteThrottleEvents"),
        },
        period: PERIOD,
        label: "ReadThrottleEvents + WriteThrottleEvents",
      }),
      1,
    );
  }
}

/** アラームアクションは同じリージョンの SNS トピックにしか届かない。どちらも具体的に分かるときだけ検査する。 */
function assertSameRegion(topicArn: string, stack: Stack): void {
  const topicRegion = topicArn.split(":")[3];
  if (!topicRegion || Token.isUnresolved(topicRegion) || Token.isUnresolved(stack.region)) return;
  if (topicRegion !== stack.region) {
    throw new Error(
      `alerts.topicArn is in ${topicRegion} but the stack deploys to ${stack.region}; CloudWatch alarm actions require an SNS topic in the same region`,
    );
  }
}
