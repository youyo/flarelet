import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createHandler } from "./router.js";
import type { ApiEvent, ApiResult, AuthDeps } from "./types.js";

function realDeps(): AuthDeps {
  const lambda = new LambdaClient({});
  const secrets = new SecretsManagerClient({});
  return {
    now: () => Date.now(),
    fetch: (input, init) => fetch(input, init),
    async getSecret(arn) {
      const out = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
      if (out.SecretString === undefined) throw new Error(`secret ${arn} has no SecretString`);
      return out.SecretString;
    },
    async invoke(functionName, payload) {
      const out = await lambda.send(
        new InvokeCommand({
          FunctionName: functionName,
          InvocationType: "RequestResponse",
          Payload: payload,
        }),
      );
      const result: { functionError?: string; payload: string } = {
        payload: out.Payload ? Buffer.from(out.Payload).toString("utf8") : "",
      };
      if (out.FunctionError) result.functionError = out.FunctionError;
      return result;
    },
  };
}

let inner: ((event: ApiEvent) => Promise<ApiResult>) | undefined;

/** front auth Lambda のエントリ。設定は初回（コールドスタート）にパースして保持する。 */
export async function handler(event: ApiEvent): Promise<ApiResult> {
  inner ??= createHandler(process.env, realDeps());
  return inner(event);
}
