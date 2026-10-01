# flareon CLI リファレンス

`src/cli/program.ts` の定義から起こした全コマンドとオプション。CLI の出力は英語、終了コードは成功 0 / 失敗 1。`flareon <command> --help` が最終的な正。

## デプロイ先を決める共通オプション

`synth` / `plan` / `deploy` / `destroy` / `env url` / `logs` / `secret *` / `auth user *` / `auth revoke-sessions` / `github comment` が共通で受け取ります（`env list` は `-f` と `--region` のみ、`dev` と `bootstrap github` は下記の各節）。

| オプション                  | 内容                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `-f, --file <path>`         | 設定ファイルのパス（既定 `flareon.yaml`）                                                          |
| `--stage <stage>`           | stage 名（Git より優先）                                                                           |
| `--version <version>`       | version 名（Git より優先）                                                                         |
| `--branch <branch>`         | 解決する Git ブランチ（既定: 現在のブランチ）                                                      |
| `--pr <number>`             | 解決する PR 番号（正の整数）                                                                       |
| `--default-branch <branch>` | リポジトリのデフォルトブランチ                                                                     |
| `--region <region>`         | AWS リージョン（既定: `AWS_REGION`、`AWS_DEFAULT_REGION`、`CDK_DEFAULT_REGION`、`us-east-1` の順） |

解決の優先順位は `--stage` + `--version` の明示 > `--pr` > `--branch` > 現在の Git（CI では GitHub のイベント）です。既定のマッピングはデフォルトブランチ = `prod/current`、PR = `preview/pr-<番号>`。`--stage` だけ指定すると version は Git から導き、導けなければ `current` です。`--stage preview --version pr-5` は `--pr 5` と同じ PR プレビュー扱いです。

## プロジェクトの作成と検証

### `flareon init [dir]`

`flareon.yaml`・スターターアプリ・`.github/workflows/flareon.yml` を作ります（既存の `flareon.yaml` があるとエラー、ワークフローは既存なら触りません）。ワークフローの `on.push.branches` は `flareon.yaml` の `git.production.branch` / `git.preview.branch`（`default` はデフォルトブランチ名に置換）から作られます。`.gitignore` に `.flareon/` を追記します。

| オプション            | 内容                                |
| --------------------- | ----------------------------------- |
| `--runtime <runtime>` | `python`（既定）または `typescript` |

### `flareon validate`

`flareon.yaml` を検証します。オプションは `-f, --file <path>` のみ。不正なら `flareon.yaml is invalid:` に続けてキーごとのエラーを表示して終了コード 1。`.github/workflows/flareon.yml` が既にあり、その `on.push.branches` が `git` 設定と食い違うときは `Warning:` を表示します（終了コードは 0）。

### `flareon workflow generate`

`flareon.yaml` の `git` 設定（production / preview のブランチ）から `.github/workflows/flareon.yml` を生成します。`git.production.branch: "release/*"` などを変更した後に再生成するために使います。ワークフローが無ければ作成、現在の設定と同じなら `up to date`、異なる既存ファイルは `--force` なしでは変更せず終了コード 1 です。

| オプション                  | 内容                                                         |
| --------------------------- | ------------------------------------------------------------ |
| `-f, --file <path>`         | 設定ファイルのパス（既定: `flareon.yaml`）                   |
| `--force`                   | 異なる既存ワークフローを上書きする（手元の編集は失われます） |
| `--default-branch <branch>` | リポジトリのデフォルトブランチ（既定: Git から検出）         |

### `flareon synth`

CDK Cloud Assembly を `.flareon/out/` に生成します（デバッグ用。AWS には変更を加えません）。共通オプションを受け取ります。

### `flareon plan`

デプロイ済みの状態と比較して、何が作られる／変わるかを Flareon の概念で表示します（変更はしません）。共通オプションを受け取ります。

## デプロイと削除

### `flareon deploy`

AWS にデプロイして URL を表示します。共通オプションに加えて次を受け取ります。

