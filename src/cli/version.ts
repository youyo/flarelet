import { readFileSync } from "node:fs";

/** この CLI 自身の version（package.json の version。src/ でも dist/ でも同じ相対位置）。 */
export function packageVersion(): string {
  const url = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}
