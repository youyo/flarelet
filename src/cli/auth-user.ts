import type { Cloud } from "../aws/cloud.js";
import { stackNames } from "../constructs/names.js";
import { errorMessage, type OpsDeps } from "./ops.js";
import { resolveTarget, type SynthArgs } from "./synth.js";

/**
 * Cognito User Pool のユーザー管理。User Pool は管理者作成のみ（セルフサインアップ無効）なので、
 * ログインできるユーザーはこのコマンドで招待する。
 */

export interface UserArgs extends SynthArgs {
  email: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function userPool(
  args: SynthArgs,
  deps: OpsDeps,
): Promise<{ cloud: Cloud; pool: string; stage: string } | null> {
  const t = await resolveTarget(args, deps);
  if (!t) return null;
  const { io } = deps;
  const names = stackNames(t.ir.name, t.deployment);
  if (names.stage === undefined) {
    io.stderr(
      `Error: PR previews use a preview token instead of users; open it with \`flareon env url --pr ${t.deployment.version.replace(/^pr-/, "")} --with-token\``,
    );
    return null;
  }
  if (!t.ir.http?.auth.enabled) {
    io.stderr("Error: authentication is disabled for this app (http.auth: false)");
    return null;
  }
  const cloud = deps.cloud(t.region);
  const pool = (await cloud.describeStack(names.stage))?.outputs.UserPoolId;
  if (!pool) {
    io.stderr(
      `Error: ${t.ir.name} (${t.deployment.stage}) is not deployed yet; run flareon deploy`,
    );
    return null;
  }
  return { cloud, pool, stage: t.deployment.stage };
}

export async function runUserAdd(args: UserArgs, deps: OpsDeps): Promise<number> {
  if (!EMAIL.test(args.email)) {
    deps.io.stderr(`Error: "${args.email}" is not a valid email address`);
    return 1;
  }
  try {
    const p = await userPool(args, deps);
    if (!p) return 1;
    await p.cloud.createUser(p.pool, args.email);
    deps.io.stdout(
      `Invited ${args.email} to ${p.stage}; a temporary password was sent by email (it must be changed at first sign-in)`,
    );
    return 0;
  } catch (e) {
    deps.io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}

export async function runUserList(args: SynthArgs, deps: OpsDeps): Promise<number> {
  try {
    const p = await userPool(args, deps);
    if (!p) return 1;
    const users = await p.cloud.listUsers(p.pool);
    if (!users.length) {
      deps.io.stdout(`No users in ${p.stage}`);
      return 0;
    }
    const width = Math.max(5, ...users.map((u) => (u.email ?? "-").length));
    deps.io.stdout(`${"EMAIL".padEnd(width)}  ${"STATUS".padEnd(21)}  ENABLED   CREATED`);
    for (const u of users) {
      deps.io.stdout(
        `${(u.email ?? "-").padEnd(width)}  ${(u.status ?? "-").padEnd(21)}  ${(u.enabled === false ? "disabled" : "enabled").padEnd(8)}  ${u.created?.toISOString() ?? "-"}`,
      );
    }
    return 0;
  } catch (e) {
    deps.io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}

export async function runUserRemove(args: UserArgs, deps: OpsDeps): Promise<number> {
  try {
    const p = await userPool(args, deps);
    if (!p) return 1;
    if (!(await p.cloud.deleteUser(p.pool, args.email))) {
      deps.io.stderr(`Error: user ${args.email} not found in ${p.stage}`);
      return 1;
    }
    deps.io.stdout(`Removed ${args.email} from ${p.stage}`);
    return 0;
  } catch (e) {
    deps.io.stderr(`Error: ${errorMessage(e)}`);
    return 1;
  }
}
