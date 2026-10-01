---
name: flarelet
description: Use the Flarelet CLI to deploy and operate web apps on AWS serverless (Lambda, DynamoDB, S3, Bedrock, Cognito) from a single flarelet.yaml. Use when the user mentions flarelet, flarelet.yaml, or wants to deploy to AWS serverless, create a preview environment per pull request, manage stages and versions, set secrets, invite sign-in users, tail logs, run flarelet dev locally, or destroy a deployment.
---

# Flarelet

Flarelet は、`flarelet.yaml` 1 枚と `flarelet deploy` で Web アプリを AWS（Lambda / DynamoDB / S3 / Bedrock / Cognito）に公開するサーバーレスのプラットフォームです。IAM や CDK は書きません。アプリは普通の Web アプリ（Python は ASGI、TypeScript は Hono など）です。

コマンドの全オプションは [references/cli.md](references/cli.md)、`flarelet.yaml` の全キーは [references/flarelet-yaml.md](references/flarelet-yaml.md) を読んでください。推測でオプションやキーを書かず、まずそこで確認します。

## インストール

npm に公開されています（Node.js 24 以上）。`flarelet` コマンドが無ければ `npx flarelet@latest <コマンド>` で実行するか、`npm i -g flarelet` で導入します。

このスキル自体は 2 通りで入れられます。エージェント横断で GitHub の最新版を入れるなら `npx skills add youyo/flarelet`（`-a claude-code` 等で対象エージェントを指定、`-g` でグローバル、更新は `npx skills update`）。インストール済みの CLI と同じバージョンのスキルを入れるなら `flarelet skill install`（`--global` でホームに入れる）。

## メンタルモデル

