/**
 * 名前の制約。CloudFormation のスタック名（英数字とハイフン、128 文字以内）と
 * S3 バケット名（小文字・数字・ハイフン、63 文字以内）の両方で安全な範囲に収める。
 * `flareon-{app}-{stage}-{version}-{resource}` のような合成名が上限を超えないよう、各要素を短く制限する。
 */

/** 小文字英字で始まり、小文字英数字とハイフンのみ。ハイフンは連続・末尾不可。 */
export const NAME_PATTERN = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9]))*$/;
export const APP_NAME_MIN = 2;
export const NAME_MAX = 24;

/** stage 名: NAME_PATTERN で 16 文字まで。 */
export const STAGE_MAX = 16;

/** version 名: 英数字で始まり、小文字英数字とハイフン。32 文字まで。 */
export const VERSION_PATTERN = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9]))*$/;
export const VERSION_MAX = 32;

/** シークレット名 = 環境変数名。 */
export const SECRET_PATTERN = /^[A-Z][A-Z0-9_]*$/;
export const RESERVED_SECRET_PREFIXES = ["FLAREON_", "AWS_"] as const;

export const isValidStage = (s: string): boolean => s.length <= STAGE_MAX && NAME_PATTERN.test(s);

export const isValidVersion = (s: string): boolean =>
  s.length <= VERSION_MAX && VERSION_PATTERN.test(s);
