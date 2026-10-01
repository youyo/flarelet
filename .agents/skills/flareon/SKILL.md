---
name: flareon
description: Use the Flareon CLI to deploy and operate web apps on AWS serverless (Lambda, DynamoDB, S3, Bedrock, Cognito) from a single flareon.yaml. Use when the user mentions flareon, flareon.yaml, or wants to deploy to AWS serverless, create a preview environment per pull request, manage stages and versions, set secrets, invite sign-in users, tail logs, run flareon dev locally, or destroy a deployment.
---

# Flareon

Flareon は、`flareon.yaml` 1 枚と `flareon deploy` で Web アプリを AWS（Lambda / DynamoDB / S3 / Bedrock / Cognito）に公開するサーバーレスのプラットフォームです。IAM や CDK は書きません。アプリは普通の Web アプリ（Python は ASGI、TypeScript は Hono など）です。

コマンドの全オプションは [references/cli.md](references/cli.md)、`flareon.yaml` の全キーは [references/flareon-yaml.md](references/flareon-yaml.md) を読んでください。推測でオプションやキーを書かず、まずそこで確認します。

## メンタルモデル

- **設定は `flareon.yaml` だけ**: ランタイム、`http`、`database`、`storage`、`ai`、`secrets`、`git` を宣言します。変更したら `flareon validate`
- **App -> Stage -> Version**: アプリ（`name`）の下に stage（`prod` / `preview` など）、その下に version（`current` / `v1` / `pr-5` など）。デプロイ先は `<stage>/<version>`
- **スコープ**: DB・ストレージ・ユーザー（Cognito）・シークレットは **stage スコープ**で、同じ stage の version 間で共有されます。HTTP エンドポイントとアプリのコードは **version スコープ**です
- **デプロイ先は Git から決まる**: 既定はデフォルトブランチ = `prod/current`、PR = `preview/pr-<番号>`。`--stage` と `--version` で明示できます。`git:` でブランチのマッピングを変えられます
- **PR プレビューは使い捨て**: `preview/pr-<番号>` だけが ephemeral。DB・ストレージは空で新規作成され、本番データは複製されません。PR を閉じると削除されます
- **認証は既定で ON**: `http: true` は Cognito の招待制。PR プレビューは `auth: false` でも Preview Auth（トークン付きリンク）で保護されます
- AWS の認証情報とリージョンは、デプロイ先の AWS アカウントに対して有効なものが必要です（`--region` > `AWS_REGION` > `AWS_DEFAULT_REGION` > `us-east-1`）

## 典型ワークフロー

### 新規プロジェクト

```bash
flareon init myapp --runtime python   # または typescript
cd myapp
flareon validate                      # flareon.yaml を検証
flareon plan                          # 何が作られるかを確認（変更なし）
flareon deploy                        # デプロイして URL を表示
flareon logs --since 10m              # ログを確認
```

`init` は `flareon.yaml`・`app/`・`.github/workflows/flareon.yml` を作ります。デプロイ前に **必ず `flareon plan` の結果をユーザーに見せ、対象のアカウントとリージョンを確認**してください。

### シークレットとユーザー

```bash
# flareon.yaml の secrets: に名前を宣言してから、値は stdin で渡す
printf '%s' "$EXTERNAL_API_KEY" | flareon secret set EXTERNAL_API_KEY --stage prod
flareon secret list --stage prod      # 名前だけ表示（値は出ない）
flareon auth user add me@example.com --stage prod   # 招待メールを送る
flareon auth user list --stage prod
flareon auth revoke-sessions --stage prod          # 全セッションを失効（最大 60 秒で反映）
```

### PR プレビュー（GitHub Actions）

1. 管理者権限でリポジトリごとに 1 回: `flareon bootstrap github --repo owner/name --region ap-northeast-1`。表示された案内に従い `gh variable set FLAREON_AWS_ROLE_ARN` / `FLAREON_AWS_REGION` を設定
2. `flareon init` が作ったワークフローをコミットして push。PR の open / synchronize で `flareon deploy --ci`、close で `flareon destroy --ci` が走る
3. プレビューの URL は PR コメントに出ます。ブラウザで開くためのトークン付きリンクは `flareon env url --pr 5 --with-token`