- **設定は `flarelet.yaml` だけ**: ランタイム、`http`、`database`、`storage`、`ai`、`secrets`、`git` を宣言します。変更したら `flarelet validate`
- **App -> Stage -> Version**: アプリ（`name`）の下に stage（`prod` / `preview` など）、その下に version（`current` / `v1` / `pr-5` など）。デプロイ先は `<stage>/<version>`
- **スコープ**: DB・ストレージ・ユーザー（Cognito）・シークレットは **stage スコープ**で、同じ stage の version 間で共有されます。HTTP エンドポイントとアプリのコードは **version スコープ**です
- **デプロイ先は Git から決まる**: 既定はデフォルトブランチ = `prod/current`、PR = `preview/pr-<番号>`。`--stage` と `--version` で明示できます。`git:` でブランチのマッピングを変えられます
- **PR プレビューは使い捨て**: `preview/pr-<番号>` だけが ephemeral。DB・ストレージは空で新規作成され、本番データは複製されません。PR を閉じると削除されます
- **認証は既定で ON**: `http: true` は Cognito の招待制。PR プレビューは `auth: false` でも Preview Auth（トークン付きリンク）で保護されます
- AWS の認証情報とリージョンは、デプロイ先の AWS アカウントに対して有効なものが必要です（`--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > `us-east-1`）
- **CDK bootstrap**: アカウント・リージョンごとに 1 回必要です。通常は初回の `flarelet deploy`（対話端末）が自動で行います。CI（`--ci`）・非対話・`--no-bootstrap` では自動で行わないので、事前に `flarelet bootstrap aws --region <region>` を一度実行します

## 典型ワークフロー

### 新規プロジェクト

```bash
flarelet init myapp --runtime python   # または typescript
cd myapp
flarelet validate                      # flarelet.yaml を検証
flarelet plan                          # 何が作られるかを確認（変更なし）
flarelet deploy                        # デプロイして URL を表示（初回は CDK bootstrap も自動で行う）
flarelet logs --since 10m              # ログを確認
```

`init` は `flarelet.yaml`・`app/`・`.github/workflows/flarelet.yml` を作ります。デプロイ前に **必ず `flarelet plan` の結果をユーザーに見せ、対象のアカウントとリージョンを確認**してください。

### シークレットとユーザー

```bash
# flarelet.yaml の secrets: に名前を宣言してから、値は stdin で渡す
printf '%s' "$EXTERNAL_API_KEY" | flarelet secret set EXTERNAL_API_KEY --stage prod
flarelet secret list --stage prod      # 名前だけ表示（値は出ない）
flarelet auth user add me@example.com --stage prod   # 招待メールを送る
flarelet auth user list --stage prod
flarelet auth revoke-sessions --stage prod          # 全セッションを失効（最大 60 秒で反映）
```

### PR プレビュー（GitHub Actions）

1. 管理者権限でリポジトリごとに 1 回: `flarelet bootstrap aws --region ap-northeast-1`（アカウント・リージョンごとに 1 回。CI は自動で bootstrap しない）→ `flarelet bootstrap github --repo owner/name --region ap-northeast-1`。表示された案内に従い `gh variable set FLARELET_AWS_ROLE_ARN` / `FLARELET_AWS_REGION` を設定
2. `flarelet init` が作ったワークフローをコミットして push。`flarelet.yaml` の `git.production.branch` / `git.preview.branch` を変えたら `flarelet workflow generate --force` で再生成する（push トリガーのブランチがそれに連動する。`flarelet validate` が食い違いを警告）。PR の open / synchronize で `flarelet deploy --ci`、close で `flarelet destroy --ci` が走る
3. プレビューの URL は PR コメントに出ます。ブラウザで開くためのトークン付きリンクは `flarelet env url --pr 5 --with-token`

### ローカル開発

```bash
flarelet dev                          # http://localhost:8787 。DB/ストレージは AWS の dev 用に接続
flarelet dev --as alice@example.com   # サインイン済みユーザーとして動かす
FLARELET_OFFLINE=1 flarelet dev        # AWS に接続せずアプリだけ起動
```

### 確認と削除

```bash
flarelet env list                     # デプロイ済みの stage / version
flarelet env url --stage prod --version current
flarelet destroy --stage staging --version v1   # この version だけ削除（データは残る）
```

## アプリ側の規約

- Python: `app/main.py` の `app`（ASGI）と `app/requirements.txt`。TypeScript: `app/index.ts` と `app/package.json`（`PORT` で listen、ポート 8080）
- DB / ストレージ / AI / シークレットは環境変数で受け取ります（`FLARELET_DATABASE_<NAME>_TABLE`、`FLARELET_STORAGE_<NAME>_BUCKET`、`FLARELET_AI_<NAME>_MODEL_ID`、シークレットは宣言した名前そのまま）
- 認証済みユーザーは `x-flarelet-user-sub` / `x-flarelet-user-email` / `x-flarelet-user-email-verified`（`true`|`false`）ヘッダで渡ります（TypeScript は `flarelet/runtime` の `identity(headers)` が `sub` / `email` / `emailVerified` を返す）。**ユーザーの識別・認可には `sub` を使ってください**。email は IdP によっては未検証の値が入るので、email を使うなら `emailVerified`（ヘッダが `true`）のときだけにする（Entra ID は常に `false`）
- TypeScript アプリは `hostname: process.env.HOST ?? "127.0.0.1"` で listen する（全インターフェースで listen しない）。`flarelet dev` では `identity()` が `FLARELET_DEV_SECRET` と `x-flarelet-dev-secret` の一致を確認します。Python で identity を使う場合は同じ確認（`FLARELET_DEV_SECRET` が設定されていればヘッダと一致するときだけ信用）を自分で書く
- `auth: false` の stage ではクライアントが `x-flarelet-*` ヘッダを偽装できます。アプリはこれらを信頼せず、`FLARELET_AUTH_ENABLED` が `true` のときだけ使います

## 安全上のルール

必ず守ってください。

1. **`flarelet destroy --stage-resources --yes` は本番データを永久に消します**（DB・ストレージ・ユーザー・シークレット）。実行前に **対象の stage と消えるものをユーザーに伝え、明確な承認を得る**こと。`--yes` を自分の判断で付けない。`--stage-resources` なしの `destroy` は version だけを消し、データは残ります
2. **シークレットの値をコマンド引数に渡さない。** 値は stdin（パイプ）か対話プロンプトで渡す。値をログ・コミット・会話に出さない。`flarelet secret set NAME value` のような形は存在せず、拒否されます
3. **`http: { auth: false }`（認証なしの公開）は、ユーザーが明示的に指示したときだけ**書く。既定の `http: true` を勝手に外さない
4. **PR プレビューのトークン（`env url --with-token` の出力）を公開の場に貼らない。** public リポジトリの PR コメントやイシュー、チャットに載せない。`flarelet github comment --with-token` は private リポジトリ専用
5. **デプロイ前に AWS のアカウントとリージョンを確認する。** 意図しないアカウントに作らないよう、`deploy` / `destroy` / `secret set` / `auth user` の前に対象（`<app> (<stage>/<version>)` と `account/region`）をユーザーに示す
6. 永続 stage（`prod` など）への `deploy` / `destroy` は、ユーザーが対象を指定したときだけ実行する。迷ったら `flarelet plan` や `flarelet env list` で先に確認する
7. 外部 IdP を使うときは `allow` で入れる人を絞る（Google は Workspace の Internal 設定と `allow.domains` の併用を推奨）

## トラブルシュート

エラーメッセージは英語です。

| 症状（メッセージ）                                                                                               | 原因と対処                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Error: cannot reach AWS: ...`                                                                                   | AWS 資格情報が未設定／期限切れ、またはリージョン違い。`aws sts get-caller-identity` で確認し、SSO ならログインし直す。`--region` か `AWS_REGION` を確認                                                                                    |
| `Error: <account>/<region> is not bootstrapped for Flarelet. Run: flarelet bootstrap aws --region <region>`      | CDK bootstrap が未実施。`--ci`・非対話・`--no-bootstrap` では自動で行わない。`flarelet bootstrap aws --region <region>` を一度実行する（対話端末の `flarelet deploy` / `flarelet dev` は自動で行う。非対話で自動にするなら `--bootstrap`） |
| `Deployment failed: ...`（`/cdk-bootstrap/` に触れる内容）                                                       | bootstrap が古い・壊れている可能性。`flarelet bootstrap aws` は既存の `CDKToolkit` を更新しないので、管理者が CDK の手順で更新する                                                                                                         |
| `Error: sign-in with google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for the prod stage. Set them first:` | 外部 IdP の資格情報が無い。続けて表示される `flarelet secret set <名前> --stage <stage>` を実行（値は stdin）し、表示された `Register this redirect URI ...` を IdP に登録してから再 deploy                                                |
| `branch "x" does not match any deployment target (production: "...")`                                            | そのブランチは `git:` のマッピングに無い。`--stage` と `--version` で明示するか、`git.production.branch` / `git.preview.branch` を見直す                                                                                                   |
| `cannot resolve a deployment: no Git ref available; pass --stage and --version`                                  | Git の ref が取れない（Git 管理外、コミット前など）。`--stage` と `--version` を渡す                                                                                                                                                       |
| `pull request previews are disabled (git.pullRequests: false); ...`                                              | `git.pullRequests: false` になっている。PR プレビューが必要なら `true` に                                                                                                                                                                  |
| `Error: <path>/flarelet.yaml not found`                                                                          | カレントディレクトリが違う。プロジェクトのルートに移動するか `-f/--file` を指定                                                                                                                                                            |
| `flarelet.yaml is invalid:` に続くキーごとのエラー                                                               | [references/flarelet-yaml.md](references/flarelet-yaml.md) と照らして直し、`flarelet validate` を再実行                                                                                                                                    |
| `Error: secret X is not declared in flarelet.yaml (declared: ...); add it under `secrets:` first`                | `flarelet.yaml` の `secrets:` に名前を追加してから `secret set`（外部 IdP の資格情報は宣言不要）                                                                                                                                           |
| `Error: the secret value is empty`                                                                               | stdin が空。`printf '%s' "$VALUE" \| flarelet secret set NAME` のように値を渡す                                                                                                                                                            |
| `Error: --stage-resources permanently deletes ...; add --yes to confirm`                                         | 意図どおりか **ユーザーに確認**。承認が得られたときだけ `--yes` を付ける                                                                                                                                                                   |
| `Error: other versions of prod are still deployed (...); destroy them first`                                     | stage のデータを消すには、その stage の他の version を先に削除する                                                                                                                                                                         |
| `Error: <app> (<stage>/<version>) is not deployed` / `... is not deployed yet; run flarelet deploy`              | まだデプロイされていない、または stage／version／リージョンの指定違い。`flarelet env list` で確認                                                                                                                                          |
| `Error: authentication is disabled for this app (http.auth: false)`                                              | `auth user` はサインイン認証がある stage だけ。PR プレビューは `flarelet env url --pr <番号> --with-token` を使う                                                                                                                          |
| `Error: --with-token is only available for PR previews (...)`                                                    | トークンは PR プレビュー専用。`--pr <番号>` を付ける                                                                                                                                                                                       |
| `Error: --ci requires GitHub Actions (GITHUB_ACTIONS=true and GITHUB_EVENT_NAME)`                                | `--ci` は GitHub Actions 上でのみ。手元では `--stage` / `--version` / `--pr` を使う                                                                                                                                                        |
| `Error: invalid --since "x" (use e.g. 30s, 10m, 2h, 1d)`                                                         | `--since` の書式を直す                                                                                                                                                                                                                     |

それでも解決しないときは、`flarelet plan` と `flarelet synth`（`.flarelet/out/` を生成、AWS は変更しない）で状況を切り分け、エラー全文をユーザーに共有してください。

## 制約（v0）

応答サイズは 6MB まで、リクエストは 30 秒以内。カスタムドメインは未対応。PR プレビューはフォークからの PR に対応しません。
