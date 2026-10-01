import { parse as parseYaml } from "yaml";
import type { GitIR, RuntimeLanguage } from "../ir/index.js";

export const WORKFLOW_PATH = ".github/workflows/flarelet.yml";

export interface WorkflowOptions {
  runtime: RuntimeLanguage;
  /** push で deploy する永続ブランチ（GitHub の branches フィルタのパターン）。 */
  branches: string[];
}

/** YAML のフロー列に素のまま書ける（文字列として解釈される）ものだけ素で、他は引用する。 */
const q = (s: string): string =>
  /^[A-Za-z0-9_./-]+$/.test(s) && !/^(true|false|null|yes|no|on|off|[0-9.]+)$/i.test(s)
    ? s
    : JSON.stringify(s);

/**
 * Flarelet のブランチパターンを GitHub Actions の branches フィルタのパターンに変換する。
 * `*`（`/` を跨がない）と `**`（跨ぐ）は GitHub と同じ意味なのでそのまま。
 * GitHub では `?` `+` `[` `]` と先頭の `!` が特殊だが Flarelet では文字どおりなので、バックスラッシュでエスケープする。
 * 根拠: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#filter-pattern-cheat-sheet
 */
export function toActionsBranchPattern(pattern: string): string {
  const escaped = pattern.replace(/[\\?+[\]]/g, "\\$&");
  return escaped.startsWith("!") ? `\\${escaped}` : escaped;
}

/** production / preview のブランチパターンから push トリガーの branches を作る（`default` は置換、重複除去、production → preview の順）。 */
export function workflowBranches(git: GitIR, defaultBranch: string): string[] {
  const patterns = [git.production.branch, ...(git.preview ? [git.preview.branch] : [])];
  const out = patterns.map((p) => (p === "default" ? defaultBranch : p));
  return [...new Set(out)].map(toActionsBranchPattern);
}

/** ワークフロー YAML の on.push.branches。無い・読めない場合は null。 */
export function pushBranchesOf(text: string): string[] | null {
  try {
    const doc = parseYaml(text) as { on?: { push?: { branches?: unknown } } } | null;
    const b = doc?.on?.push?.branches;
    return Array.isArray(b) && b.every((x) => typeof x === "string") ? (b as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * 既存ワークフローの push ブランチが現在の git 設定と食い違うときの警告文（なければ null）。
 * default branch が必要なのに不明な場合や、push にブランチ指定がない場合は判断しない。
 */
export function checkWorkflowDrift(
  text: string,
  git: GitIR,
  defaultBranch: string | undefined,
): string | null {
  const needsDefault = git.production.branch === "default" || git.preview?.branch === "default";
  if (needsDefault && defaultBranch === undefined) return null;
  const actual = pushBranchesOf(text);
  if (actual === null) return null;
  const expected = workflowBranches(git, defaultBranch ?? "");
  const same =
    new Set(actual).size === new Set(expected).size && expected.every((b) => actual.includes(b));
  if (same) return null;
  return (
    `${WORKFLOW_PATH} on.push.branches [${actual.join(", ")}] differs from the git settings in flarelet.yaml ` +
    `([${expected.join(", ")}]). Run: flarelet workflow generate --force`
  );
}

/**
 * GitHub Actions ワークフロー雛形。
 * - push（永続ブランチ）→ deploy、PR の opened/synchronize/reopened → preview deploy、closed → destroy
 * - AWS へは OIDC（長期アクセスキーなし）。ロール ARN とリージョンはリポジトリ変数
 * - Flarelet は未公開のため、インストール元は FLARELET_PACKAGE（リポジトリ変数で上書き可）で指定する
 */
export function workflowTemplate({ runtime, branches }: WorkflowOptions): string {
  const install =
    runtime === "typescript"
      ? `
      - name: Install app dependencies
        working-directory: app
        run: npm install --no-audit --no-fund
`
      : "";
  const awsSteps = `      - uses: actions/checkout@v7

      - uses: actions/setup-node@v7
        with:
          node-version: 24
${install}
      - uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: \${{ vars.FLARELET_AWS_ROLE_ARN }}
          aws-region: \${{ vars.FLARELET_AWS_REGION }}
`;
  return `# Generated from the git settings in flarelet.yaml. After changing them, regenerate: flarelet workflow generate --force
# Setup: flarelet bootstrap github --repo <owner>/<name>
name: Flarelet

on:
  push:
    branches: [${branches.map(q).join(", ")}]
  pull_request:
    types: [opened, synchronize, reopened, closed]

# AWS access uses OIDC (no long-lived keys). pull-requests/deployments: preview URL comment and Deployment status.
permissions:
  id-token: write
  contents: read
  pull-requests: write
  deployments: write

# One run at a time per pull request (or branch); never cancel a deploy halfway.
concurrency:
  group: flarelet-\${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: false

env:
  # Flarelet is not published to npm yet. Set the repository variable FLARELET_PACKAGE
  # (e.g. a tarball URL or git spec) to install it from elsewhere.
  FLARELET_PACKAGE: \${{ vars.FLARELET_PACKAGE || 'flarelet@latest' }}

jobs:
  deploy:
    # Not for closed PRs, and not for forks (they get neither OIDC nor secrets).
    if: >-
      github.event_name == 'push' ||
      (github.event.action != 'closed' &&
       github.event.pull_request.head.repo.full_name == github.repository)
    runs-on: ubuntu-latest
    steps:
${awsSteps}
      - name: Deploy
        id: deploy
        run: npx --yes "$FLARELET_PACKAGE" deploy --ci

      - name: Report to GitHub
        if: \${{ !cancelled() }}
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: npx --yes "$FLARELET_PACKAGE" github comment --state \${{ steps.deploy.outcome == 'success' && 'success' || 'failure' }}

  destroy:
    if: >-
      github.event_name == 'pull_request' &&
      github.event.action == 'closed' &&
      github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
${awsSteps}
      - name: Destroy preview
        run: npx --yes "$FLARELET_PACKAGE" destroy --ci

      - name: Report to GitHub
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
        run: npx --yes "$FLARELET_PACKAGE" github comment --state inactive
`;
}
