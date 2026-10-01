import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RuntimeLanguage } from "../ir/index.js";
import { loadIR } from "./load.js";
import type { Io } from "./validate.js";
import { WORKFLOW_PATH, workflowBranches, workflowTemplate } from "./workflow.js";

export interface WorkflowGenerateArgs {
  file: string;
  force: boolean;
  /** リポジトリの default branch。不明なら main。 */
  defaultBranch?: string;
}

export function renderWorkflow(
  runtime: RuntimeLanguage,
  git: Parameters<typeof workflowBranches>[0],
  defaultBranch: string,
): string {
  return workflowTemplate({ runtime, branches: workflowBranches(git, defaultBranch) });
}

/** flareon.yaml の git 設定から .github/workflows/flareon.yml を（再）生成する。 */
export async function runWorkflowGenerate(args: WorkflowGenerateArgs, io: Io): Promise<number> {
  const ir = await loadIR(args.file, io);
  if (!ir) return 1;
  const target = join(dirname(args.file), WORKFLOW_PATH);
  const next = renderWorkflow(ir.runtime.language, ir.git, args.defaultBranch ?? "main");

  if (existsSync(target)) {
    if ((await readFile(target, "utf8")) === next) {
      io.stdout(`${WORKFLOW_PATH} is up to date`);
      return 0;
    }
    if (!args.force) {
      io.stderr(
        `Error: ${WORKFLOW_PATH} differs from what the current flareon.yaml would generate; ` +
          `it was not changed. Use --force to overwrite it (local edits are lost).`,
      );
      return 1;
    }
    await writeFile(target, next);
    io.stdout(`Updated ${WORKFLOW_PATH}`);
    return 0;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, next);
  io.stdout(`Created ${WORKFLOW_PATH}`);
  return 0;
}
