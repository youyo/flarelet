import { RemovalPolicy } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";
import type { FlareonIR } from "../ir/index.js";

export type Lifetime = "retain" | "destroy";

export const removalOf = (l: Lifetime): RemovalPolicy =>
  l === "retain" ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

/** database / storage の実体。persistent stage では RETAIN、PR preview では stack と共に破棄する。 */
export class Data extends Construct {
  readonly tables: Record<string, dynamodb.Table> = {};
  readonly buckets: Record<string, s3.Bucket> = {};

  constructor(scope: Construct, id: string, props: { ir: FlareonIR; lifetime: Lifetime }) {
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
  }
}
