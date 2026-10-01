/**
 * Flarelet AI model registry: 論理名 → Bedrock の推論プロファイル ID / 基盤モデル ID。
 *
 * ID は AWS 公式ドキュメント（Amazon Bedrock の Models at a glance → 各モデルカード）で確認:
 *  - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-sonnet-5-5.html
 *  - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-opus-5-5.html
 *  - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html
 *  - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-micro.html
 *  - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html
 *  - https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-pro.html
 * 確認日: 2026-10-01。apac プロファイルは `aws bedrock list-inference-profiles --region ap-northeast-1`
 * の実 API 結果（apac.amazon.nova-{micro,lite,pro}-v1:0 が実在）で確認。モデルを更新するときはここだけを変える。
 *
 * このファイルは CDK に依存しない（config 検証からも参照される）。
 */

type Geo = "us" | "eu" | "apac";

interface ModelEntry {
  /** 基盤モデル ID（プレフィックスなし）。 */
  foundationModelId: string;
  /** `global`: Global クロスリージョン推論プロファイル（`global.` + 基盤モデル ID）。geo: 地域別プロファイル。 */
  profiles: "global" | readonly Geo[];
}

const REGISTRY = {
  sonnet: { foundationModelId: "anthropic.claude-sonnet-5-5", profiles: "global" },
  opus: { foundationModelId: "anthropic.claude-opus-5-5", profiles: "global" },
  haiku: { foundationModelId: "anthropic.claude-haiku-4-5-20251001-v1:0", profiles: "global" },
  "nova-micro": { foundationModelId: "amazon.nova-micro-v1:0", profiles: ["us", "eu", "apac"] },
  "nova-lite": { foundationModelId: "amazon.nova-lite-v1:0", profiles: ["us", "eu", "apac"] },
  "nova-pro": { foundationModelId: "amazon.nova-pro-v1:0", profiles: ["us", "eu", "apac"] },
} as const satisfies Record<string, ModelEntry>;

export const AI_MODEL_NAMES: readonly string[] = Object.keys(REGISTRY);

export const isKnownModel = (name: string): boolean => Object.hasOwn(REGISTRY, name);

export interface ResolvedModel {
  name: string;
  /** InvokeModel に渡す推論プロファイル ID（`FLARELET_AI_<NAME>_MODEL_ID` の値）。 */
  profileId: string;
  foundationModelId: string;
}

export class UnknownModelError extends Error {
  constructor(name: string) {
    super(`unknown AI model "${name}" (known: ${AI_MODEL_NAMES.join(", ")})`);
    this.name = "UnknownModelError";
  }
}

function geoOf(region: string): Geo | undefined {
  if (region.startsWith("us-") || region.startsWith("ca-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return undefined;
}

export function resolveModel(name: string, region: string): ResolvedModel {
  if (!isKnownModel(name)) throw new UnknownModelError(name);
  const entry: ModelEntry = REGISTRY[name as keyof typeof REGISTRY];
  if (entry.profiles === "global") {
    return {
      name,
      profileId: `global.${entry.foundationModelId}`,
      foundationModelId: entry.foundationModelId,
    };
  }
  const geo = geoOf(region);
  if (!geo || !entry.profiles.includes(geo)) {
    throw new Error(
      `AI model "${name}" has no inference profile for region ${region} (available: ${entry.profiles.join(", ")})`,
    );
  }
  return {
    name,
    profileId: `${geo}.${entry.foundationModelId}`,
    foundationModelId: entry.foundationModelId,
  };
}
