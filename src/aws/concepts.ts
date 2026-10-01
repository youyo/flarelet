/**
 * CloudFormation / CDK の語彙を Flarelet の概念（`database.main`、`authentication` 等）に畳む。
 * plan の差分表示と deploy の進捗表示で共有する。AWS には接続しない。
 */

export interface CfnResource {
  Type?: string;
  Properties?: unknown;
  Metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CfnTemplate {
  Resources?: Record<string, CfnResource>;
  [k: string]: unknown;
}

const AUTH = new Set([
  "UserPool",
  "SessionSecret",
  "Client",
  "Branding",
  "PreviewToken",
  "IdentityProvider",
  "SessionEpoch",
]);
const APPLICATION = new Set([
  "AppFunction",
  "AppLogs",
  "AppRole",
  "FrontRole",
  "LambdaWebAdapter",
  "Api",
  "DefaultRoute",
  "FrontAuthFunction",
  "FrontLogs",
]);

/**
 * CDK のコンストラクトパスを Flarelet の概念キーにする。対応しなければ undefined。
 * テンプレートの `aws:cdk:path` は `<stack>/<id>/...`、toolkit-lib の進捗はスタック相対（`<id>/...`）。
 * Flarelet のスタック名は必ず `flarelet-` で始まり、コンストラクト ID は始まらないので区別できる。
 */
function segments(constructPath: string): string[] {
  const parts = constructPath.replace(/^\/+/, "").split("/");
  if (parts[0]?.startsWith("flarelet-")) parts.shift();
  return parts;
}

export function conceptOf(constructPath: string): string | undefined {
  const [top, sub] = segments(constructPath);
  if (top === undefined) return undefined;
  if (top === "Data" && sub) {
    const m = /^(Database|Storage)-(.+)$/.exec(sub);
    if (m) return `${m[1] === "Database" ? "database" : "storage"}.${m[2]}`;
    return undefined;
  }
  if (AUTH.has(top)) return "authentication";
  if (APPLICATION.has(top)) return "application";
  return undefined;
}

const pathOf = (r: CfnResource | undefined): string | undefined => {
  const p = r?.Metadata?.["aws:cdk:path"];
  return typeof p === "string" ? p : undefined;
};

/** app Lambda の環境変数からバインディング由来の概念（ai.* / secrets）を読む。 */
function envConcepts(r: CfnResource, path: string | undefined): string[] {
  if (r.Type !== "AWS::Lambda::Function" || !path) return [];
  if (segments(path)[0] !== "AppFunction") return [];
  const vars = (r.Properties as { Environment?: { Variables?: Record<string, unknown> } })
    ?.Environment?.Variables;
  if (!vars) return [];
  const out: string[] = [];
  for (const k of Object.keys(vars)) {
    const m = /^FLARELET_AI_(.+)_MODEL_ID$/.exec(k);
    if (m) out.push(`ai.${m[1]!.toLowerCase().replace(/_/g, "-")}`);
    if (k === "FLARELET_SECRETS_PATH") out.push("secrets");
  }
  return out;
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** Metadata を除いた、比較用のリソース表現。 */
function comparable(r: CfnResource): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { Metadata, ...rest } = r;
  return stableJson(rest);
}

export interface ConceptState {
  existing: Set<string>;
  changed: Set<string>;
  removed: Set<string>;
}

/** 新旧テンプレートの組（スタックごと。prev が undefined なら未デプロイ）から概念単位の差分を作る。 */
export function diffTemplates(
  pairs: { next: CfnTemplate; prev: CfnTemplate | undefined }[],
): ConceptState {
  const existing = new Set<string>();
  const changed = new Set<string>();
  const nextKeys = new Set<string>();

  for (const { next, prev } of pairs) {
    const nr = next.Resources ?? {};
    const pr = prev?.Resources ?? {};
    for (const [id, r] of Object.entries(nr)) {
      const path = pathOf(r);
      const c = path ? conceptOf(path) : undefined;
      if (c) nextKeys.add(c);
      for (const e of envConcepts(r, path)) nextKeys.add(e);
      const old = pr[id];
      if (c && (old === undefined || comparable(old) !== comparable(r))) {
        if (prev) changed.add(c);
      }
    }
    for (const [id, r] of Object.entries(pr)) {
      const path = pathOf(r) ?? pathOf(nr[id]);
      const c = path ? conceptOf(path) : undefined;
      if (c) {
        existing.add(c);
        if (!(id in nr)) changed.add(c);
      }
      for (const e of envConcepts(r, path)) existing.add(e);
    }
  }

  const removed = new Set([...existing].filter((k) => !nextKeys.has(k)));
  for (const k of [...changed]) if (!existing.has(k)) changed.delete(k);
  return { existing, changed, removed };
}
