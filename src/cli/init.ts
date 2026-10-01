import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { APP_NAME_MIN, NAME_MAX } from "../config/index.js";
import type { RuntimeLanguage } from "../ir/index.js";
import { scaffold } from "./templates.js";
import { WORKFLOW_PATH, workflowTemplate } from "./workflow.js";
import type { Io } from "./validate.js";

export interface InitArgs {
  dir: string;
  runtime?: string;
  /** push で deploy するブランチ（既定: main）。 */
  defaultBranch?: string;
}

/** ディレクトリ名から有効なアプリ名（小文字英数字とハイフン、英字始まり）を導く。 */
export function appNameFromDir(dir: string): string {
  let n = basename(resolve(dir))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (n && !/^[a-z]/.test(n)) n = `app-${n}`;
  n = n.slice(0, NAME_MAX).replace(/-+$/, "");
  return n.length >= APP_NAME_MIN ? n : "myapp";
}

const RUNTIMES: RuntimeLanguage[] = ["python", "typescript"];

export async function runInit(args: InitArgs, io: Io): Promise<number> {
  const runtime = args.runtime ?? "python";
  if (!RUNTIMES.includes(runtime as RuntimeLanguage)) {
    io.stderr(`Error: unknown runtime "${runtime}" (use one of: ${RUNTIMES.join(", ")})`);
    return 1;
  }
  const dir = resolve(args.dir);
  if (existsSync(join(dir, "flareon.yaml"))) {
    io.stderr(`Error: ${join(dir, "flareon.yaml")} already exists`);
    return 1;
  }

  const name = appNameFromDir(dir);
  const files = scaffold(name, runtime as RuntimeLanguage);
  for (const f of files) {
    const target = join(dir, f.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.content);
  }

  const gi = join(dir, ".gitignore");
  const current = existsSync(gi) ? await readFile(gi, "utf8") : "";
  if (!current.split("\n").some((l) => l.trim() === ".flareon/")) {
    const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
    await appendFile(gi, `${prefix}.flareon/\n`);
  }

  const wfTarget = join(dir, WORKFLOW_PATH);
  const wfExists = existsSync(wfTarget);
  if (!wfExists) {
    await mkdir(dirname(wfTarget), { recursive: true });
    await writeFile(
      wfTarget,
      workflowTemplate({
        runtime: runtime as RuntimeLanguage,
        branches: [args.defaultBranch ?? "main"],
      }),
    );
  }

  io.stdout(`Created ${name} (${runtime}) in ${dir}`);
  for (const f of files) io.stdout(`  ${f.path}`);
  io.stdout(wfExists ? `  ${WORKFLOW_PATH} already exists (left untouched)` : `  ${WORKFLOW_PATH}`);
  io.stdout("");
  io.stdout("Next steps:");
  if (runtime === "typescript") io.stdout("  (cd app && npm install)");
  io.stdout("  flareon validate");
  io.stdout("  flareon synth --stage prod --version v1");
  io.stdout("");
  io.stdout("GitHub Actions (PR previews and deploys):");
  io.stdout("  flareon bootstrap github --repo <owner>/<name>");
  io.stdout("  gh variable set FLAREON_AWS_ROLE_ARN --body <role arn printed above>");
  io.stdout("  gh variable set FLAREON_AWS_REGION --body <region>");
  return 0;
}