| オプション | 内容                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| `--ci`     | GitHub Actions モード。イベントからデプロイ先を導く（クローズ済み PR は何もしない） |

外部 IdP を使う永続 stage で資格情報が未設定だと、作成前に `flareon secret set ...` と IdP に登録するリダイレクト URI を表示して終了します。

### `flareon destroy`

バージョンを削除します（PR プレビューは丸ごと削除）。共通オプションに加えて次を受け取ります。

| オプション          | 内容                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------- |
| `--stage-resources` | その stage の DB・ストレージ・ユーザー・シークレットも **完全に削除**（元に戻せない） |
| `-y, --yes`         | `--stage-resources` の確認                                                            |
| `--ci`              | GitHub Actions モード。クローズ済みの PR のときだけ動く                               |

`--stage-resources` は `--yes` が無いとエラーで止まります。同じ stage に他の version が残っているときも拒否されます。

## 環境の確認

### `flareon env list`

デプロイ済みの stage / version を一覧します。オプション: `-f, --file <path>`、`--region <region>`。

### `flareon env url`

デプロイ済みバージョンの URL を表示します。共通オプションに加えて次を受け取ります。

| オプション     | 内容                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| `--with-token` | PR プレビューのマジックリンク（**プレビュートークンを含む**）を表示。PR プレビュー以外ではエラー |

### `flareon logs`

アプリのログを表示します。共通オプションに加えて次を受け取ります。

| オプション           | 内容                                                         |
| -------------------- | ------------------------------------------------------------ |
| `--since <duration>` | どこまで遡るか（例 `30s`、`10m`、`2h`、`1d`。既定 `10m`）    |
| `--follow`           | 新しいログを追従（CloudWatch Logs Live Tail）。Ctrl-C で終了 |

## シークレット

値は **コマンド引数には取りません**。stdin（パイプ）か、TTY ならエコー無しのプロンプトで渡します。

### `flareon secret set <name>`

`flareon.yaml` の `secrets:` に宣言済みの名前だけ設定できます（外部 IdP の資格情報は例外で、宣言不要）。共通オプションを受け取ります。値が空だとエラー。

```bash
printf '%s' "$VALUE" | flareon secret set EXTERNAL_API_KEY --stage prod
```

### `flareon secret list`

シークレットを一覧します（値は表示しません）。共通オプションを受け取ります。

### `flareon secret delete <name>`

シークレットを削除します。共通オプションを受け取ります。

## 認証ユーザー

Cognito（既定の招待制）の stage だけが対象です。`auth: false` の stage や PR プレビューではエラーになります。

### `flareon auth user add <email>`

ユーザーを招待します（仮パスワードがメールで届く）。共通オプションを受け取ります。外部 IdP の stage では「招待ユーザーはサインインに使えない」と警告します。

### `flareon auth user list`

ユーザーを一覧します。共通オプションを受け取ります。

### `flareon auth user remove <email>`

ユーザーを削除します。共通オプションを受け取ります。削除したユーザーの既存セッションも止めるため、その stage の **全員のセッションを失効** させます（最大 60 秒で反映、他のユーザーはサインインし直し）。

### `flareon auth revoke-sessions`

その環境の Flareon セッション（Cookie、最長 8 時間）をすべて失効させます（最大 60 秒で反映）。共通オプションを受け取ります。永続 stage は stage 単位、PR プレビューは `--pr <番号>` でそのプレビューだけ。`auth: false` の永続 stage ではエラー、未デプロイ（またはこの機能より前のデプロイ）なら `flareon deploy` を案内して終了します。

## ローカル開発

### `flareon dev`

アプリをホットリロード付きでローカル起動し、AWS の dev 用 DB／ストレージに接続します（既定の dev 環境は `preview/local-<OS ユーザー名>`）。

