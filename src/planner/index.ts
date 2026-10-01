import { effectiveAuth, type FlareonIR } from "../ir/index.js";
import type { Deployment } from "../resolver/index.js";

export interface PlanItem {
  /** 既存状態との突き合わせキー（例: `database.main`）。 */
  key: string;
  label: string;
  action: "create" | "update" | "keep" | "delete";
}

/** デプロイ済みの状態（Flareon の概念キー単位）。 */
export interface PlanState {
  /** 既に存在するキー。 */
  existing: ReadonlySet<string>;
  /** 存在し、かつ変更されるキー。 */
  changed?: ReadonlySet<string>;
  /** デプロイ済みだが新しい構成には無いキー。 */
  removed?: ReadonlySet<string>;
}

export interface Plan {
  app: string;
  stage: string;
  version: string;
  lifecycle: Deployment["lifecycle"];
  verb: "create" | "update";
  items: PlanItem[];
  changes: number;
}

function describe(ir: FlareonIR, d: Deployment): { key: string; label: string }[] {
  const items = [{ key: "application", label: `application version ${d.version}` }];
  for (const db of ir.databases)
    items.push({ key: `database.${db.name}`, label: `database.${db.name}` });
  for (const s of ir.storages) items.push({ key: `storage.${s.name}`, label: `storage.${s.name}` });
  const auth = effectiveAuth(ir, d);
  if (auth) {
    const label =
      auth.kind === "none"
        ? "public endpoint (no authentication)"
        : auth.kind === "preview"
          ? auth.forced
            ? "preview authentication (forced for pull request previews)"
            : "preview authentication"
          : "authentication";
    items.push({ key: "authentication", label });
  }
  for (const m of ir.aiModels) items.push({ key: `ai.${m}`, label: `ai.${m}` });
  if (ir.secrets.length) {
    items.push({ key: "secrets", label: `secrets (${ir.secrets.join(", ")})` });
  }
  return items;
}

const SYMBOL: Record<PlanItem["action"], string> = {
  create: "+",
  update: "~",
  keep: "=",
  delete: "-",
};

/**
 * IR と解決済みデプロイからプランを作る。第 3 引数はデプロイ済みの状態（キー集合なら「存在するキー」）。
 * AWS に接続しない場合は空で、すべて「新規作成」になる。
 */
export function buildPlan(
  ir: FlareonIR,
  d: Deployment,
  state: ReadonlySet<string> | PlanState = new Set<string>(),
): Plan {
  const st: PlanState = state instanceof Set ? { existing: state } : (state as PlanState);
  const items: PlanItem[] = describe(ir, d).map((i) => ({
    ...i,
    action: !st.existing.has(i.key) ? "create" : st.changed?.has(i.key) ? "update" : "keep",
  }));
  const known = new Set(items.map((i) => i.key));
  for (const key of st.removed ?? []) {
    if (!known.has(key)) items.push({ key, label: key, action: "delete" });
  }
  const changes = items.filter((i) => i.action !== "keep").length;
  return {
    app: ir.name,
    stage: d.stage,
    version: d.version,
    lifecycle: d.lifecycle,
    verb: items.some((i) => i.action !== "create") ? "update" : "create",
    items,
    changes,
  };
}

export function renderPlan(p: Plan): string {
  const lines = [
    `Flareon will ${p.verb} ${p.app} (${p.stage}/${p.version})` +
      (p.lifecycle === "ephemeral" ? " [ephemeral preview]" : ""),
    "",
    ...p.items.map((i) => `  ${SYMBOL[i.action]} ${i.label}`),
    "",
    p.changes === 0 ? "No changes" : `${p.changes} ${p.changes === 1 ? "change" : "changes"}`,
    "",
    "Deploy with:",
    `  flareon deploy --stage ${p.stage} --version ${p.version}`,
    "",
  ];
  return lines.join("\n");
}
