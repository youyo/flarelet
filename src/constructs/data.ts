import { CfnResource, RemovalPolicy, Stack } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { FlareletIR } from "../ir/index.js";

export type Lifetime = "retain" | "destroy";

export const removalOf = (l: Lifetime): RemovalPolicy =>
  l === "retain" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

/** database / storage の実体。persistent stage では RETAIN、PR preview では stack と共に破棄する。 */
export class Data extends Construct {
  readonly tables: Record<string, dynamodb.Table> = {};
  readonly buckets: Record<string, s3.Bucket> = {};

  constructor(scope: Construct, id: string, props: { ir: FlareletIR; lifetime: Lifetime }) {
    super(scope, id);
    const removalPolicy = removalOf(props.lifetime);
    for (const { name } of props.ir.databases) {
      this.tables[name] = new dynamodb.Table(this, `Database-${name}`, {
        partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy,
      });
    }
    for (const { name } of props.ir.storages) {
      this.buckets[name] = new s3.Bucket(this, `Storage-${name}`, {
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        enforceSSL: true,
        removalPolicy,
        autoDeleteObjects: props.lifetime === "destroy",
      });
    }
    if (props.lifetime === "destroy" && props.ir.storages.length) containAutoDeleteLogs(this);
  }
}

const AUTO_DELETE_PROVIDER = "Custom::S3AutoDeleteObjectsCustomResourceProvider";

/**
 * CDK の autoDeleteObjects プロバイダ Lambda（スタックに 1 つ）は暗黙のロググループ（/aws/lambda/...、保持期間なし）に書き、
 * スタック削除後もそれが残る。スタック内のロググループに向け、実行ロールからロググループ作成権限を外して
 * （AWSLambdaBasicExecutionRole の代わりに）削除後の再作成も防ぐ（app.ts の functionRole と同じ理由）。
 */
function containAutoDeleteLogs(scope: Construct): void {
  const stack = Stack.of(scope);
  const provider = stack.node.tryFindChild(AUTO_DELETE_PROVIDER);
  const handler = provider?.node.tryFindChild("Handler");
  const role = provider?.node.tryFindChild("Role");
  if (!(handler instanceof CfnResource) || !(role instanceof CfnResource)) {
    throw new Error(`internal: ${AUTO_DELETE_PROVIDER} not found`);
  }
  if (stack.node.tryFindChild("AutoDeleteLogs")) return;
  const lg = new logs.LogGroup(stack, "AutoDeleteLogs", {
    retention: logs.RetentionDays.ONE_WEEK,
    removalPolicy: RemovalPolicy.DESTROY,
  });
  handler.addPropertyOverride("LoggingConfig", { LogGroup: lg.logGroupName });
  role.addPropertyDeletionOverride("ManagedPolicyArns");
  role.addPropertyOverride("Policies", [
    {
      PolicyName: "WriteLogs",
      PolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
            Resource: lg.logGroupArn,
          },
        ],
      },
    },
  ]);
}
