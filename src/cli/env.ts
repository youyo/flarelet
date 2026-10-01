import { stackNames } from "../constructs/names.js";
import { loadIR } from "./load.js";
import { errorMessage, type OpsDeps } from "./ops.js";
import { regionOf, resolveTarget, type SynthArgs } from "./synth.js";

const PREVIEW_AUTH_PATH = "/__flareon/auth/preview";

/** CloudFormation のスタック状態を Flareon の状態にする。 */
export function statusOf(cfn: string): string {
  if (cfn === "DELETE_IN_PROGRESS") return "deleting";
  if (/ROLLBACK_COMPLETE$|_FAILED$/.test(cfn)) return "failed";
  if (cfn.endsWith("_IN_PROGRESS")) return "deploying";
  if (cfn.endsWith("_COMPLETE")) return "ready";
  return cfn.toLowerCase();
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]! + 2)))
      .join("")
      .trimEnd(),
  );
}

export async function runEnvList(
  args: Pick<SynthArgs, "file" | "region">,
  deps: OpsDeps,
): Promise<number> {
  const ir = await loadIR(args.file, deps.io);
  if (!ir) return 1;
  let stacks;
  try {
    stacks = await deps.cloud(regionOf(args, deps.env)).listAppStacks(ir.name);
  } catch (e) {
    deps.io.stderr(`Error: cannot list environments: ${errorMessage(e)}`);
    return 1;
  }
  const versions = stacks
    .filter((s) => s.tags["flareon:version"] !== undefined)
    .map((s) => {
      const version = s.tags["flareon:version"]!;
      const type =
        s.tags["flareon:lifecycle"] ?? (/^pr-\d+$/.test(version) ? "ephemeral" : "persistent");
      return [
        s.tags["flareon:stage"] ?? "-",
        version,
        type,
        s.tags["flareon:branch"] ?? "-",
        statusOf(s.status),
        s.outputs.ApiUrl ?? "-",
      ];
    })
    .sort((a, b) => a[0]!.localeCompare(b[0]!) || a[1]!.localeCompare(b[1]!));
  if (!versions.length) {
    deps.io.stdout(`No environments deployed for ${ir.name}`);
    return 0;
  }
  for (const l of table([["STAGE", "VERSION", "TYPE", "BRANCH", "STATUS", "URL"], ...versions])) {
    deps.io.stdout(l);
  }
  return 0;
}

export interface EnvUrlArgs extends SynthArgs {
  withToken?: boolean;
}

export async function runEnvUrl(args: EnvUrlArgs, deps: OpsDeps): Promise<number> {
  const { io } = deps;
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const name = stackNames(t.ir.name, t.deployment).version;
  const label = `${t.deployment.stage}/${t.deployment.version}`;
  try {
    const cloud = deps.cloud(t.region);
    const stack = await cloud.describeStack(name);
    const url = stack?.outputs.ApiUrl?.replace(/\/+$/, "");
    if (!stack || !url) {
      io.stderr(`Error: ${t.ir.name} (${label}) is not deployed`);
      return 1;
    }
    if (!args.withToken) {
      io.stdout(url);
      return 0;
    }
    const arn = stack.outputs.PreviewTokenSecretArn;
    if (!arn) {
      io.stderr(`Error: --with-token is only available for PR previews (${label} is not one)`);
      return 1;
    }
    const token = (await cloud.getSecretValue(arn)).trim();
    io.stdout(`${url}${PREVIEW_AUTH_PATH}?token=${encodeURIComponent(token)}`);
    return 0;
  } catch (e) {
    io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
