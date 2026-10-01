import { rmSync } from "node:fs";
import { buildApp, type BuildOptions } from "./app.js";

export {
  buildApp,
  lwaLayerArn,
  LWA_LAYER_VERSION,
  type BuildOptions,
  type BuiltApp,
} from "./app.js";
export {
  domainPrefix,
  idpSecretName,
  secretsPath,
  sessionEpochParam,
  stackNames,
} from "./names.js";
export {
  AI_MODEL_NAMES,
  isKnownModel,
  resolveModel,
  UnknownModelError,
  type ResolvedModel,
} from "./ai-models.js";

export interface SynthesizedStack {
  name: string;
  /** stage: 永続ステージのリソース、version: バージョン固有、preview: PR preview の全部入り、dev: flareon dev 用。 */
  kind: "stage" | "version" | "preview" | "dev";
}

export interface SynthResult {
  outdir: string;
  stacks: SynthesizedStack[];
}

/** Cloud Assembly を outdir に書き出す。AWS には接続しない。 */
export function synthesize(o: BuildOptions & { outdir: string }): SynthResult {
  rmSync(o.outdir, { recursive: true, force: true });
  const { app, stage, version } = buildApp(o);
  app.synth();
  const stacks: SynthesizedStack[] = [];
  if (stage) stacks.push({ name: stage.stackName, kind: "stage" });
  stacks.push({
    name: version.stackName,
    kind: o.deployment.lifecycle === "ephemeral" ? "preview" : "version",
  });
  return { outdir: o.outdir, stacks };
}
