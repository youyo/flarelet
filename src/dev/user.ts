import { VERSION_MAX } from "../config/names.js";

const PREFIX = "local-";

/** OS ユーザー名から dev 環境の version 名 `local-<user>` を作る（小文字英数字とハイフン、32 文字以内）。 */
export function devVersion(username: string): string {
  const max = VERSION_MAX - PREFIX.length;
  const user =
    username
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+/, "")
      .slice(0, max)
      .replace(/-+$/, "") || "dev";
  return `${PREFIX}${user}`;
}
