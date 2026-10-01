import { basename } from "node:path";
import { ConfigFileNotFoundError, formatIssues, loadConfigFile } from "../config/index.js";
import { toIR, type FlareonIR } from "../ir/index.js";

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

function httpSummary(ir: FlareonIR): string {
  if (!ir.http) return "none";
  const a = ir.http.auth;
  if (!a.enabled) return "public (auth disabled)";
  return a.provider === "cognito" ? "authenticated" : `authenticated (${a.provider})`;
}

/** flareon.yaml を検証し、終了コードを返す。 */
export async function runValidate(file: string, io: Io): Promise<number> {
  let result;
  try {
    result = await loadConfigFile(file);
  } catch (e) {
    if (e instanceof ConfigFileNotFoundError) {
      io.stderr(`Error: ${e.file} not found`);
      return 1;
    }
    throw e;
  }
  if (!result.ok) {
    io.stderr(`${basename(file)} is invalid:`);
    for (const line of formatIssues(result.issues).split("\n")) io.stderr(`  ${line}`);
    return 1;
  }

  const ir = toIR(result.config);
  io.stdout(`${basename(file)} is valid`);
  io.stdout("");
  io.stdout(`  name      ${ir.name}`);
  io.stdout(`  runtime   ${ir.runtime.language} ${ir.runtime.version}`);
  io.stdout(`  http      ${httpSummary(ir)}`);
  const resources = [
    ...ir.databases.map((d) => `database.${d.name}`),
    ...ir.storages.map((s) => `storage.${s.name}`),
    ...ir.aiModels.map((m) => `ai.${m}`),
  ];
  if (resources.length) io.stdout(`  bindings  ${resources.join(", ")}`);
  if (ir.secrets.length) io.stdout(`  secrets   ${ir.secrets.join(", ")}`);
  return 0;
}
