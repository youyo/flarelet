English | [日本語](README.ja.md)

# Flareon

![CI](https://github.com/youyo/flareon/actions/workflows/ci.yml/badge.svg)

## Overview

Flareon is a serverless application platform for AWS. Define what your application needs in YAML, push your code, and Flareon handles infrastructure, authentication, previews, deployment, and runtime bindings.

- Your app is an ordinary web app (ASGI for Python, Hono and friends for TypeScript), run on Lambda with the Lambda Web Adapter
- Authentication is on by default (Cognito plus Flareon's own auth layer). Opt out explicitly with `auth: false` when you want a public app
- Databases (DynamoDB), storage (S3), AI (Bedrock) and secrets are declared, not provisioned by hand. You never write IAM or CDK
- Git is first-class: one environment per branch, one preview environment per pull request (deleted automatically when the PR closes)
- CI is GitHub Actions with OIDC. No long-lived access keys

The mental model is just this:

```text
flareon.yaml

flareon init
flareon dev
flareon deploy
flareon logs
```

For the design, see [docs/specs/FLAREON_V0_DESIGN.md](docs/specs/FLAREON_V0_DESIGN.md). For implementation decisions, see [docs/specs/DECISIONS.md](docs/specs/DECISIONS.md).

## Requirements

- Node.js 24
- AWS credentials (SSO is fine) for the target account. The region is resolved from `--region`, then `AWS_REGION`, then `AWS_DEFAULT_REGION` (default `us-east-1`)
- `cdk bootstrap` already done in the target account and region
- Docker, for Python apps (dependencies are bundled in a Lambda build container)

Runtimes and tasks of this repository are managed with [mise](https://mise.jdx.dev/).

## Installation

Flareon is not published to npm yet.

### Build from the repository

```bash
git clone https://github.com/youyo/flareon && cd flareon
mise install            # Node 24
npm install
mise run build          # build the CLI into dist/
node dist/cli/index.js --help
```

Use `npm link` (or an alias to the build output) to get a `flareon` command.

### Install a packaged build

`dist/` is not committed and there is no `prepare` script, so a plain git spec (`npm install github:youyo/flareon`) does not produce a working CLI. Build a tarball instead:

```bash
mise run build
npm pack                                  # creates flareon-0.0.0.tgz
npm install -g ./flareon-0.0.0.tgz        # or host the tarball and install it from its URL
```

The GitHub Actions workflow installs Flareon from the repository variable `FLAREON_PACKAGE` (see [GitHub Actions](#github-actions)), so a tarball URL works there too.

For zsh completion, see [Shell completion (zsh)](#shell-completion-zsh).

## Quick start

```bash
flareon init myapp --runtime python     # or typescript
cd myapp
flareon dev                             # run locally with hot reload (http://localhost:8787)
flareon deploy                          # deploy to AWS and print the URL
flareon auth user add me@example.com --stage prod   # invite someone who can sign in
flareon logs --follow                   # follow the app logs
```

`init` creates:

```text
myapp/
├── flareon.yaml
├── app/                            # starter app
├── .github/workflows/flareon.yml   # GitHub Actions (an existing file is never overwritten)
└── .gitignore                      # adds .flareon/
```

Where `deploy` goes is decided from Git. By default the default branch is `prod/current` and a pull request is `preview/pr-<number>`. To be explicit, use `--stage prod --version v1`. Only `preview/pr-<number>` is ephemeral; an explicit `--stage preview --version pr-5` is treated as the same PR preview as `--pr 5` (`prod/pr-5` and the like are ordinary persistent versions).

Other useful commands:

```bash
flareon validate                        # validate flareon.yaml
flareon plan                            # show what would be created or changed, in Flareon's terms
flareon secret set EXTERNAL_API_KEY     # the value comes from stdin or a prompt (never from arguments)
flareon destroy                         # delete this version
```

## flareon.yaml reference

Unknown keys are errors. When in doubt, run `flareon validate`.

```yaml
version: 1 # required

name: myapp # required. lowercase letters, digits and hyphens; starts with a letter; 2-24 characters

runtime: # required
  language: python # python | typescript
  version: "3.13" # optional, a quoted string (python default 3.13, typescript default 24)

http:
  true # authenticated. http: { auth: false } makes it public without authentication
  # omit http for no HTTP endpoint
  # For an external IdP / access restriction (see "Authentication"):
  # auth:
  #   provider: google          # google | oidc | entra (default: invite-only Cognito)
  #   allow:                    # default: anyone the IdP authenticates
  #     domains: [example.com]
  #     emails: [alice@example.com]

database: # DynamoDB. one table per name
  main: {}
storage: # S3. one bucket per name
  files: {}
ai: # Bedrock. logical names are resolved by Flareon's model registry
  models:
    - sonnet # sonnet | opus | haiku | nova-micro | nova-lite | nova-pro
secrets: # set values with `flareon secret set`; passed to the app as environment variables
  - EXTERNAL_API_KEY

git: # optional. default: default branch -> prod/current, PR -> preview/pr-N
  production:
    branch: "release/*" # glob (* does not cross /, ** does) or default
    version: branch # branch: derive the version from the branch name (wildcard part). A fixed name also works
  preview:
    branch: default # this branch deploys to preview/current
  pullRequests: true # false: do not create PR previews
```

`http` options in detail:

| Form                      | Meaning                                                                                      |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `http: true`              | Authenticated (default invite-only Cognito)                                                  |
| `http: false`             | No HTTP endpoint (same as omitting `http`)                                                   |
| `http: { auth: true }`    | Same as `http: true`                                                                         |
| `http: { auth: false }`   | **Public, no authentication** (persistent stages only; PR previews still force Preview Auth) |
| `http: { auth: { ... } }` | External IdP and/or access restriction (see [Authentication](#authentication))               |

### Passing values to the app

| Declaration       | Environment variable            |
| ----------------- | ------------------------------- |
| `database.<name>` | `FLAREON_DATABASE_<NAME>_TABLE` |
| `storage.<name>`  | `FLAREON_STORAGE_<NAME>_BUCKET` |
| `ai.models[]`     | `FLAREON_AI_<NAME>_MODEL_ID`    |
| `secrets[]`       | the declared name, as is        |

Secret names use `A-Z`, `0-9` and `_`, and names starting with `FLAREON_` or `AWS_` are reserved. Credentials of external IdPs are not declared in `secrets:` (see [Authentication](#authentication)).

App conventions: Python needs `app/main.py` exposing `app` (ASGI) and `app/requirements.txt`. TypeScript needs `app/index.ts` and `app/package.json` and listens on `PORT` (port 8080). In TypeScript, listen with `hostname: process.env.HOST ?? "127.0.0.1"` (same as the `flareon init` template). On Lambda, the Lambda Web Adapter reaches `127.0.0.1`, and `flareon dev` passes `HOST=127.0.0.1`. Listening on all interfaces would let other machines on the same network reach the app directly, bypassing the proxy, and forge identity headers.

## App, Stage and Version, and Git mapping

A deployment is addressed by App -> Stage -> Version:

- **App**: the `name` in `flareon.yaml`
- **Stage**: a long-lived environment that owns the stateful resources (database, storage, users, secrets). Lowercase letters, digits and hyphens, up to 16 characters
- **Version**: one deployed copy of the code inside a stage. Up to 32 characters

Git decides the target unless you pass it explicitly. Priority: `--stage` + `--version` > `--pr` > `--branch` > the current Git state (the GitHub event in CI).

| Git state                | Default target    | Configurable with                                                                   |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------- |
| Default branch           | `prod/current`    | `git.production.branch`, `.version`                                                 |
| A branch matching a glob | `prod/<version>`  | `git.production.branch: "release/*"`, `version: branch` (`release/v1` -> `prod/v1`) |
| `git.preview.branch`     | `preview/current` | `git.preview.branch`                                                                |
| Pull request N           | `preview/pr-N`    | `git.pullRequests: false` to disable                                                |

- Only `preview/pr-<N>` is ephemeral (the PR preview, destroyed when the PR closes). It starts with empty databases and storage; production data is never copied
- Branches that match no mapping cannot be deployed until you pass `--stage` / `--version`
- `--stage` alone derives the version from Git, or falls back to `current`

## Authentication

With `http: true`, the default is **invite-only** Cognito (self sign-up is disabled). Only users invited with `flareon auth user add <email> --stage <stage>` can sign in. Pull request previews are protected separately by Preview Auth (token links).

PR previews are **protected by Preview Auth even with `http.auth: false`**, so a PR's code is never published without authentication by accident (`plan` / `deploy` print `forced for pull request previews`). Only persistent stages such as `prod` are ever public with `auth: false`.

The session cookie is `__Host-flareon_session` (Secure, Path=/, no Domain). The temporary sign-in cookie is `__Secure-flareon_flow`. Sessions last 8 hours at most.

To stop sessions earlier, run `flareon auth revoke-sessions --stage <stage>` (`--pr <number>` for a PR preview). This revokes **all** Flareon sessions of that environment, and takes effect within 60 seconds because the front caches the session generation for 60 seconds. If the generation cannot be read, the front returns 503 rather than letting requests through unchecked. `flareon auth user remove` performs the same revocation so a removed user's sessions stop (other users sign in again).

### Identity headers and authorization

Authenticated users reach the app as the headers `x-flareon-user-sub`, `x-flareon-user-email` and `x-flareon-user-email-verified` (`true` or `false`). Any `x-flareon-*` header sent by the client is removed by the front auth layer. In TypeScript, `identity(headers)` from `flareon/runtime` returns `sub`, `email` and `emailVerified`. On a stage with `auth: false`, the app receives `FLAREON_AUTH_ENABLED=false` and `identity()` always returns `null` (see [Limitations](#limitations)).

**Use `sub` for authorization and for linking users.** `email` comes from the IdP and is not necessarily verified (with OIDC and others, an IdP may allow unverified addresses). If you use email, only trust it when `emailVerified` (the header is `true`). `emailVerified` is true only when the id_token has `email_verified` set to true (Entra ID does not emit `email_verified`, so it is always `false`; PR previews have no email, so it is `false`). The Cognito (default) User Pool keeps the original email until the new address is verified when a user changes it.

### External IdPs (Google / OIDC / Entra ID)

An external IdP is wired in as a Cognito identity provider, and users go straight to it, skipping the sign-in page. Client IDs and secrets have fixed names and are set per stage with `flareon secret set` (do not list them in `secrets:`; they are not passed to the app). They are stored in Secrets Manager at `flareon/<app>/<stage>/auth/<name>` and never enter the template.

| provider | flareon.yaml                                                                             | Credentials (`flareon secret set <name> --stage <stage>`) |
| -------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| google   | `auth: { provider: google }`                                                             | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`               |
| oidc     | `auth: { provider: oidc, issuer: https://idp.example.com, scopes?: [...], name?: Corp }` | `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`                   |
| entra    | `auth: { provider: entra, tenant: <directory (tenant) ID> }`                             | `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`                 |

- The redirect URI to register at the IdP is `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`. The prefix is derived deterministically from app, stage and AWS account. If you run `flareon deploy` before setting credentials, the error message shows the exact URI
- `flareon deploy` without credentials stops before creating anything and tells you which `flareon secret set ...` to run. After updating a secret, deploy again to apply it to the IdP
- oidc: `issuer` must be https. `scopes` defaults to `openid email profile` (`openid` is required). `name` is the display name on the sign-in page (default `OIDC`)
- entra: `tenant` is the directory (tenant) ID, a GUID. Domain names (`contoso.onmicrosoft.com`) do not work, because Entra's token issuer uses the tenant ID form and Cognito's issuer check would fail. Multi-tenant and personal-account values such as `common`, `organizations` and `consumers` are rejected
- Users invited with `flareon auth user add` cannot sign in on an external-IdP stage (a warning is printed)
- PR previews do not use the external IdP; they stay on Preview Auth

#### Google setup

1. In Google Cloud Console, open "APIs & Services -> OAuth consent screen" and set **User type to Internal**. Only users in your Google Workspace organization can then sign in (recommended)
2. Under "Credentials -> Create OAuth client ID", choose "Web application" and register the `/oauth2/idpresponse` URI above as an authorized redirect URI
3. Register the client ID and secret, then deploy

   ```bash
   flareon secret set GOOGLE_CLIENT_ID --stage prod
   flareon secret set GOOGLE_CLIENT_SECRET --stage prod
   flareon deploy
   ```

4. For defense in depth, also put your Workspace domain in `allow.domains` (next section). Even if Internal is misconfigured as External, accounts outside your organization are rejected on the Flareon side

#### Entra ID setup

1. In the Microsoft Entra admin center, go to "App registrations -> New registration" and choose **"Accounts in this organizational directory only (single tenant)"** as the supported account type
2. Register `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse` as a redirect URI (platform "Web")
3. Under "Certificates & secrets -> New client secret", create a secret and note its **value** (not the secret ID). Rotate it before it expires, then `flareon secret set` and deploy again
4. Under "API permissions", confirm the delegated Microsoft Graph permissions `openid`, `profile` and `email`
5. Use "Application (client) ID" and "Directory (tenant) ID" from the overview page

   ```yaml
   http:
     auth:
       provider: entra
       tenant: 00000000-0000-0000-0000-000000000000 # directory (tenant) ID
       allow: { domains: [contoso.com] } # optional
   ```

   ```bash
   flareon secret set ENTRA_CLIENT_ID --stage prod
   flareon secret set ENTRA_CLIENT_SECRET --stage prod
   flareon deploy
   ```

- The User Pool requires the email attribute, so Entra users without an email address (`email` claim) cannot sign in
- Guest (B2B) users invited to your tenant can also pass the tenant-specific sign-in. To keep guests out, set your own domain in `allow.domains`

### Access restriction (http.auth.allow)

Narrows down who gets into the app among the users the IdP authenticated (default: everyone the IdP authenticates). It works with every provider, including the default Cognito.

```yaml
http:
  auth:
    provider: google
    allow:
      domains: [example.com] # either one matching is enough
      emails: [partner@gmail.com]
```

| provider       | `domains`                                                                                | `emails`                                        |
| -------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| google         | The Google Workspace **hosted domain (`hd`)** matches                                    | The `email_verified=true` email matches exactly |
| cognito / oidc | The domain of the `email_verified=true` email matches exactly (subdomains are different) | The `email_verified=true` email matches exactly |
| entra          | The domain of the email (or `preferred_username` if none) matches exactly                | The email (or `preferred_username`) matches     |

- google does not decide by email domain, so that personal Google accounts created with a company-domain address (outside Workspace, no `hd`) are rejected
- Entra id_tokens have no `email_verified`, so the check is by email and relies on the tenant-specific sign-in (accounts outside the tenant cannot get in)
- The check happens at sign-in (callback) in the front auth Lambda. A rejected user gets a 403 page (with a sign-out link) and no session cookie
- When you change `allow` and deploy, sessions issued before are invalidated and the check runs again at the next sign-in
- Comparison is case-insensitive. The lists are passed through an environment variable of the front Lambda, so the total is capped at 2000 characters (use `domains` if you have many)
- `allow` does not apply to PR previews (Preview Auth)

## Local development

```bash
flareon dev                              # http://localhost:8787
flareon dev --as alice@example.com       # run as a signed-in user
flareon dev --stage prod --version v1    # connect to an existing environment's DB/storage (no new stack)
```

- By default it uses a dedicated dev environment, `preview/local-<OS user name>`. If `database:` / `storage:` are declared, it creates a stack with only those on first use (reused afterwards) and passes them to the local app in the same environment variables as production (`FLAREON_DATABASE_*` and so on). With neither, no stack is created
- AI model IDs are resolved through the model registry, and Bedrock is called with your local AWS credentials. `secrets:` are decrypted from the stage and put in environment variables (values are never printed)
- Changes under `app/` restart the app (`node_modules`, `__pycache__`, `venv`, dotfiles and the like are ignored). On a build failure or crash it waits for the next change
- Python runs as `python -m uvicorn main:app` (`python` on PATH, falling back to `python3`) with `PYTHONDONTWRITEBYTECODE=1`, to avoid a stale `.pyc` being used when a file is rewritten in the same second with the same size. Install `fastapi`, `uvicorn` and your other dependencies in your own environment (a venv is recommended). TypeScript is bundled with the same esbuild as production (no extra dependencies)
- A thin proxy listens on the user-facing port (127.0.0.1) and always strips `x-flareon-*` headers sent by the client. Only with `--as <email>` does it add `x-flareon-user-email`, `x-flareon-user-email-verified: true`, `x-flareon-user-sub: dev:<email>` and `x-flareon-auth-mode: dev` (locally there is no sign-in page and no `allow` check). Because a layer strips headers, the app receives `FLAREON_AUTH_ENABLED=true`
- The proxy returns 403 for any `Host` other than `localhost`, `127.0.0.1` or `[::1]` (with an optional port), so external sites cannot read your local app through DNS rebinding. With `--as` it also returns 403 for cross-site requests (`Origin` is not the app's own origin, or `Sec-Fetch-Site: cross-site`), which prevents CSRF as the pseudo user
- The app receives `HOST=127.0.0.1` and a random per-launch `FLAREON_DEV_SECRET`, and the proxy adds the same value as the `x-flareon-dev-secret` header only to requests it forwards. `identity()` in `flareon/runtime` returns an identity only when the header matches `FLAREON_DEV_SECRET` (so forged headers on direct access that bypasses the proxy are not trusted even if the app listens on all interfaces). **Python has no runtime library, so when you read identity headers, trust them only if `x-flareon-dev-secret` matches `FLAREON_DEV_SECRET` whenever that variable is set** (uvicorn is started with `--host 127.0.0.1`)
- `FLAREON_OFFLINE=1` starts only the app, without connecting to AWS (bindings show as `offline`)
- To delete the dev environment: `flareon destroy --stage preview --version local-<user>`

## GitHub Actions

PR previews, branch deploys and cleanup run from GitHub Actions with OIDC.

1. Once per repository, create the role with admin credentials for the AWS account.

   ```bash
   flareon bootstrap github --repo owner/name --region ap-northeast-1
   ```

   - If the account already has a GitHub OIDC provider, it is reused as is (never modified or deleted). Flareon creates one only when there is none
   - Only OIDC tokens for `repo:owner/name:*` can assume the created role (see "Risk of the trust policy" below)

2. Set the repository variables printed after the command:

   ```bash
   gh variable set FLAREON_AWS_ROLE_ARN --repo owner/name --body arn:aws:iam::123456789012:role/flareon-github-owner-name
   gh variable set FLAREON_AWS_REGION   --repo owner/name --body ap-northeast-1
   gh variable set FLAREON_PACKAGE      --repo owner/name --body https://example.com/flareon-0.0.0.tgz
   ```

   Flareon is not published to npm, and the workflow defaults to `npx flareon@latest`. Until it is published, set `FLAREON_PACKAGE` to where Flareon can be installed from, such as a tarball URL.

3. Commit and push the `.github/workflows/flareon.yml` that `flareon init` created.

### Workflow and push triggers

| Event                              | Action                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| push (persistent branches)         | `flareon deploy --ci`                                                                                       |
| PR opened / synchronize / reopened | Deploy the preview. Comment the URL on the PR (one comment, kept up to date) and create a GitHub Deployment |
| PR closed                          | `flareon destroy --ci` deletes the preview. The comment becomes "deleted" and the Deployment inactive       |

- The push trigger (`on.push.branches`) is **generated from the `git` settings in `flareon.yaml`**: `git.production.branch` and `git.preview.branch`, with `default` replaced by the default branch name. Glob patterns (`*`, `**`) keep their meaning
- After changing the `git` settings, regenerate the workflow with `flareon workflow generate --force`. Without `--force` it creates a missing file, reports `up to date`, and refuses to change a file that differs (exit code 1)
- `flareon validate` prints a warning when the existing workflow's `on.push.branches` differs from the `git` settings
- **Manual edits to the workflow are lost with `--force`.** Keep custom changes in a separate workflow file
- Runs for the same PR (branch) are serialized with `concurrency`
- PRs from forks are not handled, because OIDC and secrets are unavailable to them

Previews are protected by Preview Auth. The PR comment contains only the URL and a hint to get a token link with `flareon env url --pr <number> --with-token`, not the link itself (on a public repository anyone could open it). For private repositories only, adding `flareon github comment --with-token` to the workflow puts the link in the comment (it is refused on public repositories).

### Permissions of the CI role

- `sts:AssumeRole` on the CDK bootstrap roles (`cdk-<qualifier>-{deploy,file-publishing,image-publishing,lookup}-role-*`), and PassRole of the `cfn-exec` role (to CloudFormation only)
- CloudFormation read access (Describe / Get / List), and `DeleteStack` only for PR preview stacks (`flareon-*-preview-pr-*`; `flareon-bootstrap-*` is explicitly denied)
- Read access to SSM `/flareon/*`
- Secrets Manager `DescribeSecret` (only `flareon/*/auth/*`, the external IdP credentials; deploy uses it to check presence without reading values)
- Secrets Manager `GetSecretValue` (only secrets tagged `flareon:stage=preview` and `flareon:lifecycle=ephemeral`, which are PR previews'. The cookie signing key of a persistent stage cannot be read)
- CloudWatch Logs read access (`FilterLogEvents` / `GetLogEvents` / `StartLiveTail`, only on Flareon's log groups `flareon-*`)

It does not include writing secrets, deleting persistent stages or versions, full stage-resource deletion (`--stage-resources`) or user management. Run those with your own credentials.

### Risk of the trust policy (sub condition)

The role's trust condition is `token.actions.githubusercontent.com:sub` = `repo:owner/name:*`. That means **any workflow on any branch in that repository** (including a modified workflow on a branch created by someone with push access) can use the role. The role can assume CDK bootstrap deploy roles, so in effect it can deploy arbitrary CloudFormation to that account and region. That is strong.

v0 leaves it as is. To narrow it, change the `sub` condition in the role's trust policy (in the IAM console, for example) after `flareon bootstrap github`. Note that re-running the command reverts the change.

- Use a GitHub Environment: add `environment: production` to the workflow job, configure the Environment's protection rules (required reviewers, allowed deployment branches), and set `sub` to `repo:owner/name:environment:production`
- Limit to the branch and PRs: allow only `repo:owner/name:ref:refs/heads/main` and `repo:owner/name:pull_request` (make the `StringLike` value an array)
- Use separate roles for production deploys and PR previews, each with the conditions above

Delete the role with `flareon bootstrap github --repo owner/name --destroy`. If Flareon created the OIDC provider, it is deleted too, but only when no other role trusts it.

## CLI reference

| Command                                                     | Description                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `flareon init [dir] [--runtime python\|typescript]`         | Create `flareon.yaml`, a starter app and the GitHub Actions workflow                                    |
| `flareon validate`                                          | Validate `flareon.yaml` (also warns when the workflow's push branches differ from the `git` settings)   |
| `flareon workflow generate [--force]`                       | Generate `.github/workflows/flareon.yml` from the `git` settings. `--force` overwrites a differing file |
| `flareon synth`                                             | Generate the CDK Cloud Assembly into `.flareon/out/` (for debugging)                                    |
| `flareon plan`                                              | Show changes compared with what is deployed                                                             |
| `flareon deploy [--ci]`                                     | Deploy and print the URL                                                                                |
| `flareon destroy [--stage-resources --yes] [--ci]`          | Delete a version. `--stage-resources` also fully deletes the stage's DB, storage, users and secrets     |
| `flareon env list`                                          | List deployed stages and versions                                                                       |
| `flareon env url [--with-token]`                            | Print the URL. For a PR preview, `--with-token` gives a link with the token                             |
| `flareon logs [--since 10m] [--follow]`                     | Show logs. `--follow` uses CloudWatch Logs Live Tail                                                    |
| `flareon dev [--port 8787] [--as <email>]`                  | Run locally with hot reload, connected to the dev DB/storage on AWS                                     |
| `flareon secret set\|list\|delete`                          | Manage secrets (SSM SecureString; external IdP credentials live in Secrets Manager)                     |
| `flareon auth user add\|list\|remove <email>`               | Manage Cognito users. `remove` also revokes all sessions of that stage                                  |
| `flareon auth revoke-sessions`                              | Revoke every Flareon session of the environment (effective within 60 seconds)                           |
| `flareon github comment [--state ...] [--with-token]`       | Update the PR comment and the GitHub Deployment (for CI)                                                |
| `flareon bootstrap github --repo owner/name [--destroy]`    | Create or delete the AWS IAM role for GitHub Actions                                                    |
| `flareon completion zsh`                                    | Print the zsh completion script (see [Shell completion (zsh)](#shell-completion-zsh))                   |
| `flareon skill install [--global] [--dir <path>] [--force]` | Install the AI agent skill (see [Agent skill](#agent-skill))                                            |

Common options that choose the deployment target: `-f/--file`, `--stage`, `--version`, `--branch`, `--pr`, `--default-branch`, `--region`.

## Shell completion (zsh)

```bash
flareon completion zsh > "${fpath[1]}/_flareon"   # put it in the first fpath directory (effective from the next shell)
# or, in ~/.zshrc (after compinit)
eval "$(flareon completion zsh)"
```

The script is generated from the CLI's command definitions, so it follows new commands and options automatically. It completes commands, subcommands and options, plus the values of `--runtime` and `--state` and the paths of `-f/--file` and `--dir` (`--stage` / `--version` are not completed because that would call AWS). Only zsh is supported.

## Agent skill

Flareon bundles an [Agent Skill](https://docs.claude.com/en/docs/claude-code/skills) so that AI agents such as Claude Code can use the flareon CLI safely. It contains the workflows, safety rules (confirm `destroy --stage-resources`, pass secrets via stdin, use `auth: false` only when explicitly told, and so on), troubleshooting, and a reference of every command and every `flareon.yaml` key.

```bash
flareon skill install            # into this project
flareon skill install --global   # into ~/ (available in every project)
```

- The real files are in `<root>/.agents/skills/flareon/` (`SKILL.md` and `references/`). `<root>/.claude/skills/flareon` is a relative symlink to it (`../../.agents/skills/flareon`). `<root>` is the current directory by default, another project root with `--dir <path>`, or your home directory with `--global`
- An existing installation is not overwritten without `--force`. If the same link already exists, nothing happens
- Where symlinks cannot be created (Windows, for example), it prints a warning and copies to `.claude/skills/flareon`
- In this repository, `.agents/skills/flareon/` is the source of truth and `.claude/skills/flareon` is the link. The skill text is checked against the CLI implementation by tests (commands and options exist, no broken links, `flareon.yaml` examples validate)

## Limitations

- **Responses are limited to 6MB** (the limit of a synchronous Lambda invoke). Go through S3 for large files
- Request timeouts are 30 seconds at most (app < front <= 30s). An app timeout becomes a 504
- With authentication, the path is HTTP API `$default` route -> front auth Lambda -> app Lambda, two stages
- Logs are delivered with some delay. `flareon logs --follow` uses CloudWatch Logs Live Tail, but ingestion into CloudWatch is not instantaneous
- Cookies are scoped per host. Sessions are not shared across different hosts (different environments), so each environment signs in separately
- PR previews start with empty databases and storage; production data is not copied
- Verification of PR behavior on a real GitHub repository is out of scope for v0 (templates, resolver and CLI only)
- `--ci` does not handle fork PRs. `destroy --ci` only acts on closed PR events
- Custom domains are out of scope for v0
- **On a stage with `http.auth: false`, nothing strips `x-flareon-*` headers.** A client can freely send `x-flareon-user-sub` and the like, so the app must not trust these headers. `identity()` from `flareon/runtime` looks at `FLAREON_AUTH_ENABLED=false` and always returns `null`, but when you read the headers directly (in Python, for example), use them only when `FLAREON_AUTH_ENABLED` is `true`

## Development

```bash
mise run build        # build into dist/
mise run test         # unit + E2E (does not connect to AWS)
mise run test:unit    # vitest (test/unit)
mise run test:e2e     # run the built CLI as a real process (test/e2e, AWS side is FLAREON_OFFLINE=1)
mise run lint         # ESLint + Prettier
mise run typecheck    # tsc
mise run fmt          # format with Prettier
mise run dev          # tsc --watch
mise run pack:check   # check the npm package contents (npm pack --dry-run)
mise run lint:actions # validate GitHub Actions workflows with actionlint
```

Other tasks: `test:e2e:file` and `test:e2e:aws:file` (run a single file), `test:e2e:python-env` (venv for the `flareon dev` E2E), `playwright:install`. Run `mise tasks` for the full list.

### E2E in two tiers

1. **Always-on E2E** (`mise run test:e2e`): behavior that can be checked without connecting to AWS, such as `init`, `synth`, `plan` and the `--ci` decisions. It passes invalid credentials so that nothing can touch real AWS by accident
2. **Real AWS E2E** (opt-in): actually deploys, checks HTTP, authentication and logs, then destroys. It creates only resources with test-specific names (`fe2e-*`, `flareon-e2e/*`) and verifies that nothing is left behind at the end

   ```bash
   FLAREON_E2E_AWS=1 mise run test:e2e:aws
   ```

   It is skipped unless `FLAREON_E2E_AWS` is set. It needs AWS credentials and `AWS_REGION` (`ap-northeast-1`). The `bootstrap github` E2E also verifies that it does not modify or delete a GitHub OIDC provider that already exists in the account.

### CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`. It installs zsh (the completion E2E uses it), sets up tools with mise (Node, Python, actionlint), then runs `mise run install`, `lint`, `lint:actions`, `typecheck`, `test` (unit + always-on E2E, with no AWS credentials) and `pack:check`.

The development method is TDD (Red -> Green -> Refactor, with both unit and E2E tests).
