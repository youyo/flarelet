import { App, CfnOutput, Stack } from "aws-cdk-lib";
import { rmSync } from "node:fs";
import type { FlareletIR } from "../ir/index.js";
import type { Deployment } from "../resolver/index.js";
import { bindingEnvName } from "../runtime/env.js";
import { Data } from "./data.js";
import type { SynthResult } from "./index.js";
import { stackNames } from "./names.js";

/**
 * `flarelet dev` 用の環境（既定 `preview/local-<user>`）。DB / Storage だけを 1 スタックに作り、
 * スタック削除で消えるようにする（`flarelet destroy --stage preview --version local-<user>`）。
 * バインディングの値は JSON の出力 `Bindings`（環境変数名 → 値）で返す。
 */
export interface DevBuildOptions {
  ir: FlareletIR;
  deployment: Deployment;
  region: string;
  account?: string;
  outdir?: string;
}

export function buildDevApp(o: DevBuildOptions): { app: App; stack: Stack } {
  const app = new App({
    ...(o.outdir ? { outdir: o.outdir } : {}),
    analyticsReporting: false,
    context: { "aws:cdk:enable-path-metadata": true },
  });
  const name = stackNames(o.ir.name, o.deployment).version;
  const stack = new Stack(app, name, {
    stackName: name,
    env: { region: o.region, ...(o.account ? { account: o.account } : {}) },
    description: `Flarelet dev resources for ${o.ir.name} (${o.deployment.stage}/${o.deployment.version})`,
    tags: {
      "flarelet:app": o.ir.name,
      "flarelet:stage": o.deployment.stage,
      "flarelet:version": o.deployment.version,
      "flarelet:lifecycle": "dev",
    },
  });
  const data = new Data(stack, "Data", { ir: o.ir, lifetime: "destroy" });
  const bindings: Record<string, string> = {};
  for (const [n, t] of Object.entries(data.tables)) {
    bindings[bindingEnvName("DATABASE", n, "TABLE")] = t.tableName;
  }
  for (const [n, b] of Object.entries(data.buckets)) {
    bindings[bindingEnvName("STORAGE", n, "BUCKET")] = b.bucketName;
  }
  new CfnOutput(stack, "Bindings", { value: stack.toJsonString(bindings) });
  return { app, stack };
}

export function synthesizeDev(o: DevBuildOptions & { outdir: string }): SynthResult {
  rmSync(o.outdir, { recursive: true, force: true });
  const { app, stack } = buildDevApp(o);
  app.synth();
  return { outdir: o.outdir, stacks: [{ name: stack.stackName, kind: "dev" }] };
}
