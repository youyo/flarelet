import type { FlareonIR } from "../ir/index.js";
import type { Deployment } from "../resolver/index.js";

export interface PlanItem {
  /** 既存状態との突き合わせキー（例: `database.main`）。 */
  key: string;
  label: string;
  action: "create" | "keep";
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
  if (ir.http) {
    if (!ir.http.auth.enabled) {
      items.push({ key: "authentication", label: "public endpoint (no authentication)" });
    } else {
      items.push({
        key: "authentication",
        label: d.lifecycle === "ephemeral" ? "preview authentication" : "authentication",
      });
    }
  }
  for (const m of ir.aiModels) items.push({ key: `ai.${m}`, label: `ai.${m}` });
  if (ir.secrets.length) {
    items.push({ key: "secrets", label: `secrets (${ir.secrets.join(", ")})` });
  }
  return items;
}

/**
 * IR と解決済みデプロイからプランを作る。`existing` は既に存在するキー（将来、デプロイ済みスタックとの
 * 差分から得る）。AWS 接続が無い段階では空で、すべて「新規作成」になる。
 */
export function buildPlan(
  ir: FlareonIR,
  d: Deployment,
  existing: ReadonlySet<string> = new Set(),
): Plan {
  const items: PlanItem[] = describe(ir, d).map((i) => ({
    ...i,
    action: existing.has(i.key) ? "keep" : "create",
  }));
  const changes = items.filter((i) => i.action === "create").length;
  return {
    app: ir.name,
    stage: d.stage,
    version: d.version,
    lifecycle: d.lifecycle,
    verb: items.some((i) => i.action === "keep") ? "update" : "create",
    items,
    changes,
  };
}

export function renderPlan(p: Plan): string {
  const lines = [
    `Flareon will ${p.verb} ${p.app} (${p.stage}/${p.version})` +
      (p.lifecycle === "ephemeral" ? " [ephemeral preview]" : ""),
    "",
    ...p.items.map((i) => `  ${i.action === "create" ? "+" : "="} ${i.label}`),
    "",
    `${p.changes} ${p.changes === 1 ? "change" : "changes"}`,
    "",
    "Deploy with:",
    `  flareon deploy --stage ${p.stage} --version ${p.version}`,
    "",
  ];
  return lines.join("\n");
}
