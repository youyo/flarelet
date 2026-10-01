import { basename } from "node:path";
import { ConfigFileNotFoundError, formatIssues, loadConfigFile } from "../config/index.js";
import { toIR, type FlareonIR } from "../ir/index.js";
import type { Io } from "./validate.js";

/** flareon.yaml を読み込んで IR にする。失敗時はエラーを出力して null。 */
export async function loadIR(file: string, io: Io): Promise<FlareonIR | null> {
  let result;
  try {
    result = await loadConfigFile(file);
  } catch (e) {
    if (e instanceof ConfigFileNotFoundError) {
      io.stderr(`Error: ${e.file} not found`);
      return null;
    }
    throw e;
  }
  if (!result.ok) {
    io.stderr(`${basename(file)} is invalid:`);
    for (const line of formatIssues(result.issues).split("\n")) io.stderr(`  ${line}`);
    return null;
  }
  return toIR(result.config);
}
