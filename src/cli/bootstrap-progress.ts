import type { ProgressEvent } from "../aws/iohost.js";

/** bootstrap のデプロイ進捗（スタック単位）。 */
export function progressLines(out: (l: string) => void): (e: ProgressEvent) => void {
  return (e) => {
    if (e.type === "stack-start") out(`  deploying ${e.stack}`);
    else if (e.type === "stack-end") out(`    done`);
  };
}
