# Flareon

AWS 上で動く Web アプリを、`flareon.yaml` 1 枚と `flareon deploy` だけで公開するためのサーバーレス・アプリケーションプラットフォームです。

- アプリは普通の Web アプリ（Python は ASGI、TypeScript は Hono など）。Lambda Web Adapter で動きます
- 認証は既定で有効（Cognito + Flareon の認証レイヤー）。公開したいときだけ明示的に `auth: false`
- DB（DynamoDB）・ストレージ（S3）・AI（Bedrock）・シークレットは宣言するだけ。IAM や CDK を書く必要はありません
- Git と連携: ブランチごとの環境、PR ごとのプレビュー環境（PR を閉じると自動で削除）
- CI は GitHub Actions + OIDC。長期アクセスキーは不要です

設計は [docs/specs/FLAREON_V0_DESIGN.md](docs/specs/FLAREON_V0_DESIGN.md)、実装上の決定事項は [docs/specs/DECISIONS.md](docs/specs/DECISIONS.md) を参照してください。

## インストール / ビルド

Node.js 24 が必要です。ランタイムとタスクは [mise](https://mise.jdx.dev/) で管理しています。

```bash
git clone https://github.com/youyo/flareon && cd flareon
mise install            # Node 24
npm install
mise run build          # dist/ に CLI をビルド
node dist/cli/index.js --help
```

`flareon` コマンドとして使うには `npm link`（またはビルド成果物へのエイリアス）を使います。npm へはまだ公開していません。

AWS 側の前提: 対象アカウント・リージョンで `cdk bootstrap` 済みであること、認証情報（SSO など）が有効であること。リージョンは `--region`、`AWS_REGION`、`AWS_DEFAULT_REGION` の順で決まります（未指定は `us-east-1`）。

## クイックスタート

```bash
flareon init myapp --runtime python     # または typescript
cd myapp
flareon validate                        # flareon.yaml を検証
flareon deploy                          # AWS にデプロイして URL を表示
```

`init` は次のファイルを作ります。

```text
myapp/
├── flareon.yaml
├── app/                       # スターターアプリ
├── .github/workflows/flareon.yml   # GitHub Actions（既存ファイルは上書きしません）
└── .gitignore                 # .flareon/ を追加
```

デプロイ先は Git から決まります。既定ではデフォルトブランチが `prod/current`、PR が `preview/pr-<番号>` です。明示するときは `--stage prod --version v1`。使い捨て（ephemeral）になるのは `preview/pr-<番号>` だけで、`--stage preview --version pr-5` の明示は `--pr 5` と同じ PR プレビューとして扱います（`prod/pr-5` などは通常の永続 version）。

```bash
flareon plan                            # 何が作られる／変わるかを Flareon の概念で表示
flareon auth user add me@example.com --stage prod   # ログインできるユーザーを招待
flareon secret set EXTERNAL_API_KEY     # 値は stdin かプロンプトから（引数には取りません）
flareon logs --follow                   # アプリのログを追従
flareon destroy                         # このバージョンを削除
```

## flareon.yaml リファレンス

```yaml
version: 1 # 必須

name: myapp # 必須。小文字英数字とハイフン、英字始まり、2〜24 文字

runtime: # 必須
  language: python # python | typescript
  version: "3.13" # python のみ任意

http:
  true # 認証あり。http: { auth: false } で認証なしの公開
  # 省略するとHTTP エンドポイントなし
  # 外部 IdP / アクセス制限を使う場合（「認証」の節を参照）:
  # auth:
  #   provider: google          # google | oidc | entra（省略時は Cognito の招待制）
  #   allow:                    # 省略時は IdP で認証できた人は誰でも可
  #     domains: [example.com]
  #     emails: [alice@example.com]

database: # DynamoDB。名前ごとにテーブル
  main: {}
storage: # S3。名前ごとにバケット
  files: {}
ai: # Bedrock。論理名は Flareon のモデルレジストリで解決
  models:
    - sonnet
secrets: # 値は flareon secret set で設定。環境変数として渡る
  - EXTERNAL_API_KEY

git: # 省略可。省略時は「デフォルトブランチ → prod/current、PR → preview/pr-N」
  production:
    branch: "release/*" # glob（* は / を跨がない、** は跨ぐ）または default
    version: branch # branch: ブランチ名（ワイルドカード部分）から version を導く。固定名も可
  preview:
    branch: default # このブランチは preview/current
  pullRequests: true # false にすると PR プレビューを作らない
```

アプリへの受け渡し（環境変数）:

| 宣言              | 環境変数                        |
| ----------------- | ------------------------------- |
| `database.<name>` | `FLAREON_DATABASE_<NAME>_TABLE` |
| `storage.<name>`  | `FLAREON_STORAGE_<NAME>_BUCKET` |
| `ai.models[]`     | `FLAREON_AI_<NAME>_MODEL_ID`    |
| `secrets[]`       | 宣言した名前そのまま            |

認証済みユーザーは `x-flareon-user-sub` / `x-flareon-user-email` ヘッダで渡ります（クライアントが付けた `x-flareon-*` は front auth が削除します）。TypeScript では `flareon/runtime` の `identity(headers)` で読めます。`auth: false` の stage ではアプリに `FLAREON_AUTH_ENABLED=false` が渡り、`identity()` は常に `null` を返します（「制約」を参照）。

アプリの規約: Python は `app/main.py` の `app`（ASGI）と `app/requirements.txt`、TypeScript は `app/index.ts` と `app/package.json`（`PORT` で listen、ポート 8080）。

stage は小文字英数字とハイフン（16 文字まで）、version は 32 文字までです。

## CLI 一覧

| コマンド                                                 | 内容                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `flareon init [dir] [--runtime python\|typescript]`      | `flareon.yaml`・スターターアプリ・GitHub Actions ワークフローを作成                               |
| `flareon validate`                                       | `flareon.yaml` を検証                                                                             |
| `flareon synth`                                          | CDK Cloud Assembly を `.flareon/out/` に生成（デバッグ用）                                        |
| `flareon plan`                                           | デプロイ済みの状態と比較した変更を表示                                                            |
| `flareon deploy [--ci]`                                  | デプロイして URL を表示                                                                           |
| `flareon destroy [--stage-resources --yes] [--ci]`       | バージョンを削除。`--stage-resources` は stage の DB/ストレージ/ユーザー/シークレットまで完全削除 |
| `flareon env list`                                       | デプロイ済みの stage / version を一覧                                                             |
| `flareon env url [--with-token]`                         | URL を表示。PR プレビューは `--with-token` でトークン付きリンク                                   |
| `flareon logs [--since 10m] [--follow]`                  | ログ表示。`--follow` は CloudWatch Logs Live Tail                                                 |
| `flareon dev [--port 8787] [--as <email>]`               | ローカルで起動（ホットリロード）し、AWS の dev 用 DB/ストレージに接続                             |
| `flareon secret set\|list\|delete`                       | シークレット管理（SSM SecureString。外部 IdP の資格情報は Secrets Manager）                       |
| `flareon auth user add\|list\|remove <email>`            | Cognito ユーザー管理                                                                              |
| `flareon github comment [--state ...] [--with-token]`    | PR コメントと GitHub Deployment を更新（CI 用）                                                   |
| `flareon bootstrap github --repo owner/name [--destroy]` | GitHub Actions 用の AWS IAM ロールを作成／削除                                                    |

デプロイ先を決める共通オプション: `-f/--file`、`--stage`、`--version`、`--branch`、`--pr`、`--default-branch`、`--region`。

## ローカル開発（flareon dev）

```bash
flareon dev                       # http://localhost:8787
flareon dev --as alice@example.com  # サインイン済みユーザーとして動かす
flareon dev --stage prod --version v1  # 既存環境の DB/ストレージ等に接続（新しいスタックは作らない）
```

- 既定では専用の dev 環境 `preview/local-<OS ユーザー名>` を使います。`database:` / `storage:` があれば、それだけを持つスタックを初回に作り（2 回目以降は再利用）、ローカルのアプリに本番と同じ環境変数（`FLAREON_DATABASE_*` など）で渡します。DB もストレージも無ければスタックは作りません
- AI モデル ID はモデルレジストリで解決して渡し、Bedrock はローカルの AWS 認証情報で呼びます。`secrets:` は該当 stage の値を復号して環境変数に入れます（値は表示しません）
- `app/` 以下の変更を監視して再起動します（`node_modules` / `__pycache__` / `venv` / ドットファイル等は無視）。ビルド失敗やクラッシュ時は次の変更を待ちます
- python は `python -m uvicorn main:app`（PATH 上の `python`、無ければ `python3`）。`PYTHONDONTWRITEBYTECODE=1` で起動します（同じ秒に同じサイズで書き換えたときに古い .pyc が使われて変更が反映されない問題を避けるため）。`fastapi` / `uvicorn` など依存は自分の環境（venv 推奨）に入れておいてください。typescript は本番と同じ esbuild でバンドルして実行します（追加の依存なし）
- 利用者のポート（127.0.0.1）には薄いプロキシが立ち、クライアントが送った `x-flareon-*` ヘッダは必ず削除します。`--as <email>` のときだけ `x-flareon-user-email` / `x-flareon-user-sub: dev:<email>` / `x-flareon-auth-mode: dev` を付けます（ローカルではサインイン画面や allow の判定は行いません）。剥がす層があるのでアプリには `FLAREON_AUTH_ENABLED=true` を渡します
- `FLAREON_OFFLINE=1` で AWS に接続せずアプリだけ起動します（バインディングは `offline` 表示）
- dev 環境の削除: `flareon destroy --stage preview --version local-<user>`

## 認証

`http: true` の既定は Cognito の **招待制**（自己サインアップ無効）です。`flareon auth user add <email> --stage <stage>` で招待したユーザーだけがサインインできます。PR プレビューはこれとは別に Preview Auth（トークン付きリンク）で保護されます。

PR プレビューは **`http.auth: false` でも Preview Auth で保護します**（PR のコードを誤って無認証で公開しないため。`plan` / `deploy` に `forced for pull request previews` と表示されます）。`auth: false` で公開されるのは永続 stage（`prod` など）だけです。

セッション Cookie は `__Host-flareon_session`（Secure・Path=/・Domain なし）、サインイン中の一時 Cookie は `__Secure-flareon_flow` です。

### 外部 IdP（Google / OIDC / Entra ID）

Cognito の外部 IdP として組み込み、サインイン画面を飛ばして直接 IdP に送ります。クライアント ID / シークレットは名前が固定で、`flareon secret set` で stage ごとに設定します（`secrets:` には書きません。アプリの環境変数には渡りません）。値は Secrets Manager `flareon/<app>/<stage>/auth/<名前>` に入り、テンプレートには入りません。

| provider | flareon.yaml                                                                             | 資格情報（`flareon secret set <名前> --stage <stage>`） |
| -------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| google   | `auth: { provider: google }`                                                             | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`             |
| oidc     | `auth: { provider: oidc, issuer: https://idp.example.com, scopes?: [...], name?: Corp }` | `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`                 |
| entra    | `auth: { provider: entra, tenant: <ディレクトリ (テナント) ID> }`                        | `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`               |

- IdP 側に登録するリダイレクト URI は Cognito のドメインの `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse` です。prefix は app・stage・AWS アカウントから決定的に決まり、資格情報を設定する前に `flareon deploy` を実行するとエラーメッセージに正確な URI が表示されます
- 資格情報が無い状態で `flareon deploy` すると、作成前に `flareon secret set ...` を案内して止まります。シークレットを更新したら再 deploy すると IdP に反映されます
- oidc: `issuer` は https 必須、`scopes` 既定 `openid email profile`（`openid` 必須）、`name` はサインイン画面での表示名（既定 `OIDC`）
- entra: `tenant` はディレクトリ (テナント) ID（GUID）。ドメイン名（`contoso.onmicrosoft.com`）は使えません（Entra のトークンの issuer はテナント ID 形式で、Cognito の issuer 照合に失敗するため）。`common` / `organizations` / `consumers` などマルチテナント・個人アカウント用は拒否します
- 外部 IdP の stage では `flareon auth user add` で招待したユーザーはサインインに使えません（警告を出します）
- PR プレビューは外部 IdP を使わず Preview Auth のままです

#### Google の設定

1. Google Cloud Console の「API とサービス → OAuth 同意画面」で、**User type を Internal** にします（Google Workspace の組織内ユーザーだけがサインインできるようになります。推奨）
2. 「認証情報 → OAuth クライアント ID を作成」で種類「ウェブ アプリケーション」、承認済みのリダイレクト URI に上記の `/oauth2/idpresponse` を登録します
3. クライアント ID とシークレットを登録して deploy します

   ```bash
   flareon secret set GOOGLE_CLIENT_ID --stage prod
   flareon secret set GOOGLE_CLIENT_SECRET --stage prod
   flareon deploy
   ```

4. 多層防御として `allow.domains` にも Workspace のドメインを書きます（次節）。Internal の設定を誤って External にしても、組織外のアカウントは Flareon 側で拒否されます

#### Entra ID の設定

1. Microsoft Entra 管理センターの「アプリの登録 → 新規登録」で、サポートされているアカウントの種類に **「この組織ディレクトリのみに含まれるアカウント（シングルテナント）」** を選びます
2. リダイレクト URI（プラットフォーム「Web」）に上記の `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse` を登録します
3. 「証明書とシークレット → 新しいクライアント シークレット」で作成し、**値**（シークレット ID ではない）を控えます。期限が切れる前に更新して `flareon secret set` → 再 deploy します
4. 「API のアクセス許可」で Microsoft Graph の委任されたアクセス許可 `openid` / `profile` / `email` があることを確認します
5. 概要ページの「アプリケーション (クライアント) ID」と「ディレクトリ (テナント) ID」を使って設定します

   ```yaml
   http:
     auth:
       provider: entra
       tenant: 00000000-0000-0000-0000-000000000000 # ディレクトリ (テナント) ID
       allow: { domains: [contoso.com] } # 任意
   ```

   ```bash
   flareon secret set ENTRA_CLIENT_ID --stage prod
   flareon secret set ENTRA_CLIENT_SECRET --stage prod
   flareon deploy
   ```

- User Pool は email を必須属性にしているため、メールアドレス（`email` クレーム）を持たない Entra ユーザーはサインインできません
- テナントに招待したゲスト（B2B）ユーザーもテナント固有のサインインを通れます。ゲストを入れたくない場合は `allow.domains` に自社ドメインを指定してください

### アクセス制限（http.auth.allow）

IdP で認証できたユーザーのうち、アプリに入れる人を絞ります（省略時は IdP で認証できた人は誰でも可）。どの provider（既定の Cognito を含む）でも使えます。

```yaml
http:
  auth:
    provider: google
    allow:
      domains: [example.com] # どちらかに一致すれば許可
      emails: [partner@gmail.com]
```

| provider       | `domains`                                                                   | `emails`                                     |
| -------------- | --------------------------------------------------------------------------- | -------------------------------------------- |
| google         | Google Workspace の **hosted domain（`hd`）** が一致すること                | `email_verified=true` の email が完全一致    |
| cognito / oidc | `email_verified=true` の email のドメインが完全一致（サブドメインは別扱い） | `email_verified=true` の email が完全一致    |
| entra          | email（無ければ `preferred_username`）のドメインが完全一致                  | email（無ければ `preferred_username`）が一致 |

- google は email のドメインでは判定しません。会社ドメインのメールアドレスで作った個人の Google アカウント（Workspace 外、`hd` なし）を弾くためです
- entra の id_token には `email_verified` が無いため、テナント固有のサインイン（テナント外のアカウントは入れない）を前提に email で判定します
- 判定はサインイン時（callback）に front auth Lambda が行い、拒否したユーザーには 403 のページ（サインアウトのリンク付き）を返してセッション Cookie を発行しません
- `allow` を変更して deploy すると、それ以前に発行したセッションは無効になり、次のアクセスで再度サインインと判定が行われます
- 比較は大文字小文字を区別しません。リストは front Lambda の環境変数で渡すため、合計 2000 文字までです（多い場合は domains を使ってください）
- PR プレビュー（Preview Auth）には適用されません

## GitHub Actions で PR プレビューを使う

1. AWS アカウントで管理者権限の認証情報を使い、リポジトリごとに 1 回だけロールを作ります。

   ```bash
   flareon bootstrap github --repo owner/name --region ap-northeast-1
   ```

   - アカウントに GitHub OIDC プロバイダがあればそのまま再利用します（変更も削除もしません）。無い場合だけ Flareon が作ります
   - 作られるロールは `repo:owner/name:*` の OIDC トークンだけが assume できます（下記「信頼ポリシーのリスク」を参照）
   - 実行後に表示される案内に従ってリポジトリ変数を設定します。

   ```bash
   gh variable set FLAREON_AWS_ROLE_ARN --repo owner/name --body arn:aws:iam::123456789012:role/flareon-github-owner-name
   gh variable set FLAREON_AWS_REGION   --repo owner/name --body ap-northeast-1
   ```

2. `flareon init` が作った `.github/workflows/flareon.yml` をコミットして push します。

   | イベント                           | 動作                                                                                           |
   | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
   | push（デフォルトブランチ）         | `flareon deploy --ci`                                                                          |
   | PR opened / synchronize / reopened | プレビューを deploy。PR に URL をコメント（1 件を更新し続けます）+ GitHub Deployment を作成    |
   | PR closed                          | `flareon destroy --ci` でプレビューを削除。コメントは「削除済み」に、Deployment は inactive に |
   - 同じ PR（ブランチ）の実行は `concurrency` で直列化されます
   - フォークからの PR は OIDC / secrets が使えないため対象外です
   - Flareon は npm に未公開です。ワークフローは既定で `npx flareon@latest` を使うので、公開されるまではリポジトリ変数 `FLAREON_PACKAGE` に tarball の URL などインストール元を設定してください

プレビューは認証（Preview Auth）で保護されています。PR コメントには URL と「`flareon env url --pr <番号> --with-token` で取得」という案内だけを載せ、トークン付きリンクは載せません（public リポジトリで誰でも開けてしまうため）。private リポジトリに限り、`flareon github comment --with-token` をワークフローに足せばリンクをコメントに載せられます（public リポジトリでは拒否します）。

### bootstrap ロールの権限

- CDK bootstrap ロール（`cdk-<qualifier>-{deploy,file-publishing,image-publishing,lookup}-role-*`）の `sts:AssumeRole`、`cfn-exec` ロールの PassRole（CloudFormation 宛のみ）
- CloudFormation の読み取り（Describe / Get / List）と、PR プレビューのスタック（`flareon-*-preview-pr-*`）だけの `DeleteStack`（`flareon-bootstrap-*` は明示 Deny）
- SSM `/flareon/*` の読み取り
- Secrets Manager `GetSecretValue`（タグ `flareon:stage=preview` かつ `flareon:lifecycle=ephemeral` のシークレット＝PR プレビューのものだけ。永続 stage の Cookie 署名鍵は読めません）
- CloudWatch Logs の読み取り（`FilterLogEvents` / `GetLogEvents` / `StartLiveTail`。Flareon のロググループ `flareon-*` だけ）

シークレットの書き込み、永続 stage / version の削除、stage リソースの完全削除（`--stage-resources`）、ユーザー管理は含みません。これらは手元の認証情報で実行します。

#### 信頼ポリシーのリスク（sub 条件）

ロールの信頼条件は `token.actions.githubusercontent.com:sub` が `repo:owner/name:*` です。つまり **そのリポジトリで動く任意のワークフロー・任意のブランチ**（push 権限を持つ人が作ったブランチ上の改変されたワークフローを含む）がロールを使えます。このロールは CDK bootstrap のデプロイロールを assume できるため、実質的にそのアカウント・リージョンへ任意の CloudFormation をデプロイできる強い権限です。

v0 ではこのままにしています。絞る場合は、`flareon bootstrap github` の後に IAM コンソール等でロールの信頼ポリシーの `sub` 条件を次のように変更してください（再実行すると元に戻るので注意）。

- GitHub の Environment を使う: ワークフローの job に `environment: production` を付け、Environment の保護ルール（必須レビュアー・デプロイ可能なブランチ）を設定し、`sub` を `repo:owner/name:environment:production` にする
- ブランチと PR に限定する: `repo:owner/name:ref:refs/heads/main` と `repo:owner/name:pull_request` の 2 つだけを許可する（`StringLike` の値を配列にする）
- 本番 deploy 用と PR プレビュー用でロールを分け、それぞれに上記の条件を付ける

`flareon bootstrap github --repo owner/name --destroy` でロールを削除します。Flareon がプロバイダを作っていた場合に限り、そのプロバイダを信頼する他のロールが無いときだけプロバイダも削除します。

## 制約

- **応答サイズは 6MB まで**（Lambda の同期 Invoke の上限）。大きなファイルは S3 経由にしてください
- リクエストのタイムアウトは 30 秒以内（app < front <= 30s）。app のタイムアウトは 504 になります
- 認証ありの場合、HTTP API の `$default` ルート → front auth Lambda → app Lambda の 2 段構成です
- PR プレビューは DB / ストレージが空で新規作成され、本番データは複製しません
- 実 GitHub リポジトリでの PR 動作確認は v0 の範囲外です（テンプレート・resolver・CLI まで）
- `--ci` はフォーク PR を扱いません。`destroy --ci` は closed の PR イベントでのみ動きます
- カスタムドメインは v0 の対象外です
- **`http.auth: false` の stage では `x-flareon-*` ヘッダを除去する層がありません。** クライアントが `x-flareon-user-sub` などを自由に付けて送れるので、アプリはこれらのヘッダを信頼しないでください。`flareon/runtime` の `identity()` は `FLAREON_AUTH_ENABLED=false` を見て常に `null` を返しますが、Python などでヘッダを直接読む場合は `FLAREON_AUTH_ENABLED` が `true` のときだけ使ってください

## 開発者向け

```bash
mise run build        # dist/ へビルド
mise run test         # unit + E2E（AWS に接続しない）
mise run test:unit    # vitest（test/unit）
mise run test:e2e     # ビルド済み CLI を実プロセスで実行（test/e2e、AWS は FLAREON_OFFLINE=1）
mise run lint         # ESLint + Prettier
mise run typecheck    # tsc
mise run fmt          # Prettier で整形
```

### E2E の 2 段構成

1. **常時 E2E**（`mise run test:e2e`）: `init` / `synth` / `plan` / `--ci` の判定など、AWS に接続せず確認できる振る舞い。認証情報には無効な値を与え、誤って実 AWS に触れないようにしています
2. **実 AWS E2E**（オプトイン）: 実際に deploy → HTTP・認証・ログを確認 → destroy します。テスト専用の名前（`fe2e-*`、`flareon-e2e/*`）のリソースだけを作り、終了時に残りが無いことを検証します

   ```bash
   FLAREON_E2E_AWS=1 mise run test:e2e:aws
   ```

   `FLAREON_E2E_AWS` を設定しないとスキップされます。AWS 認証と `AWS_REGION`（`ap-northeast-1`）が必要です。`bootstrap github` の E2E は、アカウントに既にある GitHub OIDC プロバイダを変更・削除しないことも検証します。

開発手法は TDD（Red → Green → Refactor、Unit と E2E の両方）です。
