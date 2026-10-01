import { resolveModel } from "../constructs/ai-models.js";
import type { FlareonIR } from "../ir/index.js";
import { bindingEnvName } from "../runtime/env.js";

export interface BindingEntry {
  /** 表示名（`database.main` 等）。 */
  label: string;
  /** アプリに渡す環境変数名。 */
  env: string;
  /** AWS 上に実体（dev スタック）が要るか。AI はローカルの資格情報で直接呼ぶので不要。 */
  stateful: boolean;
}

export function bindingEntries(ir: FlareonIR): BindingEntry[] {
  return [
    ...ir.databases.map((d) => ({
      label: `database.${d.name}`,
      env: bindingEnvName("DATABASE", d.name, "TABLE"),
      stateful: true,
    })),
    ...ir.storages.map((s) => ({
      label: `storage.${s.name}`,
      env: bindingEnvName("STORAGE", s.name, "BUCKET"),
      stateful: true,
    })),
    ...ir.aiModels.map((m) => ({
      label: `ai.${m}`,
      env: bindingEnvName("AI", m, "MODEL_ID"),
      stateful: false,
    })),
  ];
}

const BINDING_ENV = /^FLAREON_(DATABASE|STORAGE|AI)_[A-Z0-9_]+$/;

/** デプロイ済み app Lambda の環境変数からバインディングだけを取り出す。 */
export function pickBindingEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => BINDING_ENV.test(k)));
}

/** AI モデルのバインディング（リージョンから決まる定数）。 */
export function aiBindingEnv(ir: FlareonIR, region: string): Record<string, string> {
  return Object.fromEntries(
    ir.aiModels.map((m) => [
      bindingEnvName("AI", m, "MODEL_ID"),
      resolveModel(m, region).profileId,
    ]),
  );
}
