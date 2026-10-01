# Flareon v0 実装上の決定事項

`FLAREON_V0_DESIGN.md` を補完する、実装開始時に確定した判断。仕様と矛盾する場合は仕様を優先し、本書を更新する。

## 全体
- Node 24 / TypeScript（ESM）。ランタイム・タスクは `mise.toml` で管理し、`mise run <task>` で実行する
- 単一 npm パッケージ `flareon`。runtime bindings はサブパス export `flareon/runtime`
- CDK は `aws-cdk-lib` + `@aws-cdk/toolkit-lib` をプログラムから呼ぶ（グローバル `cdk` CLI に依存しない）
- 生成物は `<app>/.flareon/out/`（Cloud Assembly）、`.flareon/metadata.json`
- CLI の出力は英語
- テスト: vitest。Unit（`test/unit`）と E2E（`test/e2e`）
  - E2E（常時）: ビルドした CLI バイナリを実プロセスで起動し、`init` / `synth` / `plan` 等の出力・終了コード・生成テンプレートを検証
  - E2E（オプトイン）: `FLAREON_E2E_AWS=1` のときだけ実 AWS に deploy → HTTP/認証を確認 → destroy

## Config → IR → Resolver → Constructs
- YAML の型はそのまま CDK に渡さない。正規化済み Flareon IR を境界にする
- `http: true` は `http: { auth: true }` と同義。auth 省略時は true。`auth: false` のみ公開
- Deployment Resolver: Git ref / CLI 引数 → `{ stage, version }`
  - 既定: default branch → `prod/current`（stage 名は `prod`。設定キーは `git.production`）、PR → `preview/pr-{n}`
  - 仕様 §8 の `git.production.branch` glob + `version: branch`（`release/v1` → `prod/v1`）、`git.preview.branch: default`

## スタック構成（ライフサイクルスコープ）
- 永続ステージ: stage スタック（Auth=Cognito User Pool + ドメイン、Database、Storage、Secrets 参照、Cookie 署名鍵）と version スタック（HTTP API、front auth Lambda、app Lambda、Cognito app client）
- PR preview: 1 スタックに全部（DB/Storage は空で新規、Preview Auth）。本番データは複製しない
- スタック名例: `flareon-{app}-{stage}`、`flareon-{app}-{stage}-{version}`

## 認証（advisor 合意済み）
- HTTP API の `$default` ルート → **front auth Lambda（Node）** → セッション Cookie 検証 → app Lambda を同期 Invoke（HTTP API v2 イベントを転送）
  - 理由: HTTP API の Lambda authorizer はリダイレクト不可、gateway response のカスタマイズ不可
  - front はクライアント由来の `x-flareon-*` ヘッダを必ず削除してから identity ヘッダ（`x-flareon-user-sub`、`x-flareon-user-email` 等）を付与
  - app Lambda は front からのみ Invoke 可能（IAM）
  - タイムアウト: app < front <= 30s。app のタイムアウトは 504 に変換
  - 応答上限 6MB（制約として明記）
- エンドポイント: `/__flareon/auth/login`、`/__flareon/auth/callback`、`/__flareon/auth/logout`
- Cognito: User Pool は stage スコープ。app client は **version スタック**で作る（HTTP API URL は Api 作成時に確定 → client の callback → auth Lambda env の順で非循環）。public client + PKCE。ドメインプレフィックスは決定的に自動生成（`{app}-{stage}-{短縮ハッシュ}`）
- Cookie 署名鍵と Preview トークンは Secrets Manager `GenerateSecretString`（CFN ネイティブ）で生成。署名鍵は stage スコープ（preview は preview スタック内）
- Preview Auth: front Lambda のモード切替。トークンは preview スタックの Secrets Manager secret。`/__flareon/auth/preview?token=...` のマジックリンクで Cookie 発行。トークンは CLI（例: `flareon env url --with-token`）で取得。CI ログには出さない
- `auth: false` の場合は front Lambda を置かず HTTP API → app Lambda 直結

## ランタイム
- app Lambda は Lambda Web Adapter（レイヤー）で Web アプリをそのまま動かす。ポート 8080
- Python: `app/main.py` の `app`（ASGI, uvicorn）、依存は `app/requirements.txt`
- TypeScript: `app/index.ts`（Hono 等、`PORT` で listen）、依存は `app/package.json`。esbuild でバンドル
- ビルドは必要に応じ Docker を使用（Docker は利用可能）
- バインディングは環境変数: `FLAREON_DATABASE_<NAME>_TABLE`、`FLAREON_STORAGE_<NAME>_BUCKET`、`FLAREON_AI_<NAME>_MODEL_ID`、secrets は変数名そのまま
- AI モデルは Flareon model registry で論理名→ Bedrock モデル ID/推論プロファイルに解決

## Git / CI
- PR preview: GitHub Actions テンプレート（open/synchronize で deploy、closed で destroy、URL を PR コメント）
- AWS OIDC ロールを作る CLI コマンドを用意（`flareon bootstrap github`）
- 実リポジトリでの PR 動作確認は v0 の範囲外（テンプレート + resolver テスト + CLI まで）

## front auth Lambda の環境変数契約（src/auth ↔ src/constructs）
- エントリ: `src/auth/handler.ts` の `handler`（HTTP API payload v2 を受けて v2 レスポンスを返す）
- `FLAREON_AUTH_MODE`: `cognito` | `preview`
- `FLAREON_APP_FUNCTION_NAME`: Invoke 先 app Lambda
- `FLAREON_SESSION_SECRET_ARN`: Cookie 署名鍵（Secrets Manager）
- cognito: `FLAREON_COGNITO_DOMAIN`（`https://<prefix>.auth.<region>.amazoncognito.com`）、`FLAREON_COGNITO_CLIENT_ID`、`FLAREON_COGNITO_USER_POOL_ID`（issuer/JWKS 検証用）
- preview: `FLAREON_PREVIEW_TOKEN_SECRET_ARN`
- app へ渡すヘッダ: `x-flareon-user-sub`、`x-flareon-user-email`、`x-flareon-auth-mode`

## ユーザー secrets
- `flareon secret set NAME` → SSM SecureString `/flareon/{app}/{stage}/secrets/{NAME}`（stage スコープ）
- app Lambda は Flareon 生成のランチャー（LWA の起動コマンド）が起動時に SSM パスから取得して環境変数に設定し、アプリを exec する。Python は boto3、Node は AWS SDK v3（どちらも Lambda ランタイム同梱）を使用。ユーザーコードは `os.environ` / `process.env` で読むだけ
- IAM: app Lambda に該当パスの `ssm:GetParametersByPath` と `kms:Decrypt`（aws/ssm）

## ユーザー回答による追加決定（Phase 2 以降）
- Cognito ユーザー管理: `flareon auth user add/list/remove <email>`（管理者招待、自己サインアップ無効）
- 外部 IdP: `http.auth.provider: google | oidc` を Cognito の IdP として実装。クライアント ID/secret 等は Flareon secrets から渡す。検証は synth レベル（実 IdP ログインは範囲外）
- `flareon dev`: 既定は専用の dev 環境 `preview/local-<user>`（DB/Storage など stateful binding のみのスタック）を自動作成し、ローカルアプリに環境変数で接続、ファイル監視で再起動。`--stage/--version` 指定時は既存環境のリソースに接続（新規スタック作成なし）
