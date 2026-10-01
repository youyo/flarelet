import { randomBytes } from "node:crypto";
import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListStackResourcesCommand,
  type Stack,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
  StartLiveTailCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import {
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
  DeleteUserPoolCommand,
  DeleteUserPoolDomainCommand,
  DescribeUserPoolCommand,
  ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { DeleteTableCommand, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  IAMClient,
  ListOpenIDConnectProvidersCommand,
  ListRolesCommand,
} from "@aws-sdk/client-iam";
import {
  GetFunctionConfigurationCommand,
  LambdaClient,
  UpdateFunctionConfigurationCommand,
  waitUntilFunctionUpdatedV2,
} from "@aws-sdk/client-lambda";
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import {
  DeleteParameterCommand,
  GetParameterCommand,
  GetParametersByPathCommand,
  PutParameterCommand,
  SSMClient,
} from "@aws-sdk/client-ssm";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { Cloud, LogEvent, StackInfo, StackResource, UserInfo } from "./cloud.js";
import type { CfnTemplate } from "./concepts.js";

const errName = (e: unknown): string => (e instanceof Error ? e.name : "");
const isMissingStack = (e: unknown): boolean =>
  errName(e) === "ValidationError" && /does not exist/.test((e as Error).message);

/** Live Tail が返すロググループ識別子（`account:name` または ARN）からグループ名を取り出す。 */
export function groupFromIdentifier(id: string): string {
  const arn = /:log-group:(.+?)(?::\*)?$/.exec(id)?.[1];
  if (arn) return arn;
  return id.replace(/^\d{12}:/, "");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toInfo(s: Stack): StackInfo {
  return {
    name: s.StackName ?? "",
    status: s.StackStatus ?? "UNKNOWN",
    tags: Object.fromEntries((s.Tags ?? []).map((t) => [t.Key ?? "", t.Value ?? ""])),
    outputs: Object.fromEntries(
      (s.Outputs ?? []).map((o) => [o.OutputKey ?? "", o.OutputValue ?? ""]),
    ),
  };
}

/** AWS SDK v3 による Cloud 実装。 */
export function awsCloud(region: string): Cloud {
  const cfg = { region };
  const cfn = new CloudFormationClient(cfg);
  const sts = new STSClient(cfg);
  const ssm = new SSMClient(cfg);
  const sm = new SecretsManagerClient(cfg);
  const lambda = new LambdaClient(cfg);
  const logs = new CloudWatchLogsClient(cfg);
  const idp = new CognitoIdentityProviderClient(cfg);
  const ddb = new DynamoDBClient(cfg);
  const s3 = new S3Client(cfg);
  const iam = new IAMClient(cfg);

  async function describeStack(name: string): Promise<StackInfo | undefined> {
    try {
      const out = await cfn.send(new DescribeStacksCommand({ StackName: name }));
      const s = out.Stacks?.[0];
      return s ? toInfo(s) : undefined;
    } catch (e) {
      if (isMissingStack(e)) return undefined;
      throw e;
    }
  }

  async function emptyBucket(bucket: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const page = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          VersionIdMarker: versionMarker,
        }),
      );
      const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({
        Key: v.Key!,
        VersionId: v.VersionId,
      }));
      if (objects.length) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
      }
      if (!page.IsTruncated) return;
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
  }

  const ignore =
    (...names: string[]) =>
    (e: unknown) => {
      if (!names.includes(errName(e))) throw e;
    };

  return {
    async account() {
      const out = await sts.send(new GetCallerIdentityCommand({}));
      if (!out.Account) throw new Error("STS returned no account");
      return out.Account;
    },

    describeStack,

    async listAppStacks(app) {
      const out: StackInfo[] = [];
      let token: string | undefined;
      do {
        const page = await cfn.send(new DescribeStacksCommand({ NextToken: token }));
        for (const s of page.Stacks ?? []) {
          if (s.Tags?.some((t) => t.Key === "flarelet:app" && t.Value === app)) out.push(toInfo(s));
        }
        token = page.NextToken;
      } while (token);
      return out;
    },

    async listStacksWithTag(key) {
      const out: StackInfo[] = [];
      let token: string | undefined;
      do {
        const page = await cfn.send(new DescribeStacksCommand({ NextToken: token }));
        for (const s of page.Stacks ?? []) {
          if (s.Tags?.some((t) => t.Key === key)) out.push(toInfo(s));
        }
        token = page.NextToken;
      } while (token);
      return out;
    },

    async findOidcProvider(url) {
      const host = url.replace(/^https?:\/\//, "").replace(/\/+$/, "");
      const list = await iam.send(new ListOpenIDConnectProvidersCommand({}));
      for (const p of list.OpenIDConnectProviderList ?? []) {
        if (p.Arn?.endsWith(`:oidc-provider/${host}`)) return p.Arn;
      }
      return undefined;
    },

    async listRolesTrustingProvider(providerArn) {
      const out: string[] = [];
      let marker: string | undefined;
      do {
        const page = await iam.send(new ListRolesCommand({ Marker: marker }));
        for (const r of page.Roles ?? []) {
          // AssumeRolePolicyDocument は URL エンコードされた JSON
          const doc = decodeURIComponent(r.AssumeRolePolicyDocument ?? "");
          if (r.RoleName && doc.includes(providerArn)) out.push(r.RoleName);
        }
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return out;
    },

    async getTemplate(name) {
      try {
        const out = await cfn.send(
          new GetTemplateCommand({ StackName: name, TemplateStage: "Original" }),
        );
        return out.TemplateBody ? (JSON.parse(out.TemplateBody) as CfnTemplate) : undefined;
      } catch (e) {
        if (isMissingStack(e)) return undefined;
        throw e;
      }
    },

    async listStackResources(name) {
      const out: StackResource[] = [];
      let token: string | undefined;
      do {
        const page = await cfn.send(
          new ListStackResourcesCommand({ StackName: name, NextToken: token }),
        );
        for (const r of page.StackResourceSummaries ?? []) {
          if (r.PhysicalResourceId) {
            out.push({
              logicalId: r.LogicalResourceId ?? "",
              physicalId: r.PhysicalResourceId,
              type: r.ResourceType ?? "",
            });
          }
        }
        token = page.NextToken;
      } while (token);
      return out;
    },

    async deleteStack(name, onStatus) {
      const s = await cfn.send(new DescribeStacksCommand({ StackName: name }));
      const id = s.Stacks?.[0]?.StackId ?? name;
      // CDK が作成時に使った CloudFormation 実行ロール（cdk-<qualifier>-cfn-exec-role-*）で削除する。
      // CloudFormation はスタックに紐づくロールを省略時にも使うが、CI ロール（削除対象への直接権限なし、
      // cfn-exec の PassRole のみ）での削除経路を明示して、呼び出し元の資格情報に頼らないようにする。
      const roleArn = s.Stacks?.[0]?.RoleARN;
      await cfn.send(
        new DeleteStackCommand({ StackName: id, ...(roleArn ? { RoleARN: roleArn } : {}) }),
      );
      const deadline = Date.now() + 60 * 60_000;
      let last = "";
      while (Date.now() < deadline) {
        await sleep(3000);
        const out = await cfn.send(new DescribeStacksCommand({ StackName: id }));
        const status = out.Stacks?.[0]?.StackStatus ?? "DELETE_COMPLETE";
        if (status !== last) onStatus((last = status));
        if (status === "DELETE_COMPLETE") return;
        if (status === "DELETE_FAILED") {
          const ev = await cfn.send(new DescribeStackEventsCommand({ StackName: id }));
          const reason = ev.StackEvents?.find(
            (x) => x.ResourceStatus === "DELETE_FAILED" && x.LogicalResourceId !== name,
          )?.ResourceStatusReason;
          throw new Error(`failed to delete ${name}${reason ? `: ${reason}` : ""}`);
        }
      }
      throw new Error(`timed out waiting for ${name} to be deleted`);
    },

    async deleteRetained(r) {
      switch (r.type) {
        case "AWS::DynamoDB::Table":
          await ddb
            .send(new DeleteTableCommand({ TableName: r.physicalId }))
            // 削除中（ResourceInUseException）も削除済みとみなす
            .catch(ignore("ResourceNotFoundException", "ResourceInUseException"));
          return;
        case "AWS::S3::Bucket":
          try {
            await emptyBucket(r.physicalId);
            await s3.send(new DeleteBucketCommand({ Bucket: r.physicalId }));
          } catch (e) {
            ignore("NoSuchBucket")(e);
          }
          return;
        case "AWS::Cognito::UserPool":
          try {
            const pool = await idp.send(new DescribeUserPoolCommand({ UserPoolId: r.physicalId }));
            const domain = pool.UserPool?.Domain;
            if (domain) {
              await idp.send(
                new DeleteUserPoolDomainCommand({ UserPoolId: r.physicalId, Domain: domain }),
              );
            }
            await idp.send(new DeleteUserPoolCommand({ UserPoolId: r.physicalId }));
          } catch (e) {
            ignore("ResourceNotFoundException")(e);
          }
          return;
        case "AWS::SecretsManager::Secret":
          await sm
            .send(
              new DeleteSecretCommand({ SecretId: r.physicalId, ForceDeleteWithoutRecovery: true }),
            )
            .catch(ignore("ResourceNotFoundException"));
          return;
        default:
          throw new Error(`internal: cannot delete retained ${r.type}`);
      }
    },

    async bootstrapVersion(qualifier) {
      try {
        const out = await ssm.send(
          new GetParameterCommand({ Name: `/cdk-bootstrap/${qualifier}/version` }),
        );
        const v = Number(out.Parameter?.Value);
        return Number.isFinite(v) ? v : undefined;
      } catch (e) {
        if (errName(e) === "ParameterNotFound") return undefined;
        throw e;
      }
    },

    async getSecretValue(arn) {
      const out = await sm.send(new GetSecretValueCommand({ SecretId: arn }));
      if (out.SecretString === undefined) throw new Error(`secret ${arn} has no value`);
      return out.SecretString;
    },

    async putParameter(name, value) {
      await ssm.send(
        new PutParameterCommand({
          Name: name,
          Value: value,
          Type: "SecureString",
          Overwrite: true,
        }),
      );
    },

    async listParameters(path) {
      const out = [];
      let token: string | undefined;
      do {
        const page = await ssm.send(
          new GetParametersByPathCommand({
            Path: path.replace(/\/+$/, ""),
            Recursive: false,
            WithDecryption: false,
            NextToken: token,
          }),
        );
        for (const p of page.Parameters ?? []) {
          if (p.Name) out.push({ name: p.Name, lastModified: p.LastModifiedDate });
        }
        token = page.NextToken;
      } while (token);
      return out;
    },

    async rotateParameter(name) {
      try {
        await ssm.send(new GetParameterCommand({ Name: name }));
      } catch (e) {
        if (errName(e) === "ParameterNotFound") return false;
        throw e;
      }
      // 値は使わない（front はバージョンを見る）。書き換えでバージョンが進む
      await ssm.send(
        new PutParameterCommand({
          Name: name,
          Value: randomBytes(16).toString("hex"),
          Type: "String",
          Overwrite: true,
        }),
      );
      return true;
    },

    async deleteParameter(name) {
      try {
        await ssm.send(new DeleteParameterCommand({ Name: name }));
        return true;
      } catch (e) {
        if (errName(e) === "ParameterNotFound") return false;
        throw e;
      }
    },

    async updateFunctionEnv(name, vars) {
      for (let attempt = 0; ; attempt++) {
        try {
          await waitUntilFunctionUpdatedV2(
            { client: lambda, maxWaitTime: 300 },
            { FunctionName: name },
          );
          const cur = await lambda.send(
            new GetFunctionConfigurationCommand({ FunctionName: name }),
          );
          await lambda.send(
            new UpdateFunctionConfigurationCommand({
              FunctionName: name,
              Environment: { Variables: { ...(cur.Environment?.Variables ?? {}), ...vars } },
            }),
          );
          await waitUntilFunctionUpdatedV2(
            { client: lambda, maxWaitTime: 300 },
            { FunctionName: name },
          );
          return;
        } catch (e) {
          // 直前のデプロイ等で更新中だと競合する
          if (errName(e) !== "ResourceConflictException" || attempt >= 10) throw e;
          await sleep(3000);
        }
      }
    },

    async filterLogs(group, startTime, nextToken) {
      try {
        const out = await logs.send(
          new FilterLogEventsCommand({ logGroupName: group, startTime, nextToken }),
        );
        const events: LogEvent[] = (out.events ?? []).map((e) => ({
          id: e.eventId ?? `${e.timestamp}-${e.message}`,
          timestamp: e.timestamp ?? 0,
          message: e.message ?? "",
        }));
        return out.nextToken ? { events, nextToken: out.nextToken } : { events };
      } catch (e) {
        if (errName(e) === "ResourceNotFoundException") return { events: [] };
        throw e;
      }
    },

    async liveTail(groups, onEvent, signal, onStarted) {
      const account = (await sts.send(new GetCallerIdentityCommand({}))).Account;
      if (!account) throw new Error("STS returned no account");
      const arnOf = (g: string) => `arn:aws:logs:${region}:${account}:log-group:${g}`;
      const out = await logs.send(
        new StartLiveTailCommand({ logGroupIdentifiers: groups.map(arnOf) }),
        { abortSignal: signal },
      );
      if (!out.responseStream) throw new Error("Live Tail returned no stream");
      try {
        for await (const ev of out.responseStream) {
          if (ev.sessionStart) onStarted();
          for (const r of ev.sessionUpdate?.sessionResults ?? []) {
            const group = groupFromIdentifier(r.logGroupIdentifier ?? "");
            onEvent({ group, timestamp: r.timestamp ?? 0, message: r.message ?? "" });
          }
        }
      } catch (e) {
        if (!signal.aborted) throw e;
      }
    },

    async createUser(userPoolId, email) {
      await idp.send(
        new AdminCreateUserCommand({
          UserPoolId: userPoolId,
          Username: email,
          UserAttributes: [
            { Name: "email", Value: email },
            { Name: "email_verified", Value: "true" },
          ],
          DesiredDeliveryMediums: ["EMAIL"],
        }),
      );
    },

    async listUsers(userPoolId) {
      const out: UserInfo[] = [];
      let token: string | undefined;
      do {
        const page = await idp.send(
          new ListUsersCommand({ UserPoolId: userPoolId, PaginationToken: token }),
        );
        for (const u of page.Users ?? []) {
          out.push({
            email: u.Attributes?.find((a) => a.Name === "email")?.Value,
            status: u.UserStatus,
            enabled: u.Enabled,
            created: u.UserCreateDate,
          });
        }
        token = page.PaginationToken;
      } while (token);
      return out;
    },

    async deleteUser(userPoolId, email) {
      try {
        await idp.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: email }));
        return true;
      } catch (e) {
        if (errName(e) === "UserNotFoundException") return false;
        throw e;
      }
    },

    async describeSecret(name) {
      try {
        const out = await sm.send(new DescribeSecretCommand({ SecretId: name }));
        if (out.DeletedDate) return undefined;
        const current = Object.entries(out.VersionIdsToStages ?? {}).find(([, st]) =>
          st.includes("AWSCURRENT"),
        )?.[0];
        if (!current) return undefined;
        return { versionId: current, lastChanged: out.LastChangedDate };
      } catch (e) {
        if (errName(e) === "ResourceNotFoundException") return undefined;
        throw e;
      }
    },

    async putSecret(name, value) {
      try {
        await sm.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
      } catch (e) {
        if (errName(e) !== "ResourceNotFoundException") throw e;
        await sm.send(
          new CreateSecretCommand({
            Name: name,
            SecretString: value,
            Description: "Flarelet sign-in credential",
          }),
        );
      }
    },

    async deleteSecret(name) {
      try {
        await sm.send(
          new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }),
        );
        return true;
      } catch (e) {
        if (errName(e) === "ResourceNotFoundException") return false;
        throw e;
      }
    },

    async getFunctionEnv(name) {
      const out = await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: name }));
      return { ...(out.Environment?.Variables ?? {}) };
    },

    async getParameterValues(path) {
      const base = path.replace(/\/+$/, "");
      const out: Record<string, string> = {};
      let token: string | undefined;
      do {
        const page = await ssm.send(
          new GetParametersByPathCommand({
            Path: base,
            Recursive: false,
            WithDecryption: true,
            NextToken: token,
          }),
        );
        for (const p of page.Parameters ?? []) {
          if (p.Name && p.Value !== undefined) out[p.Name.slice(base.length + 1)] = p.Value;
        }
        token = page.NextToken;
      } while (token);
      return out;
    },
  };
}
