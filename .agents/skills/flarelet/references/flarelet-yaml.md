# flarelet.yaml リファレンス

`src/config/schema.ts`（zod、`strictObject`）から起こしたスキーマです。**未知のキーはすべてエラー**になります。迷ったら `flarelet validate` で確認してください。

## トップレベル

| キー       | 必須 | 内容                                                                                       |
| ---------- | ---- | ------------------------------------------------------------------------------------------ |
| `version`  | 必須 | `1` 固定                                                                                   |
| `name`     | 必須 | アプリ名。小文字英字始まりの小文字英数字とハイフン（連続・末尾のハイフン不可）、2〜24 文字 |
| `runtime`  | 必須 | 下記                                                                                       |
| `http`     | 任意 | 省略すると HTTP エンドポイントなし                                                         |
| `database` | 任意 | DynamoDB。名前ごとにテーブル                                                               |
| `storage`  | 任意 | S3。名前ごとにバケット                                                                     |
| `ai`       | 任意 | Bedrock のモデル                                                                           |
| `secrets`  | 任意 | シークレット名（環境変数名）の配列                                                         |
| `git`      | 任意 | ブランチと PR の対応付け                                                                   |

## runtime

```yaml
runtime:
  language: python # python | typescript
  version: "3.13" # 任意。必ず引用符つきの文字列（3.13 と書くと数値になりエラー）
```

`version` は `^\d+(\.\d+)*$` の形式の文字列。省略時の既定は python `3.13`、typescript `24`。

## http

| 書き方                    | 意味                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| `http: true`              | 認証あり（既定の Cognito 招待制）                                          |
| `http: false`             | HTTP エンドポイントなし（`http` 省略と同等）                               |
| `http: { auth: true }`    | `http: true` と同じ                                                        |
| `http: { auth: false }`   | **認証なしで公開**（永続 stage のみ。PR プレビューは Preview Auth を強制） |
| `http: { auth: { ... } }` | 外部 IdP／アクセス制限（下記）                                             |

`http` はオブジェクトのとき `auth` キーだけを持てます。

### http.auth（オブジェクト形式）

| キー       | 内容                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `provider` | `google` / `oidc` / `entra`（省略時は Cognito の招待制）。`saml` は予約語で `not supported in v0` エラー                             |
| `issuer`   | `provider: oidc` で必須。`https://` の URL                                                                                           |
| `scopes`   | `provider: oidc` のみ。OAuth スコープの配列（空不可、`openid` を含むこと）。既定 `openid email profile`                              |
| `name`     | `provider: oidc` のみ。サインイン画面の表示名。1〜32 文字（英数字・空白・`.` `_` `-`）、Google/Cognito 等の予約名は不可。既定 `OIDC` |
| `tenant`   | `provider: entra` で必須。ディレクトリ（テナント）ID の GUID。ドメイン名や `common` / `organizations` / `consumers` は不可           |
| `allow`    | アプリに入れる人の制限（下記）。省略時は IdP で認証できた人は誰でも可                                                                |

`issuer` / `scopes` / `name` は `oidc` 以外、`tenant` は `entra` 以外で指定するとエラーです。

### http.auth.allow

```yaml
allow:
  domains: [example.com] # ドメイン名（@ やワイルドカードは不可）
  emails: [partner@gmail.com]
```

- `domains` / `emails` はどちらか一方でよく、**両方空はエラー**（黙って全員許可にはしません）。どちらかに一致すれば許可（OR）
- 全要素をカンマ区切りで連結して **2000 文字まで**（多い場合は `domains` を使う）
- PR プレビュー（Preview Auth）には適用されません
- 判定ルールは provider ごとに違います（google は Workspace の `hd`、cognito/oidc は `email_verified=true` の email、entra は email／`preferred_username`）。許可リストを変えて deploy すると既存セッションは無効になります

### 外部 IdP の資格情報

`secrets:` には書きません（書くとエラー）。stage ごとに CLI で設定します。

| provider | 設定する名前                                |
| -------- | ------------------------------------------- |
| google   | `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` |
| oidc     | `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`     |
| entra    | `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`   |

