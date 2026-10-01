/** バインディングの環境変数名。CDK 側（constructs）とアプリ側（runtime）で共有する。 */
export type BindingKind = "DATABASE" | "STORAGE" | "AI";

export const bindingEnvName = (kind: BindingKind, name: string, suffix: string): string =>
  `FLAREON_${kind}_${name.toUpperCase().replace(/-/g, "_")}_${suffix}`;