### ローカル開発

```bash
flareon dev                          # http://localhost:8787 。DB/ストレージは AWS の dev 用に接続
flareon dev --as alice@example.com   # サインイン済みユーザーとして動かす
FLAREON_OFFLINE=1 flareon dev        # AWS に接続せずアプリだけ起動
```

### 確認と削除

```bash
flareon env list                     # デプロイ済みの stage / version
flareon env url --stage prod --version current
flareon destroy --stage staging --version v1   # この version だけ削除（データは残る）
```

## アプリ側の規約

- Python: `app/main.py` の `app`（ASGI）と `app/requirements.txt`。TypeScript: `app/index.ts` と `app/package.json`（`PORT` で listen、ポート 8080）
- DB / ストレージ / AI / シークレットは環境変数で受け取ります（`FLAREON_DATABASE_<NAME>_TABLE`、`FLAREON_STORAGE_<NAME>_BUCKET`、`FLAREON_AI_<NAME>_MODEL_ID`、シークレットは宣言した名前そのまま）
- 認証済みユーザーは `x-flareon-user-sub` / `x-flareon-user-email` / `x-flareon-user-email-verified`（`true`|`false`）ヘッダで渡ります（TypeScript は `flareon/runtime` の `identity(headers)` が `sub` / `email` / `emailVerified` を返す）。**ユーザーの識別・認可には `sub` を使ってください**。email は IdP によっては未検証の値が入るので、email を使うなら `emailVerified`（ヘッダが `true`）のときだけにする（Entra ID は常に `false`）
- TypeScript アプリは `hostname: process.env.HOST ?? "127.0.0.1"` で listen する（全インターフェースで listen しない）。`flareon dev` では `identity()` が `FLAREON_DEV_SECRET` と `x-flareon-dev-secret` の一致を確認します。Python で identity を使う場合は同じ確認（`FLAREON_DEV_SECRET` が設定されていればヘッダと一致するときだけ信用）を自分で書く
- `auth: false` の stage ではクライアントが `x-flareon-*` ヘッダを偽装できます。アプリはこれらを信頼せず、`FLAREON_AUTH_ENABLED` が `true` のときだけ使います

## 安全上のルール

必ず守ってください。

1. **`flareon destroy --stage-resources --yes` は本番データを永久に消します**（DB・ストレージ・ユーザー・シークレット）。実行前に **対象の stage と消えるものをユーザーに伝え、明確な承認を得る**こと。`--yes` を自分の判断で付けない。`--stage-resources` なしの `destroy` は version だけを消し、データは残ります
2. **シークレットの値をコマンド引数に渡さない。** 値は stdin（パイプ）か対話プロンプトで渡す。値をログ・コミット・会話に出さない。`flareon secret set NAME value` のような形は存在せず、拒否されます
3. **`http: { auth: false }`（認証なしの公開）は、ユーザーが明示的に指示したときだけ**書く。既定の `http: true` を勝手に外さない
4. **PR プレビューのトークン（`env url --with-token` の出力）を公開の場に貼らない。** public リポジトリの PR コメントやイシュー、チャットに載せない。`flareon github comment --with-token` は private リポジトリ専用
5. **デプロイ前に AWS のアカウントとリージョンを確認する。** 意図しないアカウントに作らないよう、`deploy` / `destroy` / `secret set` / `auth user` の前に対象（`<app> (<stage>/<version>)` と `account/region`）をユーザーに示す
6. 永続 stage（`prod` など）への `deploy` / `destroy` は、ユーザーが対象を指定したときだけ実行する。迷ったら `flareon plan` や `flareon env list` で先に確認する
7. 外部 IdP を使うときは `allow` で入れる人を絞る（Google は Workspace の Internal 設定と `allow.domains` の併用を推奨）

## トラブルシュート

エラーメッセージは英語です。