| オプション            | 内容                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| `-f, --file <path>`   | 設定ファイルのパス（既定 `flareon.yaml`）                                                      |
| `--port <port>`       | ローカルのポート（既定 8787）                                                                  |
| `--stage <stage>`     | 既存の環境に接続する（`--version` とセットで指定）                                             |
| `--version <version>` | 既存の環境に接続する（`--stage` とセットで指定）                                               |
| `--as <email>`        | サインイン済みユーザーを装う（`x-flareon-*` の identity ヘッダを付ける。email は検証済み扱い） |
| `--region <region>`   | AWS リージョン                                                                                 |

`FLAREON_OFFLINE=1` を付けると AWS に接続せずアプリだけ起動します。プロキシは `localhost` / `127.0.0.1` / `[::1]` 宛て以外の Host を 403 にし、`--as` のときは他サイトからのリクエスト（Origin が別、`Sec-Fetch-Site: cross-site`）も 403 にします。アプリには `HOST=127.0.0.1` と `FLAREON_DEV_SECRET` が渡り、プロキシ経由のリクエストにだけ同じ値の `x-flareon-dev-secret` が付きます。dev 環境の削除は `flareon destroy --stage preview --version local-<user>`。

## GitHub Actions 連携

### `flareon github comment`

PR コメントと GitHub Deployment を作成／更新します（CI 用。`GITHUB_TOKEN` と GitHub Actions 環境が必要）。共通オプションに加えて次を受け取ります。

| オプション        | 内容                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `--state <state>` | `success`（既定）/ `failure` / `inactive`                                                 |
| `--with-token`    | トークン付きマジックリンクをコメントに載せる。**private リポジトリのみ**（public は拒否） |

### `flareon bootstrap github`

GitHub Actions が OIDC で assume する IAM ロールを作成／削除します（管理者権限の認証情報で、リポジトリごとに 1 回）。

| オプション                | 内容                                                |
| ------------------------- | --------------------------------------------------- |
| `--repo <owner/name>`     | **必須**。GitHub リポジトリ                         |
| `--destroy`               | ロール（と Flareon が作った OIDC プロバイダ）を削除 |
| `--qualifier <qualifier>` | CDK bootstrap の qualifier（既定 `hnb659fds`）      |
| `--region <region>`       | AWS リージョン                                      |

## スキル

### `flareon skill install`

同梱の Agent Skill をインストールします。実体は `<root>/.agents/skills/flareon/`、`<root>/.claude/skills/flareon` はそこへの相対シンボリックリンクです。

| オプション     | 内容                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| `--global`     | ホームディレクトリに入れる（`~/.agents/skills/flareon`、`~/.claude/skills/flareon`） |
| `--dir <path>` | プロジェクトのルートを指定（既定: カレントディレクトリ）。`--global` とは併用不可    |
| `--force`      | 既存のインストールを置き換える（無いと、既存があれば拒否）                           |

## シェル補完

### `flareon completion <shell>`

シェル補完スクリプトを標準出力に出します。対応は `zsh` のみ（それ以外は `unsupported shell` のエラーで終了コード 1）。スクリプトは CLI のコマンド定義から生成されるので、コマンドやオプションを足すと補完にも反映されます。

```bash
flareon completion zsh > "${fpath[1]}/_flareon"      # fpath に置く
eval "$(flareon completion zsh)"                      # または ~/.zshrc に書く（compinit の後）
```

補完されるのはコマンド・サブコマンド・オプション（説明つき）と、`--runtime`（python / typescript）、`--state`（success / failure / inactive）、`-f/--file`・`--dir`（ファイル／ディレクトリ）の値です。`--stage` / `--version` は AWS を呼ばないため補完しません。

## 環境変数

| 変数                                                    | 内容                                                       |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `AWS_REGION` / `AWS_DEFAULT_REGION`                     | リージョン（`--region` が優先、未指定は `us-east-1`）      |
| `FLAREON_OFFLINE=1`                                     | `flareon dev` を AWS 無しで起動                            |
| `GITHUB_ACTIONS` / `GITHUB_EVENT_NAME` / `GITHUB_TOKEN` | `--ci` と `github comment` が使う（GitHub Actions が設定） |
