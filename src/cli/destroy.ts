import type { Cloud } from "../aws/cloud.js";
import { SUPPORTED_AUTH_PROVIDERS } from "../config/index.js";
import { idpSecretNames } from "../config/names.js";
import { idpSecretName, secretsPath, stackNames } from "../constructs/names.js";
import { ciPreflight } from "./ci.js";
import { errorMessage, formatDuration, type OpsDeps } from "./ops.js";
import { resolveTarget, type SynthArgs } from "./synth.js";

export interface DestroyArgs extends SynthArgs {
  /** 永続 stage の stage スタック（DB/Storage/Auth、RETAIN）も物理削除する。--yes が必須。 */
  stageResources?: boolean;
  yes?: boolean;
}

/** stage スタックに RETAIN で残る、明示的に消す必要があるリソース型。 */
const RETAINED_TYPES = new Set([
  "AWS::DynamoDB::Table",
  "AWS::S3::Bucket",
  "AWS::Cognito::UserPool",
  "AWS::SecretsManager::Secret",
]);

async function deleteStack(
  cloud: Cloud,
  name: string,
  label: string,
  deps: OpsDeps,
): Promise<boolean> {
  const exists = await cloud.describeStack(name);
  if (!exists) {
    deps.io.stdout(`  ${label}  not deployed`);
    return false;
  }
  const t0 = deps.now();
  deps.io.stdout(`  ${label}  deleting ${name}`);
  await cloud.deleteStack(name, () => {});
  deps.io.stdout(`    done (${formatDuration(deps.now() - t0)})`);
  return true;
}

export async function runDestroy(args: DestroyArgs, deps: OpsDeps): Promise<number> {
  const { io } = deps;
  if (args.ci) {
    const code = await ciPreflight("destroy", deps);
    if (code !== undefined) return code;
  }
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const { ir, deployment: d } = t;
  const names = stackNames(ir.name, d);
  const cloud = deps.cloud(t.region);
  const wantStage = Boolean(args.stageResources) && names.stage !== undefined;

  if (wantStage && !args.yes) {
    io.stderr(
      `Error: --stage-resources permanently deletes the ${d.stage} stage's database, storage, users and secrets; add --yes to confirm`,
    );
    return 1;
  }

  try {
    if (wantStage) {
      const others = (await cloud.listAppStacks(ir.name)).filter(
        (s) =>
          s.tags["flarelet:stage"] === d.stage &&
          s.tags["flarelet:version"] !== undefined &&
          s.name !== names.version,
      );
      if (others.length) {
        const vs = others.map((s) => s.tags["flarelet:version"]).join(", ");
        io.stderr(
          `Error: other versions of ${d.stage} are still deployed (${vs}); destroy them first`,
        );
        return 1;
      }
    }

    io.stdout(`Destroying ${ir.name} (${d.stage}/${d.version})`);
    io.stdout("");
    const kind = d.lifecycle === "ephemeral" ? `preview ${d.version}` : `version ${d.version}`;
    await deleteStack(cloud, names.version, kind, deps);

    if (names.stage === undefined) return 0;
    if (!wantStage) {
      if (await cloud.describeStack(names.stage)) {
        io.stdout("");
        io.stdout(
          `Stage resources of ${d.stage} (database, storage, users, secrets) are kept. ` +
            `To delete them permanently: flarelet destroy --stage ${d.stage} --version ${d.version} --stage-resources --yes`,
        );
      }
      return 0;
    }

    const retained = (await cloud.describeStack(names.stage))
      ? (await cloud.listStackResources(names.stage)).filter((r) => RETAINED_TYPES.has(r.type))
      : [];
    await deleteStack(cloud, names.stage, `stage resources (${d.stage})`, deps);
    for (const r of retained) await cloud.deleteRetained(r);
    if (retained.length) io.stdout(`    removed ${retained.length} retained resource(s)`);

    const params = await cloud.listParameters(secretsPath(ir.name, d.stage));
    for (const p of params) await cloud.deleteParameter(p.name);
    if (params.length) io.stdout(`    removed ${params.length} secret(s)`);

    // 外部 IdP の資格情報（Secrets Manager、スタック外）。provider を変えた後でも残さないよう全種を対象にする
    let idp = 0;
    for (const p of SUPPORTED_AUTH_PROVIDERS) {
      for (const n of idpSecretNames(p)) {
        if (await cloud.deleteSecret(idpSecretName(ir.name, d.stage, n))) idp++;
      }
    }
    if (idp) io.stdout(`    removed ${idp} sign-in credential(s)`);
    return 0;
  } catch (e) {
    io.stderr(`Error: destroy failed: ${errorMessage(e)}`);
    return 1;
  }
}
