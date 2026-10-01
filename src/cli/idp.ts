import type { Cloud } from "../aws/cloud.js";
import { idpSecretNames } from "../config/names.js";
import { domainPrefix, idpSecretName } from "../constructs/names.js";
import type { FlareletIR } from "../ir/index.js";
import type { Deployment } from "../resolver/index.js";

/**
 * 外部 IdP（Google / OIDC / Entra ID）の資格情報。値は Secrets Manager（`flarelet/{app}/{stage}/auth/{NAME}`）に置き、
 * CloudFormation の動的参照で Cognito に渡す。アプリには渡さない。
 */

/** 設定中の provider が要求する資格情報名（PR preview でも stage 単位の名前は同じ）。 */
export function idpNamesOf(ir: FlareletIR): string[] {
  const auth = ir.http?.auth;
  return auth?.enabled ? idpSecretNames(auth.provider) : [];
}

/** 外部 IdP を実際に作る（= 永続 stage にデプロイする）ときだけ資格情報が要る。 */
export const needsIdpSecrets = (ir: FlareletIR, d: Deployment): boolean =>
  d.lifecycle === "persistent" && idpNamesOf(ir).length > 0;

export interface IdpSecretState {
  /** 名前 → 現在のバージョン ID。 */
  versions: Record<string, string>;
  missing: string[];
}

export async function idpSecretState(
  cloud: Cloud,
  ir: FlareletIR,
  d: Deployment,
): Promise<IdpSecretState> {
  const versions: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of idpNamesOf(ir)) {
    const info = await cloud.describeSecret(idpSecretName(ir.name, d.stage, name));
    if (info) versions[name] = info.versionId;
    else missing.push(name);
  }
  return { versions, missing };
}

/** IdP 側（Google / Entra / OIDC のアプリ登録）に登録する Cognito のリダイレクト URI。 */
export function idpRedirectUri(
  ir: FlareletIR,
  d: Deployment,
  region: string,
  account: string,
): string {
  return `https://${domainPrefix(ir.name, d.stage, account)}.auth.${region}.amazoncognito.com/oauth2/idpresponse`;
}

export function missingIdpMessage(
  ir: FlareletIR,
  d: Deployment,
  missing: string[],
  redirectUri: string,
): string[] {
  const auth = ir.http?.auth;
  const provider = auth?.enabled ? auth.provider : "";
  return [
    `Error: sign-in with ${provider} needs ${missing.join(" and ")} for the ${d.stage} stage. Set ${missing.length > 1 ? "them" : "it"} first:`,
    ...missing.map((n) => `  flarelet secret set ${n} --stage ${d.stage}`),
    `Register this redirect URI with the ${provider} app: ${redirectUri}`,
  ];
}