| 症状（メッセージ）                                                                                               | 原因と対処                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Error: cannot reach AWS: ...`                                                                                   | AWS 資格情報が未設定／期限切れ、またはリージョン違い。`aws sts get-caller-identity` で確認し、SSO ならログインし直す。`--region` か `AWS_REGION` を確認                                    |
| `Deployment failed: ...`（bootstrap／`/cdk-bootstrap/` に触れる内容）                                            | 対象のアカウント・リージョンで CDK bootstrap が未実施の可能性が高い。README のとおり `cdk bootstrap` を済ませる（Flareon 専用のチェックは無く、CDK のエラーが出る）                        |
| `Error: sign-in with google needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for the prod stage. Set them first:` | 外部 IdP の資格情報が無い。続けて表示される `flareon secret set <名前> --stage <stage>` を実行（値は stdin）し、表示された `Register this redirect URI ...` を IdP に登録してから再 deploy |
| `branch "x" does not match any deployment target (production: "...")`                                            | そのブランチは `git:` のマッピングに無い。`--stage` と `--version` で明示するか、`git.production.branch` / `git.preview.branch` を見直す                                                   |
| `cannot resolve a deployment: no Git ref available; pass --stage and --version`                                  | Git の ref が取れない（Git 管理外、コミット前など）。`--stage` と `--version` を渡す                                                                                                       |
| `pull request previews are disabled (git.pullRequests: false); ...`                                              | `git.pullRequests: false` になっている。PR プレビューが必要なら `true` に                                                                                                                  |
| `Error: <path>/flareon.yaml not found`                                                                           | カレントディレクトリが違う。プロジェクトのルートに移動するか `-f/--file` を指定                                                                                                            |
| `flareon.yaml is invalid:` に続くキーごとのエラー                                                                | [references/flareon-yaml.md](references/flareon-yaml.md) と照らして直し、`flareon validate` を再実行                                                                                       |
| `Error: secret X is not declared in flareon.yaml (declared: ...); add it under `secrets:` first`                 | `flareon.yaml` の `secrets:` に名前を追加してから `secret set`（外部 IdP の資格情報は宣言不要）                                                                                            |
| `Error: the secret value is empty`                                                                               | stdin が空。`printf '%s' "$VALUE" \| flareon secret set NAME` のように値を渡す                                                                                                             |
| `Error: --stage-resources permanently deletes ...; add --yes to confirm`                                         | 意図どおりか **ユーザーに確認**。承認が得られたときだけ `--yes` を付ける                                                                                                                   |
| `Error: other versions of prod are still deployed (...); destroy them first`                                     | stage のデータを消すには、その stage の他の version を先に削除する                                                                                                                         |
| `Error: <app> (<stage>/<version>) is not deployed` / `... is not deployed yet; run flareon deploy`               | まだデプロイされていない、または stage／version／リージョンの指定違い。`flareon env list` で確認                                                                                           |
| `Error: authentication is disabled for this app (http.auth: false)`                                              | `auth user` はサインイン認証がある stage だけ。PR プレビューは `flareon env url --pr <番号> --with-token` を使う                                                                           |
| `Error: --with-token is only available for PR previews (...)`                                                    | トークンは PR プレビュー専用。`--pr <番号>` を付ける                                                                                                                                       |
| `Error: --ci requires GitHub Actions (GITHUB_ACTIONS=true and GITHUB_EVENT_NAME)`                                | `--ci` は GitHub Actions 上でのみ。手元では `--stage` / `--version` / `--pr` を使う                                                                                                        |
| `Error: invalid --since "x" (use e.g. 30s, 10m, 2h, 1d)`                                                         | `--since` の書式を直す                                                                                                                                                                     |

それでも解決しないときは、`flareon plan` と `flareon synth`（`.flareon/out/` を生成、AWS は変更しない）で状況を切り分け、エラー全文をユーザーに共有してください。

## 制約（v0）

応答サイズは 6MB まで、リクエストは 30 秒以内。カスタムドメインは未対応。PR プレビューはフォークからの PR に対応しません。
