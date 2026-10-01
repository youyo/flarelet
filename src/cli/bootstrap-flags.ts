import type { Command } from "commander";

/**
 * deploy / dev に `--bootstrap` / `--no-bootstrap` を付ける。
 * 両方指定されたら（commander は後勝ちにするので）エラーにするための判定関数を返す。
 */
export function addBootstrapFlags(cmd: Command): { conflicting: () => boolean } {
  const seen = new Set<string>();
  cmd
    .option("--bootstrap", "bootstrap the AWS account/region if needed, even without a terminal")
    .option("--no-bootstrap", "never bootstrap automatically; fail if not bootstrapped");
  cmd.on("option:bootstrap", () => seen.add("bootstrap"));
  cmd.on("option:no-bootstrap", () => seen.add("no-bootstrap"));
  return { conflicting: () => seen.size > 1 };
}

export const BOOTSTRAP_CONFLICT = "Error: --bootstrap and --no-bootstrap cannot be used together";
