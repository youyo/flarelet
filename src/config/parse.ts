import { readFile } from "node:fs/promises";
import { parse as parseYaml, YAMLParseError } from "yaml";
import type { z } from "zod";
import { configSchema, type FlareletConfig } from "./schema.js";

export interface ConfigIssue {
  /** ドット区切りのパス。ルートは空文字。 */
  path: string;
  message: string;
}

export type ParseResult =
  { ok: true; config: FlareletConfig } | { ok: false; issues: ConfigIssue[] };

const pathOf = (p: ReadonlyArray<PropertyKey>): string => p.map(String).join(".");

/** union の失敗は、最も深いパスまで進んだ枝の issue を採用する。 */
function flatten(
  issues: ReadonlyArray<z.core.$ZodIssue>,
  prefix: PropertyKey[] = [],
): ConfigIssue[] {
  const out: ConfigIssue[] = [];
  for (const iss of issues) {
    const full = [...prefix, ...iss.path];
    if (iss.code === "invalid_union") {
      const branches = iss.errors.map((b) => flatten(b as z.core.$ZodIssue[], full));
      const best = branches.reduce<ConfigIssue[]>(
        (a, b) => (depth(b) > depth(a) ? b : a),
        branches[0] ?? [],
      );
      out.push(...(best.length ? best : [{ path: pathOf(full), message: iss.message }]));
    } else if (iss.code === "unrecognized_keys") {
      out.push({
        path: pathOf(full),
        message: `unknown key(s): ${iss.keys.map((k) => JSON.stringify(k)).join(", ")}`,
      });
    } else if (iss.code === "invalid_key") {
      out.push({
        path: pathOf(full),
        message: `invalid name: ${iss.issues[0]?.message ?? iss.message}`,
      });
    } else {
      out.push({ path: pathOf(full), message: iss.message });
    }
  }
  return out;
}

const depth = (a: ConfigIssue[]): number =>
  Math.max(0, ...a.map((i) => (i.path === "" ? 0 : i.path.split(".").length)));

export function parseConfig(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    const msg = e instanceof YAMLParseError ? e.message : String(e);
    return { ok: false, issues: [{ path: "", message: `invalid YAML: ${msg}` }] };
  }
  const res = configSchema.safeParse(raw ?? {});
  if (res.success) return { ok: true, config: res.data };
  return { ok: false, issues: flatten(res.error.issues) };
}

export function formatIssues(issues: ConfigIssue[]): string {
  return issues.map((i) => `${i.path === "" ? "(root)" : i.path}: ${i.message}`).join("\n");
}

export class ConfigFileNotFoundError extends Error {
  constructor(public readonly file: string) {
    super(`${file} not found`);
    this.name = "ConfigFileNotFoundError";
  }
}

export async function loadConfigFile(file: string): Promise<ParseResult> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new ConfigFileNotFoundError(file);
    throw e;
  }
  return parseConfig(text);
}
