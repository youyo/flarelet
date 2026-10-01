import { isValidStage, isValidVersion, STAGE_MAX, VERSION_MAX } from "../config/index.js";
import type { GitIR } from "../ir/index.js";

export type GitRef = { type: "branch"; name: string } | { type: "pr"; number: number };

export type Lifecycle = "persistent" | "ephemeral";

export interface Deployment {
  stage: string;
  version: string;
  /** PR preview（pr-N）は ephemeral、それ以外は persistent。 */
  lifecycle: Lifecycle;
}

export interface ResolveInput {
  git: GitIR;
  ref?: GitRef;
  /** リポジトリの default branch 名。`branch: default` のマッピングで必要。 */
  defaultBranch?: string;
  /** CLI の --stage / --version。指定があれば Git 由来の値より優先する。 */
  stage?: string;
  version?: string;
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveError";
  }
}

const STAGE_PROD = "prod";
const STAGE_PREVIEW = "preview";
const PR_VERSION = /^pr-\d+$/;

const lifecycleOf = (version: string): Lifecycle =>
  PR_VERSION.test(version) ? "ephemeral" : "persistent";

const escapeRegex = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

/** `*` は `/` を跨がない、`**` は跨ぐ。それ以外は文字どおり。最初のワイルドカードの一致を返す。 */
function globMatch(pattern: string, input: string): { matched: boolean; capture?: string } {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) => (part === "**" ? "(.*)" : part === "*" ? "([^/]*)" : escapeRegex(part)))
    .join("");
  const m = new RegExp(`^${source}$`).exec(input);
  if (!m) return { matched: false };
  return m[1] === undefined ? { matched: true } : { matched: true, capture: m[1] };
}

function branchMatches(
  pattern: string,
  branch: string,
  defaultBranch: string | undefined,
): { matched: boolean; capture?: string } {
  if (pattern === "default") {
    if (defaultBranch === undefined) {
      throw new ResolveError(
        `cannot resolve branch "${branch}": the default branch name is unknown`,
      );
    }
    return { matched: branch === defaultBranch };
  }
  return globMatch(pattern, branch);
}

function versionFromBranch(branch: string, capture: string | undefined): string {
  const v = (capture ?? branch)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!isValidVersion(v)) {
    throw new ResolveError(
      `cannot derive a valid version from branch "${branch}" (got "${v}"; versions are 1-${VERSION_MAX} chars of a-z, 0-9, -)`,
    );
  }
  return v;
}

function resolveFromGit(git: GitIR, ref: GitRef, defaultBranch: string | undefined): Deployment {
  if (ref.type === "pr") {
    if (!git.pullRequests) {
      throw new ResolveError(
        `pull request previews are disabled (git.pullRequests: false); cannot resolve PR #${ref.number}`,
      );
    }
    return { stage: STAGE_PREVIEW, version: `pr-${ref.number}`, lifecycle: "ephemeral" };
  }

  const prod = branchMatches(git.production.branch, ref.name, defaultBranch);
  if (prod.matched) {
    const version =
      git.production.version === "branch"
        ? versionFromBranch(ref.name, prod.capture)
        : git.production.version;
    return { stage: STAGE_PROD, version, lifecycle: lifecycleOf(version) };
  }
  if (git.preview && branchMatches(git.preview.branch, ref.name, defaultBranch).matched) {
    return { stage: STAGE_PREVIEW, version: "current", lifecycle: "persistent" };
  }
  throw new ResolveError(
    `branch "${ref.name}" does not match any deployment target (production: "${git.production.branch}"` +
      (git.preview ? `, preview: "${git.preview.branch}"` : "") +
      `). Use --stage and --version to deploy it explicitly.`,
  );
}

export function resolveDeployment(input: ResolveInput): Deployment {
  const { git, ref, defaultBranch } = input;
  if (input.stage !== undefined && !isValidStage(input.stage)) {
    throw new ResolveError(
      `invalid stage "${input.stage}": use lowercase letters, digits and hyphens (max ${STAGE_MAX})`,
    );
  }
  if (input.version !== undefined && !isValidVersion(input.version)) {
    throw new ResolveError(
      `invalid version "${input.version}": use lowercase letters, digits and hyphens (max ${VERSION_MAX})`,
    );
  }

  if (input.stage !== undefined && input.version !== undefined) {
    return { stage: input.stage, version: input.version, lifecycle: lifecycleOf(input.version) };
  }

  if (input.stage !== undefined) {
    // version は Git から導けるなら採用し、なければ current。
    let version = "current";
    if (ref) {
      try {
        version = resolveFromGit(git, ref, defaultBranch).version;
      } catch (e) {
        if (!(e instanceof ResolveError)) throw e;
      }
    }
    return { stage: input.stage, version, lifecycle: lifecycleOf(version) };
  }

  if (!ref) {
    throw new ResolveError(
      "cannot resolve a deployment: no Git ref available; pass --stage and --version",
    );
  }
  const resolved = resolveFromGit(git, ref, defaultBranch);
  if (input.version !== undefined) {
    return { ...resolved, version: input.version, lifecycle: lifecycleOf(input.version) };
  }
  return resolved;
}
