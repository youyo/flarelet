[English](README.md) | 日本語

# Flarelet

![CI](https://github.com/youyo/flarelet/actions/workflows/ci.yml/badge.svg)

## 概要

Flarelet は AWS 向けのサーバーレス・アプリケーションプラットフォームです。アプリに必要なものを YAML で宣言し、コードを push するだけで、インフラ・認証・プレビュー・デプロイ・ランタイムバインディングを Flarelet が引き受けます。

- アプリは普通の Web アプリ（Python は ASGI、TypeScript は Hono など）。Lambda Web Adapter で動きます
- 認証は既定で有効（Cognito + Flarelet の認証レイヤー）。公開したいときだけ明示的に `auth: false`
- DB（DynamoDB）・ストレージ（S3）・AI（Bedrock）・シークレットは宣言するだけ。IAM や CDK を書く必要はありません
- Git と連携: ブランチごとの環境、PR ごとのプレビュー環境（PR を閉じると自動で削除）
- CI は GitHub Actions + OIDC。長期アクセスキーは不要です

頭の中のモデルは次のとおりです。

```text
flarelet.yaml

flarelet init
flarelet dev
flarelet deploy
flarelet logs
```

設計は [docs/specs/FLARELET_V0_DESIGN.md](docs/specs/FLARELET_V0_DESIGN.md)、実装上の決定事項は [docs/specs/DECISIONS.md](docs/specs/DECISIONS.md) を参照してください。

## 要件

- Node.js 24
- 対象アカウントの AWS 認証情報（SSO など）。リージョンは `--region`、`AWS_REGION`、`AWS_DEFAULT_REGION` の順で決まります（未指定は `us-east-1`）
- 対象アカウント・リージョンで CDK bootstrap（`CDKToolkit` スタック）が 1 回必要です。通常は端末で実行した初回の `flarelet deploy` が自動で行います。CI・非対話・`--no-bootstrap` では自動で行わないので、事前に `flarelet bootstrap aws --region <region>` を一度実行してください（グローバルの `cdk` CLI は不要）
- Python アプリは Docker（依存を Lambda のビルドコンテナで束ねます）

このリポジトリのランタイムとタスクは [mise](https://mise.jdx.dev/) で管理しています。

## インストール

Node.js 24 以上があればインストール不要で実行できます。

```bash
npx flarelet@latest init      # 試す（インストール不要）
npm i -g flarelet             # グローバルにインストール
```

### リポジトリからビルドする

```bash
git clone https://github.com/youyo/flarelet && cd flarelet
mise install            # Node 24
npm install
mise run build          # dist/ に CLI をビルド
node dist/cli/index.js --help
```

`flarelet` コマンドとして使うには `npm link`（またはビルド成果物へのエイリアス）を使います。

### パッケージとしてインストールする

公開済みの npm パッケージではなく手元の変更を試したいときは、tarball を作ってインストールできます。`dist/` はコミットされておらず `prepare` スクリプトもないため、git 指定のまま（`npm install github:youyo/flarelet`）では動く CLI になりません。

```bash
mise run build
npm pack                                  # flarelet-0.1.0.tgz を作成
npm install -g ./flarelet-0.1.0.tgz        # tarball を置いて URL からインストールしても可
```

GitHub Actions のワークフローでも、リポジトリ変数 `FLARELET_PACKAGE` にその tarball の URL を設定すれば使えます（[GitHub Actions](#github-actions) を参照）。

zsh の補完は [シェル補完（zsh）](#シェル補完zsh) を参照してください。

## クイックスタート

```bash
flarelet init myapp --runtime python     # または typescript
cd myapp
flarelet dev                             # ローカルでホットリロード起動（http://localhost:8787）
flarelet deploy                          # AWS にデプロイして URL を表示
flarelet auth user add me@example.com --stage prod   # ログインできるユーザーを招待
flarelet logs --follow                   # アプリのログを追従
```

`init` は次のファイルを作ります。

```text
myapp/
├── flarelet.yaml
├── app/                            # スターターアプリ
├── .github/workflows/flarelet.yml   # GitHub Actions（既存ファイルは上書きしません）
└── .gitignore                      # .flarelet/ を追加
```

デプロイ先は Git から決まります。既定ではデフォルトブランチが `prod/current`、PR が `preview/pr-<番号>` です。明示するときは `--stage prod --version v1`。使い捨て（ephemeral）になるのは `preview/pr-<番号>` だけで、`--stage preview --version pr-5` の明示は `--pr 5` と同じ PR プレビューとして扱います（`prod/pr-5` などは通常の永続 version）。

そのほかのよく使うコマンド:

```bash
flarelet validate                        # flarelet.yaml を検証
flarelet plan                            # 何が作られる／変わるかを Flarelet の概念で表示
flarelet secret set EXTERNAL_API_KEY     # 値は stdin かプロンプトから（引数には取りません）
flarelet destroy                         # このバージョンを削除
```

## flarelet.yaml リファレンス

未知のキーはすべてエラーです。迷ったら `flarelet validate` で確認してください。

```yaml
version: 1 # 必須

name: myapp # 必須。小文字英数字とハイフン、英字始まり、2〜24 文字

runtime: # 必須
  language: python # python | typescript
  version: "3.13" # 任意。引用符つきの文字列（既定は python 3.13、typescript 24）

http:
  true # 認証あり。http: { auth: false } で認証なしの公開
  # 省略すると HTTP エンドポイントなし
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
ai: # Bedrock。論理名は Flarelet のモデルレジストリで解決
  models:
    - sonnet # sonnet | opus | haiku | nova-micro | nova-lite | nova-pro
secrets: # 値は flarelet secret set で設定。環境変数として渡る
  - EXTERNAL_API_KEY

git: # 省略可。省略時は「デフォルトブランチ → prod/current、PR → preview/pr-N」
  production:
    branch: "release/*" # glob（* は / を跨がない、** は跨ぐ）または default
    version: branch # branch: ブランチ名（ワイルドカード部分）から version を導く。固定名も可
  preview:
    branch: default # このブランチは preview/current
  pullRequests: true # false にすると PR プレビューを作らない
```

`http` の書き方:

| 書き方                    | 意味                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `http: true`              | 認証あり（既定の Cognito 招待制）                                          |
| `http: false`             | HTTP エンドポイントなし（`http` 省略と同等）                               |
| `http: { auth: true }`    | `http: true` と同じ                                                        |
| `http: { auth: false }`   | **認証なしで公開**（永続 stage のみ。PR プレビューは Preview Auth を強制） |
| `http: { auth: { ... } }` | 外部 IdP／アクセス制限（[認証](#認証) を参照）                             |

#### スロットリングとアクセスログ（`http.throttle`）

HTTP API には、暴走トラフィックと課金（denial of wallet）を防ぐガードレールとして既定でスロットリングが付きます。永続 stage は `rate: 1000`（req/s）・`burst: 2000`、PR プレビューは `rate: 100`・`burst: 200` です。`flarelet.yaml` で上書き・無効化できます。

```yaml
http:
  throttle: { rate: 2000, burst: 4000 } # rate: 正の数（10000 以下）、burst: 正の整数（5000 以下）
  # throttle: false                    # スロットリングなし（API Gateway のアカウント上限は残る）
```

1 リクエストは Lambda の同時実行を 2 つ（front + app）消費し、アカウント既定の同時実行は 1000 なので、上げるときはクォータを確認してください。API は 1 行 JSON のアクセスログ（リクエスト ID、送信元 IP、メソッド、ルート、パス、ステータス、レイテンシ。ヘッダ・クエリ文字列・Cookie・トークンは含まない）を version スタック内のロググループ（保持 1 か月、スタックと一緒に削除）へ出力します。

> **既存デプロイへの影響:** 次回の `flarelet deploy` で、永続 stage の S3 バージョニング（非現行バージョンは 30 日で失効）と DynamoDB 削除保護が有効になり、既定のスロットリングが適用されます。`flarelet destroy --stage-resources` は保護付きテーブルも削除できます。

#### CloudWatch アラーム（`alerts`）

アラームは **opt-in** です。`alerts:` を書かなければ、生成されるテンプレートは変わりません。既存の SNS トピックを指定すると、**永続 stage だけ**に次のアラームを作ります（PR プレビューと `flarelet dev` には、`alerts` を書いても作りません）。

```yaml
alerts:
  topicArn: arn:aws:sns:ap-northeast-1:123456789012:ops-alerts # デプロイ先と同じリージョンの既存の標準（FIFO ではない）トピック
```

| アラーム（期間 5 分・評価 1 回。ALARM と OK の両方で通知）                       | 条件     |
| -------------------------------------------------------------------------------- | -------- |
| app Lambda と front Lambda（front は認証があるときだけ）: `Errors`               | Sum >= 5 |
| app Lambda と front Lambda: `Throttles`                                          | Sum >= 1 |
| HTTP API（`http` があるとき）: `5xx`（`AWS/ApiGateway`、次元 `ApiId` + `Stage`） | Sum >= 5 |
| DynamoDB テーブルごと: `SystemErrors`（操作ごとの合計）                          | Sum >= 1 |
| DynamoDB テーブルごと: `ReadThrottleEvents` + `WriteThrottleEvents`              | Sum >= 1 |

- データが無い期間は正常として扱います。しきい値は固定で、`flarelet.yaml` では変えられません
- Flarelet は **SNS トピックを作りません**（メール確認などの購読と、トピックのライフサイクルをあなたが管理できるようにするためです）。トピックはデプロイ先と同じリージョンに必要で、違うと `synth` / `deploy` がエラーになります
- トピックをカスタマー管理の KMS キーで暗号化している場合は、キーポリシーで CloudWatch に使用を許可してください（`cloudwatch.amazonaws.com` に `kms:Decrypt` と `kms:GenerateDataKey*`）。既定の `alias/aws/sns` キーは CloudWatch アラームでは使えません
- アラーム名は `<スタック名>-<対象>` です（例: `flarelet-myapp-prod-v1-app-errors`、`flarelet-myapp-prod-database-main-system-errors`）

### アプリへの受け渡し

| 宣言              | 環境変数                         |
| ----------------- | -------------------------------- |
| `database.<name>` | `FLARELET_DATABASE_<NAME>_TABLE` |
| `storage.<name>`  | `FLARELET_STORAGE_<NAME>_BUCKET` |
| `ai.models[]`     | `FLARELET_AI_<NAME>_MODEL_ID`    |
| `secrets[]`       | 宣言した名前そのまま             |

シークレット名は `A-Z`・`0-9`・`_` で、`FLARELET_` と `AWS_` で始まる名前は予約済みです。外部 IdP の資格情報は `secrets:` には書きません（[認証](#認証) を参照）。

アプリの規約: Python は `app/main.py` の `app`（ASGI）と `app/requirements.txt`、TypeScript は `app/index.ts` と `app/package.json`（`PORT` で listen、ポート 8080）。TypeScript は `hostname: process.env.HOST ?? "127.0.0.1"` で listen してください（`flarelet init` のテンプレートと同じ）。Lambda では Lambda Web Adapter が `127.0.0.1` にアクセスし、`flarelet dev` は `HOST=127.0.0.1` を渡します。全インターフェースで listen すると、同じネットワークの他の端末がプロキシを経由せずアプリに直接届き、identity ヘッダを偽装できます。

## App・Stage・Version と Git マッピング

デプロイは App -> Stage -> Version で指定します。

- **App**: `flarelet.yaml` の `name`
- **Stage**: ステートフルなリソース（DB・ストレージ・ユーザー・シークレット）を持つ長寿命の環境。小文字英数字とハイフン、16 文字まで
- **Version**: stage の中にデプロイされるコードの 1 つのコピー。32 文字まで

明示しなければ Git がデプロイ先を決めます。優先順位は `--stage` + `--version` の明示 > `--pr` > `--branch` > 現在の Git（CI では GitHub のイベント）です。

| Git の状態              | 既定のデプロイ先  | 設定                                                                                 |
| ----------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| デフォルトブランチ      | `prod/current`    | `git.production.branch`、`.version`                                                  |
| glob に一致するブランチ | `prod/<version>`  | `git.production.branch: "release/*"`、`version: branch`（`release/v1` -> `prod/v1`） |
| `git.preview.branch`    | `preview/current` | `git.preview.branch`                                                                 |
| PR N                    | `preview/pr-N`    | `git.pullRequests: false` で無効化                                                   |

- 使い捨て（ephemeral）になるのは `preview/pr-<N>` だけです（PR プレビュー。PR を閉じると削除）。DB・ストレージは空で新規作成され、本番データは複製しません
- どのマッピングにも一致しないブランチは、`--stage` / `--version` で明示するまでデプロイできません
- `--stage` だけ指定すると version は Git から導き、導けなければ `current` です

## 認証

`http: true` の既定は Cognito の **招待制**（自己サインアップ無効）です。`flarelet auth user add <email> --stage <stage>` で招待したユーザーだけがサインインできます。PR プレビューはこれとは別に Preview Auth（トークン付きリンク）で保護されます。

PR プレビューは **`http.auth: false` でも Preview Auth で保護します**（PR のコードを誤って無認証で公開しないため。`plan` / `deploy` に `forced for pull request previews` と表示されます）。`auth: false` で公開されるのは永続 stage（`prod` など）だけです。

セッション Cookie は `__Host-flarelet_session`（Secure・Path=/・Domain なし）、サインイン中の一時 Cookie は `__Secure-flarelet_flow` です。セッションの寿命は最長 8 時間です。

それより前に止めたいときは `flarelet auth revoke-sessions --stage <stage>`（PR プレビューは `--pr <番号>`）でその環境のセッションを **すべて** 失効させます。front は世代を 60 秒キャッシュするため、反映まで最大 60 秒かかります。世代を読めないときは 503 を返します（失効を確認できないまま通さない）。`flarelet auth user remove` も削除したユーザーのセッションを止めるため同じ失効を行います（他のユーザーもサインインし直しになります）。

### identity ヘッダと認可

認証済みユーザーは `x-flarelet-user-sub` / `x-flarelet-user-email` / `x-flarelet-user-email-verified`（`true` か `false`）ヘッダでアプリに渡ります。クライアントが付けた `x-flarelet-*` は front auth が削除します。TypeScript では `flarelet/runtime` の `identity(headers)` で `sub` / `email` / `emailVerified` を読めます。`auth: false` の stage ではアプリに `FLARELET_AUTH_ENABLED=false` が渡り、`identity()` は常に `null` を返します（[制約](#制約)を参照）。

**認可・ユーザーの紐付けには `sub` を使ってください。** `email` は IdP から来た値で、検証済みとは限りません（OIDC などでは IdP 側で未検証のアドレスを設定できることがあります）。email を使う場合は `emailVerified`（ヘッダが `true`）のときだけにしてください。`emailVerified` は id_token の `email_verified` が true のときだけ true です（Entra ID は `email_verified` を出さないので常に `false`。PR プレビューは email が無いので `false`）。cognito（既定）の User Pool は、利用者が email を変更しても新しいアドレスの検証が済むまで元の email を保ちます。

### 外部 IdP（Google / OIDC / Entra ID）

Cognito の外部 IdP として組み込み、サインイン画面を飛ばして直接 IdP に送ります。クライアント ID / シークレットは名前が固定で、`flarelet secret set` で stage ごとに設定します（`secrets:` には書きません。アプリの環境変数には渡りません）。値は Secrets Manager `flarelet/<app>/<stage>/auth/<名前>` に入り、テンプレートには入りません。

| provider | flarelet.yaml                                                                            | 資格情報（`flarelet secret set <名前> --stage <stage>`） |
| -------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| google   | `auth: { provider: google }`                                                             | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`              |
| oidc     | `auth: { provider: oidc, issuer: https://idp.example.com, scopes?: [...], name?: Corp }` | `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`                  |
| entra    | `auth: { provider: entra, tenant: <ディレクトリ (テナント) ID> }`                        | `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`                |

- IdP 側に登録するリダイレクト URI は `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse` です。prefix は app・stage・AWS アカウントから決定的に決まり、資格情報を設定する前に `flarelet deploy` を実行するとエラーメッセージに正確な URI が表示されます
- 資格情報が無い状態で `flarelet deploy` すると、作成前に `flarelet secret set ...` を案内して止まります。シークレットを更新したら再 deploy すると IdP に反映されます
- oidc: `issuer` は https 必須、`scopes` 既定 `openid email profile`（`openid` 必須）、`name` はサインイン画面での表示名（既定 `OIDC`）
- entra: `tenant` はディレクトリ (テナント) ID（GUID）。ドメイン名（`contoso.onmicrosoft.com`）は使えません（Entra のトークンの issuer はテナント ID 形式で、Cognito の issuer 照合に失敗するため）。`common` / `organizations` / `consumers` などマルチテナント・個人アカウント用は拒否します
- 外部 IdP の stage では `flarelet auth user add` で招待したユーザーはサインインに使えません（警告を出します）
- PR プレビューは外部 IdP を使わず Preview Auth のままです

#### Google の設定

1. Google Cloud Console の「API とサービス → OAuth 同意画面」で、**User type を Internal** にします（Google Workspace の組織内ユーザーだけがサインインできるようになります。推奨）
2. 「認証情報 → OAuth クライアント ID を作成」で種類「ウェブ アプリケーション」、承認済みのリダイレクト URI に上記の `/oauth2/idpresponse` を登録します
3. クライアント ID とシークレットを登録して deploy します

   ```bash
   flarelet secret set GOOGLE_CLIENT_ID --stage prod
   flarelet secret set GOOGLE_CLIENT_SECRET --stage prod
   flarelet deploy
   ```

4. 多層防御として `allow.domains` にも Workspace のドメインを書きます（次節）。Internal の設定を誤って External にしても、組織外のアカウントは Flarelet 側で拒否されます

#### Entra ID の設定

1. Microsoft Entra 管理センターの「アプリの登録 → 新規登録」で、サポートされているアカウントの種類に **「この組織ディレクトリのみに含まれるアカウント（シングルテナント）」** を選びます
2. リダイレクト URI（プラットフォーム「Web」）に `https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse` を登録します
3. 「証明書とシークレット → 新しいクライアント シークレット」で作成し、**値**（シークレット ID ではない）を控えます。期限が切れる前に更新して `flarelet secret set` → 再 deploy します
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
   flarelet secret set ENTRA_CLIENT_ID --stage prod
   flarelet secret set ENTRA_CLIENT_SECRET --stage prod
   flarelet deploy
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

## ローカル開発

```bash
flarelet dev                              # http://localhost:8787
flarelet dev --as alice@example.com       # サインイン済みユーザーとして動かす
flarelet dev --stage prod --version v1    # 既存環境の DB/ストレージ等に接続（新しいスタックは作らない）
```

- 既定では専用の dev 環境 `preview/local-<OS ユーザー名>` を使います。`database:` / `storage:` があれば、それだけを持つスタックを初回に作り（2 回目以降は再利用）、ローカルのアプリに本番と同じ環境変数（`FLARELET_DATABASE_*` など）で渡します。DB もストレージも無ければスタックは作りません
- AI モデル ID はモデルレジストリで解決して渡し、Bedrock はローカルの AWS 認証情報で呼びます。`secrets:` は該当 stage の値を復号して環境変数に入れます（値は表示しません）
- `app/` 以下の変更を監視して再起動します（`node_modules` / `__pycache__` / `venv` / ドットファイル等は無視）。ビルド失敗やクラッシュ時は次の変更を待ちます
- python は `python -m uvicorn main:app`（PATH 上の `python`、無ければ `python3`）。`PYTHONDONTWRITEBYTECODE=1` で起動します（同じ秒に同じサイズで書き換えたときに古い .pyc が使われて変更が反映されない問題を避けるため）。`fastapi` / `uvicorn` など依存は自分の環境（venv 推奨）に入れておいてください。typescript は本番と同じ esbuild でバンドルして実行します（追加の依存なし）
- 利用者のポート（127.0.0.1）には薄いプロキシが立ち、クライアントが送った `x-flarelet-*` ヘッダは必ず削除します。`--as <email>` のときだけ `x-flarelet-user-email` / `x-flarelet-user-email-verified: true` / `x-flarelet-user-sub: dev:<email>` / `x-flarelet-auth-mode: dev` を付けます（ローカルではサインイン画面や allow の判定は行いません）。剥がす層があるのでアプリには `FLARELET_AUTH_ENABLED=true` を渡します
- プロキシは `Host` が `localhost` / `127.0.0.1` / `[::1]`（ポート付き可）以外のリクエストを 403 にします（DNS rebinding で外部サイトからローカルのアプリを読まれないように）。`--as` のときは他サイトからのリクエスト（`Origin` が自オリジン以外、または `Sec-Fetch-Site: cross-site`）も 403 にします（擬似ユーザーとしての CSRF を防ぐ）
- アプリには `HOST=127.0.0.1` と、起動ごとのランダムな `FLARELET_DEV_SECRET` を渡し、プロキシ経由のリクエストにだけ同じ値の `x-flarelet-dev-secret` ヘッダを付けます。`flarelet/runtime` の `identity()` は `FLARELET_DEV_SECRET` があるときヘッダが一致する場合だけ identity を返します（アプリが全インターフェースで listen していても、プロキシを経由しない直接アクセスの偽装ヘッダを信用しない）。**Python には runtime ライブラリが無いので、identity ヘッダを読むときは `FLARELET_DEV_SECRET` が設定されていれば `x-flarelet-dev-secret` と一致する場合だけ信用してください**（uvicorn は `--host 127.0.0.1` で起動します）
- `FLARELET_OFFLINE=1` で AWS に接続せずアプリだけ起動します（バインディングは `offline` 表示）
- dev 環境の削除: `flarelet destroy --stage preview --version local-<user>`

## GitHub Actions

PR プレビュー、ブランチのデプロイ、後片付けを GitHub Actions + OIDC で動かします。

1. AWS アカウントで管理者権限の認証情報を使い、リポジトリごとに 1 回だけロールを作ります。CI は自動で bootstrap しないので、先にアカウント・リージョンを bootstrap しておきます（1 回だけ。済みなら何もしません）。未 bootstrap だと `bootstrap github` は案内を出して止まります。

   ```bash
   flarelet bootstrap aws --region ap-northeast-1
   flarelet bootstrap github --repo owner/name --region ap-northeast-1
   ```

   - アカウントに GitHub OIDC プロバイダがあればそのまま再利用します（変更も削除もしません）。無い場合だけ Flarelet が作ります
   - 作られるロールは `repo:owner/name:*` の OIDC トークンだけが assume できます（下記「信頼ポリシーのリスク」を参照）

2. 実行後に表示される案内に従ってリポジトリ変数を設定します。

   ```bash
   gh variable set FLARELET_AWS_ROLE_ARN --repo owner/name --body arn:aws:iam::123456789012:role/flarelet-github-owner-name
   gh variable set FLARELET_AWS_REGION   --repo owner/name --body ap-northeast-1
   gh variable set FLARELET_PACKAGE      --repo owner/name --body https://example.com/flarelet-0.1.0.tgz
   ```

   ワークフローは `flarelet init` / `flarelet workflow generate` を実行した CLI 自身のバージョンに固定して `npx flarelet@<version>` で導入します。`FLARELET_PACKAGE` は上書きしたいときだけ設定してください（tarball の URL や git 指定など。省略可）。

3. `flarelet init` が作った `.github/workflows/flarelet.yml` をコミットして push します。

### ワークフローと push トリガー

| イベント                           | 動作                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| push（永続ブランチ）               | `flarelet deploy --ci`                                                                          |
| PR opened / synchronize / reopened | プレビューを deploy。PR に URL をコメント（1 件を更新し続けます）+ GitHub Deployment を作成     |
| PR closed                          | `flarelet destroy --ci` でプレビューを削除。コメントは「削除済み」に、Deployment は inactive に |

- push トリガー（`on.push.branches`）は **`flarelet.yaml` の `git` 設定から生成**されます。`git.production.branch` と `git.preview.branch` が対象で、`default` はデフォルトブランチ名に置き換わります。glob（`*`、`**`）の意味は保たれます
- `git` 設定を変えたら `flarelet workflow generate --force` でワークフローを再生成します。`--force` なしでは、ファイルが無ければ作成、同じなら `up to date`、異なる既存ファイルは変更せず終了コード 1 です
- `flarelet validate` は、既存ワークフローの `on.push.branches` が `git` 設定と食い違うと警告を出します
- **ワークフローの手編集は `--force` で失われます。** 独自の処理は別のワークフローファイルに書いてください
- 同じ PR（ブランチ）の実行は `concurrency` で直列化されます
- 生成されるワークフローの Actions はコミット SHA で固定されます（checkout は `persist-credentials: false`）。既存の生成済みワークフローは `flarelet workflow generate --force` で再生成すると反映されます
- フォークからの PR は OIDC / secrets が使えないため対象外です

プレビューは認証（Preview Auth）で保護されています。PR コメントには URL と「`flarelet env url --pr <番号> --with-token` で取得」という案内だけを載せ、トークン付きリンクは載せません（public リポジトリで誰でも開けてしまうため）。private リポジトリに限り、`flarelet github comment --with-token` をワークフローに足せばリンクをコメントに載せられます（public リポジトリでは拒否します）。

### CI ロールの権限

- CDK bootstrap ロール（`cdk-<qualifier>-{deploy,file-publishing,image-publishing,lookup}-role-*`）の `sts:AssumeRole`、`cfn-exec` ロールの PassRole（CloudFormation 宛のみ）
- CloudFormation の読み取り（Describe / Get / List）と、PR プレビューのスタック（`flarelet-*-preview-pr-*`）だけの `DeleteStack`（`flarelet-bootstrap-*` は明示 Deny）
- SSM `GetParameter`（CDK bootstrap のバージョン `/cdk-bootstrap/<qualifier>/version` だけ。`/flarelet/*` は読めません）
- Secrets Manager `DescribeSecret`（`flarelet/*/auth/*` = 外部 IdP の資格情報だけ。deploy が値を読まずに有無を確認するため）
- Secrets Manager `GetSecretValue`（タグ `flarelet:stage=preview` かつ `flarelet:lifecycle=ephemeral` のシークレット＝PR プレビューのものだけ。永続 stage の Cookie 署名鍵は読めません）
- CloudWatch Logs の読み取り（`FilterLogEvents` / `GetLogEvents` / `StartLiveTail`。Flarelet のロググループ `flarelet-*` だけ）

シークレットの書き込み、永続 stage / version の削除、stage リソースの完全削除（`--stage-resources`）、ユーザー管理は含みません。これらは手元の認証情報で実行します。

### 信頼ポリシーのリスク（sub 条件）

ロールの信頼条件は `token.actions.githubusercontent.com:sub` が `repo:owner/name:*` です。つまり **そのリポジトリで動く任意のワークフロー・任意のブランチ**（push 権限を持つ人が作ったブランチ上の改変されたワークフローを含む）がロールを使えます。このロールは CDK bootstrap のデプロイロールを assume できるため、実質的にそのアカウント・リージョンへ任意の CloudFormation をデプロイできる強い権限です。

v0 ではこのままにしています。絞る場合は、`flarelet bootstrap github` の後に IAM コンソール等でロールの信頼ポリシーの `sub` 条件を変更してください（再実行すると元に戻るので注意）。

- GitHub の Environment を使う: ワークフローの job に `environment: production` を付け、Environment の保護ルール（必須レビュアー・デプロイ可能なブランチ）を設定し、`sub` を `repo:owner/name:environment:production` にする
- ブランチと PR に限定する: `repo:owner/name:ref:refs/heads/main` と `repo:owner/name:pull_request` の 2 つだけを許可する（`StringLike` の値を配列にする）
- 本番 deploy 用と PR プレビュー用でロールを分け、それぞれに上記の条件を付ける

`flarelet bootstrap github --repo owner/name --destroy` でロールを削除します。Flarelet がプロバイダを作っていた場合に限り、そのプロバイダを信頼する他のロールが無いときだけプロバイダも削除します。

## CLI 一覧

| コマンド                                                       | 内容                                                                                                                                          |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `flarelet init [dir] [--runtime python\|typescript]`           | `flarelet.yaml`・スターターアプリ・GitHub Actions ワークフローを作成                                                                          |
| `flarelet validate`                                            | `flarelet.yaml` を検証（ワークフローの push ブランチが `git` 設定と食い違うと警告）                                                           |
| `flarelet workflow generate [--force]`                         | `git` 設定から `.github/workflows/flarelet.yml` を生成。`--force` で異なる既存ファイルを上書き                                                |
| `flarelet synth`                                               | CDK Cloud Assembly を `.flarelet/out/` に生成（デバッグ用）                                                                                   |
| `flarelet plan`                                                | デプロイ済みの状態と比較した変更を表示                                                                                                        |
| `flarelet deploy [--ci] [--bootstrap]`                         | デプロイして URL を表示。必要なら先にアカウント・リージョンを bootstrap（端末か `--bootstrap` のとき。`--ci`・`--no-bootstrap` では行わない） |
| `flarelet destroy [--stage-resources --yes] [--ci]`            | バージョンを削除。`--stage-resources` は stage の DB/ストレージ/ユーザー/シークレットまで完全削除                                             |
| `flarelet env list`                                            | デプロイ済みの stage / version を一覧                                                                                                         |
| `flarelet env url [--with-token]`                              | URL を表示。PR プレビューは `--with-token` でトークン付きリンク                                                                               |
| `flarelet logs [--since 10m] [--follow]`                       | ログ表示。`--follow` は CloudWatch Logs Live Tail                                                                                             |
| `flarelet dev [--port 8787] [--as <email>]`                    | ローカルで起動（ホットリロード）し、AWS の dev 用 DB/ストレージに接続（`deploy` と同様に bootstrap。`--bootstrap` / `--no-bootstrap`）        |
| `flarelet secret set\|list\|delete`                            | シークレット管理（SSM SecureString。外部 IdP の資格情報は Secrets Manager）                                                                   |
| `flarelet auth user add\|list\|remove <email>`                 | Cognito ユーザー管理。`remove` はその stage の全セッションも失効させる                                                                        |
| `flarelet auth revoke-sessions`                                | その環境の Flarelet セッションをすべて失効させる（最大 60 秒で反映）                                                                          |
| `flarelet github comment [--state ...] [--with-token]`         | PR コメントと GitHub Deployment を更新（CI 用）                                                                                               |
| `flarelet bootstrap aws [--region <region>] [--qualifier <q>]` | アカウント・リージョンを 1 回だけ CDK bootstrap（済みなら何もしない。既存の `CDKToolkit` は更新しない）                                       |
| `flarelet bootstrap github --repo owner/name [--destroy]`      | GitHub Actions 用の AWS IAM ロールを作成／削除（bootstrap 済みであることが前提）                                                              |
| `flarelet completion zsh`                                      | zsh 補完スクリプトを出力（[シェル補完（zsh）](#シェル補完zsh) を参照）                                                                        |
| `flarelet skill install [--global] [--dir <path>] [--force]`   | AI エージェント向けスキルをインストール（[AI エージェント向けスキル](#ai-エージェント向けスキル) を参照）                                     |

デプロイ先を決める共通オプション: `-f/--file`、`--stage`、`--version`、`--branch`、`--pr`、`--default-branch`、`--region`。

## シェル補完（zsh）

```bash
flarelet completion zsh > "${fpath[1]}/_flarelet"   # fpath の先頭ディレクトリに置く（次のシェルから有効）
# または ~/.zshrc に（compinit より後に）
eval "$(flarelet completion zsh)"
```

補完スクリプトは CLI のコマンド定義から生成するので、コマンドやオプションが増えても自動で追従します。コマンド・サブコマンド・オプションに加えて、`--runtime`・`--state` の値と `-f/--file`・`--dir` のパスを補完します（`--stage` / `--version` は AWS を呼ばないため補完しません）。対応シェルは zsh のみです。

## AI エージェント向けスキル

Claude Code などの AI エージェントが flarelet CLI を安全に使うための [Agent Skill](https://docs.claude.com/en/docs/claude-code/skills) を同梱しています。ワークフロー・安全上のルール（`destroy --stage-resources` の確認、シークレットは stdin、`auth: false` は明示指示のときだけ、など）・トラブルシュートと、全コマンド／`flarelet.yaml` の全キーのリファレンスが入っています。

インストール方法は 2 通りあります。

```bash
# 1. skills CLI で入れる（エージェント横断。flarelet のインストールは不要）
npx skills add youyo/flarelet                               # このプロジェクトに入れる
npx skills add youyo/flarelet -a claude-code -a codex       # 対象のエージェントを指定
npx skills add youyo/flarelet -g                            # グローバルに入れる
npx skills update                                           # 入れたスキルを更新

# 2. flarelet CLI から入れる（インストール済みの CLI に同梱された、同じバージョンのスキル）
flarelet skill install            # このプロジェクトに入れる
flarelet skill install --global   # ~/ に入れる（全プロジェクトで使える）
```

複数のエージェントにまとめて入れたい、GitHub の最新のスキルに追従したいときは `npx skills add`、使っている CLI と同じバージョンのスキルを入れたいときは `flarelet skill install` を使います（以下はこのコマンドの説明です）。

- 実体は `<root>/.agents/skills/flarelet/`（`SKILL.md` と `references/`）。`<root>/.claude/skills/flarelet` はそこへの相対シンボリックリンク（`../../.agents/skills/flarelet`）です。`<root>` は既定でカレントディレクトリ、`--dir <path>` で別のプロジェクトルート、`--global` でホームディレクトリ
- 既存のインストールは `--force` が無いと上書きしません。同じ向きのリンクが既にあれば何もしません
- シンボリックリンクを作れない環境（Windows など）では警告を出して `.claude/skills/flarelet` にコピーします
- このリポジトリでは `.agents/skills/flarelet/` が正本で、`.claude/skills/flarelet` がリンクです。スキルの本文は CLI の実装とテストで突き合わせています（コマンド／オプションの実在、リンク切れ、`flarelet.yaml` の例の検証）

## 制約

- **応答サイズは 6MB まで**（Lambda の同期 Invoke の上限）。大きなファイルは S3 経由にしてください
- リクエストのタイムアウトは 30 秒以内（app < front <= 30s）。app のタイムアウトは 504 になります
- 認証ありの場合、HTTP API の `$default` ルート → front auth Lambda → app Lambda の 2 段構成です
- ログの配信には遅延があります。`flarelet logs --follow` は CloudWatch Logs Live Tail を使いますが、CloudWatch への取り込みは即時ではありません
- Cookie は host 単位です。異なる host（異なる環境）の間ではセッションは共有されず、環境ごとにサインインします
- PR プレビューは DB / ストレージが空で新規作成され、本番データは複製しません
- 実 GitHub リポジトリでの PR 動作確認は v0 の範囲外です（テンプレート・resolver・CLI まで）
- `--ci` はフォーク PR を扱いません。`destroy --ci` は closed の PR イベントでのみ動きます
- カスタムドメインは v0 の対象外です
- **`http.auth: false` の stage では `x-flarelet-*` ヘッダを除去する層がありません。** クライアントが `x-flarelet-user-sub` などを自由に付けて送れるので、アプリはこれらのヘッダを信頼しないでください。`flarelet/runtime` の `identity()` は `FLARELET_AUTH_ENABLED=false` を見て常に `null` を返しますが、Python などでヘッダを直接読む場合は `FLARELET_AUTH_ENABLED` が `true` のときだけ使ってください

## 開発者向け

```bash
mise run build        # dist/ へビルド
mise run test         # unit + E2E（AWS に接続しない）
mise run test:unit    # vitest（test/unit）
mise run test:e2e     # ビルド済み CLI を実プロセスで実行（test/e2e、AWS は FLARELET_OFFLINE=1）
mise run lint         # ESLint + Prettier
mise run typecheck    # tsc
mise run fmt          # Prettier で整形
mise run dev          # tsc --watch
mise run pack:check   # npm パッケージの同梱物を確認（npm pack --dry-run）
mise run lint:actions # GitHub Actions ワークフローを actionlint で検証
```

そのほかのタスク: `test:e2e:file` / `test:e2e:aws:file`（1 ファイルだけ実行）、`test:e2e:python-env`（`flarelet dev` の E2E 用 venv）、`playwright:install`。一覧は `mise tasks` で確認できます。

### E2E の 2 段構成

1. **常時 E2E**（`mise run test:e2e`）: `init` / `synth` / `plan` / `--ci` の判定など、AWS に接続せず確認できる振る舞い。認証情報には無効な値を与え、誤って実 AWS に触れないようにしています
2. **実 AWS E2E**（オプトイン）: 実際に deploy → HTTP・認証・ログを確認 → destroy します。テスト専用の名前（`fe2e-*`、`flarelet-e2e/*`）のリソースだけを作り、終了時に残りが無いことを検証します

   ```bash
   FLARELET_E2E_AWS=1 mise run test:e2e:aws
   ```

   `FLARELET_E2E_AWS` を設定しないとスキップされます。AWS 認証と `AWS_REGION`（`ap-northeast-1`）が必要です。`bootstrap github` の E2E は、アカウントに既にある GitHub OIDC プロバイダを変更・削除しないことも検証します。`bootstrap aws` の E2E は未 bootstrap の `us-west-2` を使い（bootstrap 済みなら中止します）、`deploy` が止まること、`deploy --bootstrap` が bootstrap してデプロイすることを確認したあと、`CDKToolkit` スタックとそのステージング用バケット・ECR リポジトリを削除します。

### CI

`.github/workflows/ci.yml` は PR と `main` への push で動きます。zsh を入れ（補完の E2E が使います）、mise でツール（Node・Python・actionlint）を用意してから、`mise run install`、`lint`、`lint:actions`、`typecheck`、`test`（unit + 常時 E2E。AWS 認証情報は渡しません）、`pack:check` を実行します。

開発手法は TDD（Red → Green → Refactor、Unit と E2E の両方）です。

## ライセンス

[MIT](LICENSE)

## リリース手順

メンテナ向けです。公開は `v*` タグの push で [`.github/workflows/release.yml`](.github/workflows/release.yml) が行います。npm の trusted publishing（OIDC）を使うので、npm トークンはどこにも保存しません。provenance も自動で付きます（公開リポジトリからの公開のみ）。

1. `package.json` の `version` を上げてコミットし、`git tag vX.Y.Z && git push origin vX.Y.Z`
2. ワークフローが lint / typecheck / test / pack:check を通し、タグと `package.json` の version の一致を確認してから `npm publish` し、GitHub Release（リリースノート自動生成）を作ります

### 初回公開（一度だけ手動）

trusted publisher は npm 上に存在するパッケージにしか登録できないため、最初の 1 回だけ手元から公開します。

```bash
mise run install && mise run test    # 事前確認
npm login
npm publish --provenance=false       # 手元では provenance を生成できない
```

その後 npmjs.com の `flarelet` パッケージの Settings → Trusted Publisher で GitHub Actions を選び、Organization or user `youyo`、Repository `flarelet`、Workflow filename `release.yml` を登録します（npm 11.15 以上なら `npm trust github flarelet --file release.yml --repo youyo/flarelet --allow-publish` でも可）。以降は上記のタグ push だけで公開できます。初回の version と同じタグを push した場合、ワークフローは npm への公開を飛ばして GitHub Release だけを作ります。
