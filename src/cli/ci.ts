import type { Io } from "./validate.js";
import type { SynthDeps } from "./synth.js";

/**
 * `--ci` の事前チェック。GitHub Actions のイベントから「このコマンドを実行してよいか」を判定する。
 * ref の解決自体は detectGit が環境変数とイベント payload から行う。
 * 戻り値: undefined なら続行、数値ならその終了コードで終了。
 */
export async function ciPreflight(
  command: "deploy" | "destroy",
  deps: Pick<SynthDeps, "detectGit"> & { io: Io },
): Promise<number | undefined> {
  const { io } = deps;
  const ci = (await deps.detectGit()).ci;
  if (!ci) {
    io.stderr(`Error: --ci requires GitHub Actions (GITHUB_ACTIONS=true and GITHUB_EVENT_NAME)`);
    return 1;
  }
  const closedPr = ci.event.startsWith("pull_request") && ci.action === "closed";
  if (command === "deploy" && closedPr) {
    io.stdout("Pull request is closed; nothing to deploy (run flarelet destroy --ci to remove it)");
    return 0;
  }
  if (command === "destroy" && !closedPr) {
    io.stderr(
      `Error: flarelet destroy --ci only runs for a closed pull request (event: ${ci.event}${ci.action ? `/${ci.action}` : ""})`,
    );
    return 1;
  }
  return undefined;
}
