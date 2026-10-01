import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProgressEvent } from "../aws/iohost.js";
import { effectiveAuth } from "../ir/index.js";
import { ciPreflight } from "./ci.js";
import { idpRedirectUri, idpSecretState, missingIdpMessage, needsIdpSecrets } from "./idp.js";
import { errorMessage, formatDuration, type OpsDeps } from "./ops.js";
import { resolveTarget, synthAll, type SynthArgs, type Synthesized } from "./synth.js";

const VERB: Record<string, string> = {
  CREATE: "creating",
  UPDATE: "updating",
  DELETE: "removing",
  ROLLBACK: "rolling back",
  UPDATE_ROLLBACK: "rolling back",
};

function verbOf(status: string): string | undefined {
  const m = /^(UPDATE_ROLLBACK|ROLLBACK|CREATE|UPDATE|DELETE)_IN_PROGRESS$/.exec(status);
  return m ? VERB[m[1]!] : undefined;
}

/** 進捗イベントを簡潔な行にする。同じスタックの同じ概念は最初の 1 回だけ出す。 */
export function progressPrinter(
  s: Pick<Synthesized, "result" | "deployment">,
  out: (l: string) => void,
  err: (l: string) => void,
  now: () => number,
): (e: ProgressEvent) => void {
  const kinds = new Map(s.result.stacks.map((st) => [st.name, st.kind]));
  const seen = new Set<string>();
  const started = new Map<string, number>();
  const label = (stack: string): string => {
    const kind = kinds.get(stack);
    if (kind === "stage") return `stage resources (${s.deployment.stage})`;
    if (kind === "preview") return `preview ${s.deployment.version}`;
    if (kind === "dev") return `dev resources (${s.deployment.stage}/${s.deployment.version})`;
    return `version ${s.deployment.version}`;
  };
  return (e) => {
    switch (e.type) {
      case "assets":
        out("  Building and uploading application code");
        return;
      case "stack-start":
        started.set(e.stack, now());
        out(`  ${label(e.stack)}  ${e.stack}`);
        return;
      case "stack-end": {
        const t0 = started.get(e.stack);
        out(`    done${t0 !== undefined ? ` (${formatDuration(now() - t0)})` : ""}`);
        return;
      }
      case "resource": {
        if (e.status.endsWith("_FAILED")) {
          if (e.reason) err(`    x ${e.concept}: ${e.reason}`);
          return;
        }
        const verb = verbOf(e.status);
        const key = `${e.stack}/${e.concept}/${verb ?? ""}`;
        if (!verb || seen.has(key)) return;
        seen.add(key);
        out(`    ${e.concept}: ${verb}`);
        return;
      }
      case "error":
        // 失敗時の詳細は toolkit の例外として届くので、ここでは捨てる（冗長なため）
        return;
    }
  };
}

export async function runDeploy(args: SynthArgs, deps: OpsDeps): Promise<number> {
  const { io } = deps;
  if (args.ci) {
    const code = await ciPreflight("deploy", deps);
    if (code !== undefined) return code;
  }
  const t = await resolveTarget(args, deps);
  if (!t) return 1;
  const cloud = deps.cloud(t.region);
  let account: string;
  try {
    account = await cloud.account();
  } catch (e) {
    io.stderr(`Error: cannot reach AWS: ${errorMessage(e)}`);
    return 1;
  }

  let idpSecretVersions: Record<string, string> | undefined;
  if (needsIdpSecrets(t.ir, t.deployment)) {
    try {
      const st = await idpSecretState(cloud, t.ir, t.deployment);
      if (st.missing.length) {
        const uri = idpRedirectUri(t.ir, t.deployment, t.region, account);
        for (const l of missingIdpMessage(t.ir, t.deployment, st.missing, uri)) io.stderr(l);
        return 1;
      }
      idpSecretVersions = st.versions;
    } catch (e) {
      io.stderr(`Error: cannot read the sign-in credentials: ${errorMessage(e)}`);
      return 1;
    }
  }

  const t0 = deps.now();
  const s = await synthAll(
    { ...args, account, ...(idpSecretVersions ? { idpSecretVersions } : {}) },
    deps,
    t,
  );
  if (!s) return 1;
  const { deployment: d } = s;
  io.stdout(`Deploying ${s.appName} (${d.stage}/${d.version}) to ${account}/${s.region}`);
  io.stdout("");

  let stacks;
  try {
    stacks = await deps
      .deployer(s.region)
      .deploy(s.outdir, progressPrinter(s, io.stdout, io.stderr, deps.now));
  } catch (e) {
    io.stderr("");
    io.stderr(`Deployment failed: ${errorMessage(e)}`);
    return 1;
  }

  const versionStack = s.result.stacks.find((st) => st.kind !== "stage")?.name;
  const outputs = stacks.find((st) => st.name === versionStack)?.outputs ?? {};
  const url = outputs.ApiUrl?.replace(/\/+$/, "");

  io.stdout("");
  io.stdout(
    `Deployed ${s.appName} (${d.stage}/${d.version}) in ${formatDuration(deps.now() - t0)}`,
  );
  io.stdout("");
  if (url) io.stdout(`  URL   ${url}`);
  const eff = effectiveAuth(s.ir, d);
  if (eff) {
    if (eff.kind === "none") io.stdout("  Auth  none (public)");
    else if (eff.kind === "preview") {
      io.stdout(`  Auth  preview token${eff.forced ? " (forced for pull request previews)" : ""}`);
      io.stdout("");
      io.stdout(
        `  Open it with: flareon env url --pr ${d.version.replace(/^pr-/, "")} --with-token`,
      );
    } else if (eff.auth.provider !== "cognito") {
      io.stdout(`  Auth  sign-in with ${eff.auth.provider}`);
    } else {
      io.stdout("  Auth  sign-in required");
      io.stdout("");
      io.stdout(`  Add a user with: flareon auth user add <email> --stage ${d.stage}`);
    }
  }

  const metaFile = join(s.appDir, ".flareon", "metadata.json");
  const meta = JSON.parse(await readFile(metaFile, "utf8")) as Record<string, unknown>;
  await writeFile(
    metaFile,
    JSON.stringify(
      {
        ...meta,
        account,
        ...(url ? { url } : {}),
        deployedAt: new Date(deps.now()).toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  return 0;
}
