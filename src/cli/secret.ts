import type { Cloud } from "../aws/cloud.js";
import { idpSecretName, secretsPath } from "../constructs/names.js";
import { idpNamesOf } from "./idp.js";
import { errorMessage, type OpsDeps } from "./ops.js";
import { resolveTarget, type SynthArgs, type Target } from "./synth.js";

export interface SecretArgs extends SynthArgs {
  name: string;
}

/**
 * 同じ stage の全 version の app Lambda に FLARELET_SECRETS_REVISION を設定して新しいコールドスタートを強制する。
 * ランチャーは起動時にだけ SSM を読むため。CFN から見るとドリフトだが、次の deploy で元に戻るだけ。
 */
async function restartStage(cloud: Cloud, t: Target, deps: OpsDeps): Promise<void> {
  const stacks = (await cloud.listAppStacks(t.ir.name)).filter(
    (s) =>
      s.tags["flarelet:stage"] === t.deployment.stage &&
      s.tags["flarelet:version"] !== undefined &&
      s.outputs.AppFunctionName !== undefined,
  );
  if (!stacks.length) {
    deps.io.stdout(`It will be applied on the next deploy to ${t.deployment.stage}.`);
    return;
  }
  const revision = String(deps.now());
  await Promise.all(
    stacks.map((s) =>
      cloud.updateFunctionEnv(s.outputs.AppFunctionName!, { FLARELET_SECRETS_REVISION: revision }),
    ),
  );
  const versions = stacks.map((s) => s.tags["flarelet:version"]!).sort();
  deps.io.stdout(`Restarted ${t.deployment.stage} (${versions.join(", ")}) to apply it.`);
}

function checkDeclared(t: Target, name: string, deps: OpsDeps): boolean {
  if (t.ir.secrets.includes(name)) return true;
  deps.io.stderr(
    `Error: secret ${name} is not declared in flarelet.yaml (declared: ${t.ir.secrets.join(", ") || "none"}); add it under \`secrets:\` first`,
  );
  return false;
}

export async function runSecretSet(args: SecretArgs, deps: OpsDeps): Promise<number> {
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const idp = idpNamesOf(t.ir).includes(args.name);
  if (!idp && !checkDeclared(t, args.name, deps)) return 1;
  const { io } = deps;
  let value: string;
  try {
    value = (await deps.readSecret(`Value for ${args.name}: `)).replace(/\r?\n$/, "");
  } catch (e) {
    io.stderr(`Error: cannot read the secret value: ${errorMessage(e)}`);
    return 1;
  }
  if (value === "") {
    io.stderr("Error: the secret value is empty");
    return 1;
  }
  try {
    const cloud = deps.cloud(t.region);
    if (idp) {
      // 外部 IdP の資格情報: Secrets Manager に置き、次の deploy で Cognito に反映する（アプリには渡さない）
      await cloud.putSecret(idpSecretName(t.ir.name, t.deployment.stage, args.name), value);
      io.stdout(`Set ${args.name} for ${t.ir.name} (${t.deployment.stage}) sign-in`);
      io.stdout(`Apply it with: flarelet deploy --stage ${t.deployment.stage}`);
      return 0;
    }
    await cloud.putParameter(`${secretsPath(t.ir.name, t.deployment.stage)}${args.name}`, value);
    io.stdout(`Set ${args.name} for ${t.ir.name} (${t.deployment.stage})`);
    await restartStage(cloud, t, deps);
    return 0;
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}

export async function runSecretList(args: SynthArgs, deps: OpsDeps): Promise<number> {
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const path = secretsPath(t.ir.name, t.deployment.stage);
  let params;
  const idpNames = idpNamesOf(t.ir);
  const idp = new Map<string, Date | undefined | null>();
  try {
    const cloud = deps.cloud(t.region);
    params = await cloud.listParameters(path);
    for (const n of idpNames) {
      const info = await cloud.describeSecret(idpSecretName(t.ir.name, t.deployment.stage, n));
      idp.set(n, info ? info.lastChanged : null);
    }
  } catch (e) {
    deps.io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
  const stored = new Map(params.map((p) => [p.name.slice(path.length), p]));
  const names = [...new Set([...t.ir.secrets, ...stored.keys(), ...idpNames])];
  if (!names.length) {
    deps.io.stdout(`No secrets for ${t.ir.name} (${t.deployment.stage})`);
    return 0;
  }
  const width = Math.max(...names.map((n) => n.length));
  deps.io.stdout(`Secrets for ${t.ir.name} (${t.deployment.stage})`);
  deps.io.stdout("");
  for (const n of names) {
    if (idp.has(n)) {
      const changed = idp.get(n);
      const state =
        changed === null ? "not set" : `set${changed ? `      ${changed.toISOString()}` : ""}`;
      deps.io.stdout(`  ${n.padEnd(width)}  ${state}  (sign-in credential)`);
      continue;
    }
    const p = stored.get(n);
    const state = p
      ? `set${p.lastModified ? `      ${p.lastModified.toISOString()}` : ""}`
      : "not set";
    const note = t.ir.secrets.includes(n) ? "" : "  (not declared in flarelet.yaml)";
    deps.io.stdout(`  ${n.padEnd(width)}  ${state}${note}`);
  }
  return 0;
}

export async function runSecretDelete(args: SecretArgs, deps: OpsDeps): Promise<number> {
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  try {
    const cloud = deps.cloud(t.region);
    if (idpNamesOf(t.ir).includes(args.name)) {
      if (!(await cloud.deleteSecret(idpSecretName(t.ir.name, t.deployment.stage, args.name)))) {
        deps.io.stderr(`Error: secret ${args.name} is not set for ${t.deployment.stage}`);
        return 1;
      }
      deps.io.stdout(`Deleted ${args.name} from ${t.ir.name} (${t.deployment.stage})`);
      return 0;
    }
    const ok = await cloud.deleteParameter(
      `${secretsPath(t.ir.name, t.deployment.stage)}${args.name}`,
    );
    if (!ok) {
      deps.io.stderr(`Error: secret ${args.name} is not set for ${t.deployment.stage}`);
      return 1;
    }
    deps.io.stdout(`Deleted ${args.name} from ${t.ir.name} (${t.deployment.stage})`);
    await restartStage(cloud, t, deps);
    return 0;
  } catch (e) {
    deps.io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
