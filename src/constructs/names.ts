import { createHash } from "node:crypto";
import type { Deployment } from "../resolver/index.js";

export interface StackNames {
  /** 永続ステージのときだけ。PR preview は 1 スタックなので無い。 */
  stage: string | undefined;
  version: string;
}

export function stackNames(app: string, d: Deployment): StackNames {
  const stage = `flareon-${app}-${d.stage}`;
  return d.lifecycle === "ephemeral"
    ? { stage: undefined, version: `${stage}-${d.version}` }
    : { stage, version: `${stage}-${d.version}` };
}

const COGNITO_FORBIDDEN = ["aws", "amazon", "cognito"];

/**
 * Cognito ドメインプレフィックス `{app}-{stage}-{短縮ハッシュ}`。決定的。
 * アカウントが分かっていればハッシュに含め、別アカウントとの衝突を避ける。
 */
export function domainPrefix(app: string, stage: string, account?: string): string {
  const base = `${app}-${stage}`;
  const bad = COGNITO_FORBIDDEN.find((w) => base.includes(w));
  if (bad) {
    throw new Error(
      `cannot derive a Cognito domain prefix from "${base}": Cognito forbids "${bad}" in domain prefixes; rename the app`,
    );
  }
  const hash = createHash("sha256")
    .update(account ? `${app}/${stage}/${account}` : `${app}/${stage}`)
    .digest("hex")
    .slice(0, 6);
  return `${base}-${hash}`;
}

export const secretsPath = (app: string, stage: string): string =>
  `/flareon/${app}/${stage}/secrets/`;

/**
 * セッション世代の SSM パラメータ（String）。front Lambda はこのバージョンをセッションに入れ、変わったセッションを拒否する。
 * 永続 stage は stage スコープ（stage スタックが持つ）、PR preview は version スコープ（preview スタックが持つ）。
 */
export const sessionEpochParam = (app: string, d: Deployment): string =>
  d.lifecycle === "ephemeral"
    ? `/flareon/${app}/${d.stage}/auth/${d.version}/session-epoch`
    : `/flareon/${app}/${d.stage}/auth/session-epoch`;

/** 外部 IdP の資格情報（Secrets Manager のシークレット名）。stage スコープ。 */
export const idpSecretName = (app: string, stage: string, name: string): string =>
  `flareon/${app}/${stage}/auth/${name}`;