```bash
flarelet secret set GOOGLE_CLIENT_ID --stage prod
flarelet secret set GOOGLE_CLIENT_SECRET --stage prod
```

## database / storage

```yaml
database:
  main: {} # DynamoDB テーブル。`main:`（値なし）も同じ
storage:
  files: {} # S3 バケット
```

キーはリソース名（`name` と同じ命名規則、24 文字まで）。値に指定できる項目は v0 にはなく、`{}` のみです。アプリには次の環境変数で渡ります。

| 宣言              | 環境変数                         |
| ----------------- | -------------------------------- |
| `database.<name>` | `FLARELET_DATABASE_<NAME>_TABLE` |
| `storage.<name>`  | `FLARELET_STORAGE_<NAME>_BUCKET` |

## ai

```yaml
ai:
  models:
    - sonnet
```

`models` は論理名の配列（重複不可）。使えるのは `sonnet` / `opus` / `haiku` / `nova-micro` / `nova-lite` / `nova-pro`（`src/constructs/ai-models.ts` のレジストリ）。アプリには `FLARELET_AI_<NAME>_MODEL_ID` で解決済みのモデル ID が渡ります。

## secrets

```yaml
secrets:
  - EXTERNAL_API_KEY
```

環境変数名の形式（`A-Z`・`0-9`・`_`、英大文字始まり）。重複不可。`FLARELET_` と `AWS_` で始まる名前は予約済みで使えません。宣言した名前がそのまま環境変数としてアプリに渡ります。値は `flarelet secret set <name>` で設定します。

## git

```yaml
git:
  production:
    branch: "release/*" # glob（* は / を跨がない、** は跨ぐ）、または default
    version: branch # "branch" か固定の version 名
  preview:
    branch: default # このブランチは preview/current
  pullRequests: true # false で PR プレビューを作らない
```

| キー                 | 既定      | 内容                                                                                                   |
| -------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `production.branch`  | `default` | 本番にするブランチ。`default` はリポジトリのデフォルトブランチ                                         |
| `production.version` | `current` | `branch` ならブランチ名（glob のワイルドカード部分）から導く。例 `release/v1` -> `prod/v1`。固定名も可 |
| `preview.branch`     | なし      | 指定したブランチを `preview/current` にデプロイ                                                        |
| `pullRequests`       | `true`    | PR を `preview/pr-<番号>` としてデプロイするか                                                         |

`production` / `preview` はどちらも `branch` が必須（空文字不可）。`git` 自体を省略すると「デフォルトブランチ -> `prod/current`、PR -> `preview/pr-N`」です。マッピングに無いブランチは `--stage` / `--version` で明示するまでデプロイできません。

stage は小文字英数字とハイフン 16 文字まで、version は 32 文字までです。

## 完全な例

最小（認証あり、DB 付き）:

```yaml
version: 1
name: myapp
runtime:
  language: typescript
http: true
database:
  main: {}
```

AI とシークレットを使う Python アプリ:

```yaml
version: 1
name: notes-api
runtime:
  language: python
  version: "3.13"
http: true
database:
  notes: {}
storage:
  files: {}
ai:
  models:
    - sonnet
secrets:
  - EXTERNAL_API_KEY
```

Google Workspace でサインインさせ、自社ドメインだけ許可、`release/*` を本番にする:

```yaml
version: 1
name: internal-tool
runtime:
  language: typescript
http:
  auth:
    provider: google
    allow:
      domains: [example.com]
git:
  production:
    branch: "release/*"
    version: branch
  pullRequests: true
```

Entra ID（シングルテナント）:

```yaml
version: 1
name: corp-portal
runtime:
  language: python
http:
  auth:
    provider: entra
    tenant: 00000000-0000-0000-0000-000000000000
    allow:
      domains: [contoso.com]
```

汎用 OIDC:

```yaml
version: 1
name: sso-app
runtime:
  language: typescript
http:
  auth:
    provider: oidc
    issuer: https://idp.example.com
    scopes: [openid, email, profile]
    name: Corp
```

認証なしで公開（明示指示があるときだけ）:

```yaml
version: 1
name: public-site
runtime:
  language: typescript
http:
  auth: false
```
