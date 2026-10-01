# Flarelet v0 実装上の決定事項

`FLARELET_V0_DESIGN.md` を補完する、実装開始時に確定した判断。仕様と矛盾する場合は仕様を優先し、本書を更新する。

## 全体
- Node 24 / TypeScript（ESM）。ランタイム・タスクは `mise.toml` で管理し、`mise run <task>` で実行する
- 単一 npm パッケージ `flarelet`。runtime bindings はサブパス export `flarelet/runtime`
- CDK は `aws-cdk-lib` + `@aws-cdk/toolkit-lib` をプログラムから呼ぶ（グローバル `cdk` CLI に依存しない）
- 生成物は `<app>/.flarelet/out/`（Cloud Assembly）、`.flarelet/metadata.json`
- CLI の出力は英語
- テスト: vitest。Unit（`test/unit`）と E2E（`test/e2e`）
  - E2E（常時）: ビルドした CLI バイナリを実プロセスで起動し、`init` / `synth` / `plan` 等の出力・終了コード・生成テンプレートを検証
  - E2E（オプトイン）: `FLARELET_E2E_AWS=1` のときだけ実 AWS に deploy → HTTP/認証を確認 → destroy

## Config → IR → Resolver → Constructs
- YAML の型はそのまま CDK に渡さない。正規化済み Flarelet IR を境界にする
- `http: true` は `http: { auth: true }` と同義。auth 省略時は true。`auth: false` のみ公開
- Deployment Resolver: Git ref / CLI 引数 → `{ stage, version }`。lifecycle は `preview/pr-N` のときだけ ephemeral（下記「独立検証の指摘対応」）
  - 既定: default branch → `prod/current`（stage 名は `prod`。設定キーは `git.production`）、PR → `preview/pr-{n}`
  - 仕様 §8 の `git.production.branch` glob + `version: branch`（`release/v1` → `prod/v1`）、`git.preview.branch: default`

## スタック構成（ライフサイクルスコープ）
- 永続ステージ: stage スタック（Auth=Cognito User Pool + ドメイン、Database、Storage、Secrets 参照、Cookie 署名鍵）と version スタック（HTTP API、front auth Lambda、app Lambda、Cognito app client）
- PR preview: 1 スタックに全部（DB/Storage は空で新規、Preview Auth）。本番データは複製しない
- スタック名例: `flarelet-{app}-{stage}`、`flarelet-{app}-{stage}-{version}`

## 認証（advisor 合意済み）
- HTTP API の `$default` ルート → **front auth Lambda（Node）** → セッション Cookie 検証 → app Lambda を同期 Invoke（HTTP API v2 イベントを転送）
  - 理由: HTTP API の Lambda authorizer はリダイレクト不可、gateway response のカスタマイズ不可
  - front はクライアント由来の `x-flarelet-*` ヘッダを必ず削除してから identity ヘッダ（`x-flarelet-user-sub`、`x-flarelet-user-email` 等）を付与
  - app Lambda は front からのみ Invoke 可能（IAM）
  - タイムアウト: app < front <= 30s。app のタイムアウトは 504 に変換
  - 応答上限 6MB（制約として明記）
- エンドポイント: `/__flarelet/auth/login`、`/__flarelet/auth/callback`、`/__flarelet/auth/logout`
- Cognito: User Pool は stage スコープ。app client は **version スタック**で作る（HTTP API URL は Api 作成時に確定 → client の callback → auth Lambda env の順で非循環）。public client + PKCE。ドメインプレフィックスは決定的に自動生成（`{app}-{stage}-{短縮ハッシュ}`）
- Cookie 署名鍵と Preview トークンは Secrets Manager `GenerateSecretString`（CFN ネイティブ）で生成。署名鍵は stage スコープ（preview は preview スタック内）
- Preview Auth: front Lambda のモード切替。トークンは preview スタックの Secrets Manager secret。`/__flarelet/auth/preview?token=...` のマジックリンクで Cookie 発行。トークンは CLI（例: `flarelet env url --with-token`）で取得。CI ログには出さない
- `auth: false` の場合は front Lambda を置かず HTTP API → app Lambda 直結（永続 stage のみ。PR preview は下記「独立検証の指摘対応」の通り Preview Auth を強制）

## ランタイム
- app Lambda は Lambda Web Adapter（レイヤー）で Web アプリをそのまま動かす。ポート 8080
- Python: `app/main.py` の `app`（ASGI, uvicorn）、依存は `app/requirements.txt`
- TypeScript: `app/index.ts`（Hono 等、`PORT` で listen）、依存は `app/package.json`。esbuild でバンドル
- ビルドは必要に応じ Docker を使用（Docker は利用可能）
- バインディングは環境変数: `FLARELET_DATABASE_<NAME>_TABLE`、`FLARELET_STORAGE_<NAME>_BUCKET`、`FLARELET_AI_<NAME>_MODEL_ID`、secrets は変数名そのまま
- AI モデルは Flarelet model registry で論理名→ Bedrock モデル ID/推論プロファイルに解決

## Git / CI
- PR preview: GitHub Actions テンプレート（open/synchronize で deploy、closed で destroy、URL を PR コメント）
- AWS OIDC ロールを作る CLI コマンドを用意（`flarelet bootstrap github`）
- 実リポジトリでの PR 動作確認は v0 の範囲外（テンプレート + resolver テスト + CLI まで）

## front auth Lambda の環境変数契約（src/auth ↔ src/constructs）
- エントリ: `src/auth/handler.ts` の `handler`（HTTP API payload v2 を受けて v2 レスポンスを返す）
- `FLARELET_AUTH_MODE`: `cognito` | `preview`
- `FLARELET_APP_FUNCTION_NAME`: Invoke 先 app Lambda
- `FLARELET_SESSION_SECRET_ARN`: Cookie 署名鍵（Secrets Manager）
- `FLARELET_SESSION_EPOCH_PARAM`: セッション世代の SSM パラメータ名（必須。「セキュリティスキャンの指摘対応」）
- cognito: `FLARELET_COGNITO_DOMAIN`（`https://<prefix>.auth.<region>.amazoncognito.com`）、`FLARELET_COGNITO_CLIENT_ID`、`FLARELET_COGNITO_USER_POOL_ID`（issuer/JWKS 検証用）
- preview: `FLARELET_PREVIEW_TOKEN_SECRET_ARN`
- app へ渡すヘッダ: `x-flarelet-user-sub`、`x-flarelet-user-email`、`x-flarelet-user-email-verified`（`true`|`false`）、`x-flarelet-auth-mode`

## ユーザー secrets
- `flarelet secret set NAME` → SSM SecureString `/flarelet/{app}/{stage}/secrets/{NAME}`（stage スコープ）
- app Lambda は Flarelet 生成のランチャー（LWA の起動コマンド）が起動時に SSM パスから取得して環境変数に設定し、アプリを exec する。Python は boto3、Node は AWS SDK v3（どちらも Lambda ランタイム同梱）を使用。ユーザーコードは `os.environ` / `process.env` で読むだけ
- IAM: app Lambda に該当パスの `ssm:GetParametersByPath` と `kms:Decrypt`（aws/ssm）

## ユーザー回答による追加決定（Phase 2 以降）
- Cognito ユーザー管理: `flarelet auth user add/list/remove <email>`（管理者招待、自己サインアップ無効）
- 外部 IdP: `http.auth.provider: google | oidc` を Cognito の IdP として実装。クライアント ID/secret 等は Flarelet secrets から渡す。検証は synth レベル（実 IdP ログインは範囲外）
- `flarelet dev`: 既定は専用の dev 環境 `preview/local-<user>`（DB/Storage など stateful binding のみのスタック）を自動作成し、ローカルアプリに環境変数で接続、ファイル監視で再起動。`--stage/--version` 指定時は既存環境のリソースに接続（新規スタック作成なし）

## 外部 IdP（Phase 3A）
- 設定: `http.auth.provider: google` / `http.auth: { provider: oidc, issuer: https://..., scopes?: [...], name?: <表示名> }`。issuer・scopes・name は非秘密値なので YAML に置く（oidc 以外で指定するとエラー）。scopes 既定 `openid email profile`（`openid` 必須）、name 既定 `OIDC`。`saml` は予約語として残し「not supported in v0」の検証エラー（`entra` は Phase 3C で対応）
- 資格情報の名前は規約で固定: google → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`、oidc → `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET`。`flarelet secret set <名前> --stage <stage>` で設定する。`secrets:` への宣言は不要かつ禁止（宣言するとアプリの環境変数に渡ってしまうため。該当 provider のときだけ予約）
- 保存先は **Secrets Manager** `flarelet/{app}/{stage}/auth/{NAME}`（SSM ではない）。理由: CloudFormation の `ssm-secure` 動的参照は対応リソースが限定されており `AWS::Cognito::UserPoolIdentityProvider` は含まれない（https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-ssm-secure-strings.html ）。`secretsmanager` 動的参照は全リソースプロパティで使える（https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references-secretsmanager.html ）。値はテンプレートに入らない
- 動的参照は deploy 時に取得した **VersionId で固定**する（`{{resolve:secretsmanager:<name>:SecretString:::<versionId>}}`）。CloudFormation はプロパティが変わらないと値を再取得しないため、固定しないとシークレット更新が IdP に反映されない。オフラインの synth / plan はバージョンなし
- deploy は IdP を作る永続 stage で資格情報の存在を先に確認し、無ければ synth 前に `flarelet secret set ...` を案内して終了する（plan は警告のみ）。PR preview は preview token 認証なので不要
- stage スタックに `UserPoolIdentityProvider`（コンストラクト ID `IdentityProvider`、概念 `authentication`）。属性マッピングは `email`。version スタックの app client の `SupportedIdentityProviders` は外部 IdP のみ（`COGNITO` は外す）。front Lambda に `FLARELET_COGNITO_IDENTITY_PROVIDER` を渡し、authorize に `identity_provider` を付けて IdP 選択画面を飛ばす
- `destroy --stage-resources` は該当 stage の IdP 資格情報（全 provider 分）も削除する（ForceDeleteWithoutRecovery）
- provider を変更する場合: 変更前の provider で `secrets:` に宣言して SSM に入れていた同名の値（例: provider が cognito のときの `GOOGLE_CLIENT_SECRET`）は自動移行しない。アプリへの露出を止めるため、切り替え前に `flarelet secret delete <名前>` で SSM 側を消し、改めて `flarelet secret set` する（Secrets Manager 側に入る）
- 外部 IdP の stage では app client が `COGNITO` を受け付けないため、`flarelet auth user add` で招待したユーザーはサインインに使えない
- Cognito の自己サインアップ無効は federated ユーザーには効かないため、google では任意の Google アカウントが IdP 認証を通れる。アプリに入れる人の制限は `http.auth.allow`（Phase 3C）で行う

## flarelet dev（Phase 3A）
- 既定: `preview/local-<user>`（user は OS ユーザー名を小文字英数字とハイフンに正規化、`local-` 込み 32 文字以内、空なら `dev`）。DB / Storage だけを持つ 1 スタック（version スタック名 `flarelet-{app}-preview-local-<user>`、タグ `flarelet:lifecycle=dev`、DeletionPolicy=Delete）を toolkit-lib で deploy。バインディング値は出力 `Bindings`（JSON）。`.flarelet/dev/out` に synth（`.flarelet/out` / metadata.json は触らない）。DB/Storage が無ければスタックを作らない。`flarelet destroy --stage preview --version local-<user>` で消える
- `--stage/--version` 指定時: 既存 version スタックの `AppFunctionName` 出力から app Lambda の環境変数（`FLARELET_DATABASE_*` / `FLARELET_STORAGE_*` / `FLARELET_AI_*`）を読む。新しい出力を足さないので既存環境に再 deploy なしで接続できる
- AI はローカル資格情報で直接呼ぶので model registry から解決した ID を渡すだけ。secrets は該当 stage の SSM を復号して環境変数に（値は表示しない）。AWS_REGION も渡す
- `FLARELET_OFFLINE=1`: AWS に接続せずアプリだけ起動（バインディングは `offline` 表示）
- ローカル起動: 利用者のポート（既定 8787、127.0.0.1）に薄いプロキシ、アプリは内部の空きポート（`PORT`）。プロキシはクライアント由来の `x-flarelet-*` を必ず削除し、`--as <email>` のときだけ `x-flarelet-user-email` / `x-flarelet-user-sub: dev:<email>` / `x-flarelet-auth-mode: dev` を付ける。アプリ再起動中は最大 15 秒待ってから転送
- python: `python -m uvicorn main:app`（cwd `app/`、PATH の `python`、無ければ `python3`。依存は利用者の環境に入っている前提）。typescript: 本番と同じ esbuild で `app/index.ts` を `.flarelet/dev/app/index.mjs` にバンドル（ローカルには AWS SDK が無いので外部化しない＝アプリの node_modules から取り込む）し、CLI と同じ Node で実行。tsx 等の依存追加なし
- 再起動は Flarelet 自身のファイル監視（`fs.watch` recursive、`app/` 配下、node_modules / __pycache__ / venv / ドットファイル / *.pyc 等は無視、150ms デバウンス、SIGTERM → 3 秒後 SIGKILL）。ビルド失敗やクラッシュ時は次の変更を待つ

## v0 残課題の対応（Phase 3C）

### destroy の実行ロール
- `deleteStack` は `DescribeStacks` の `RoleARN`（CDK が作成時に使った `cdk-<qualifier>-cfn-exec-role-*`）を `DeleteStack` に明示して渡す。スタックにロールが無ければ渡さない
- 背景: CloudFormation はスタックに紐づくサービスロールを以後の全操作に使い、そのスタックを操作できる利用者は `iam:PassRole` が無くてもそのロールを使える（https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html ）。実アカウントで CDK デプロイ済みスタックの `RoleARN` が cfn-exec であることを確認済み。よって RoleARN 省略でも CI ロール（削除対象への直接権限なし）での削除は cfn-exec で行われるが、呼び出し元の資格情報に頼らない経路を明示するため渡す。実 AWS E2E（python）で Flarelet スタックの RoleARN が cfn-exec であることを検証する

### logs --follow の遅延計測
- Lambda → CloudWatch Logs の配信（実測 約 10 秒）は AWS 側で CLI の遅延ではない。E2E は「CloudWatch Logs がイベントを受理した時刻（`ingestionTime`）→ CLI 表示」と「PutLogEvents 完了 → CLI 表示」を測り、どちらも中央値 3 秒未満を要求する（実測 約 1 秒）。ingestionTime は AWS の時計なのでローカル時計とのずれを含む

### python の flarelet dev の E2E
- `mise.toml` の `[tools]` に python 3.13。常時 E2E の前提タスク `test:e2e:python-env` が `.flarelet/e2e-python` に venv を作り `test/e2e/python/requirements.txt`（fastapi / uvicorn をバージョン固定）を入れる。mise の `sources`/`outputs` で 2 回目以降はスキップ（初回のみネットワークが必要）
- E2E は venv の bin を PATH 先頭に置いて `flarelet dev` を起動し、HTTP 応答・`--as`・ファイル変更での再起動・`__pycache__` で再起動しないことを確認する

### アクセス制限 `http.auth.allow`
- `http.auth.allow: { domains?: string[], emails?: string[] }`。未指定なら IdP で認証できた人は誰でも可。cognito（既定）・google・oidc・entra のすべてで指定可。空（両方空）はエラー（黙って全員許可にしない）。小文字に正規化、どちらかに一致すれば許可（OR）。front Lambda の環境変数で渡すためカンマ区切りの合計 2000 文字まで
- front Lambda 環境変数: `FLARELET_AUTH_PROVIDER`（cognito|google|oidc|entra）、`FLARELET_AUTH_ALLOW_DOMAINS` / `FLARELET_AUTH_ALLOW_EMAILS`（カンマ区切り、指定時のみ）。PR preview（Preview Auth）には渡さない
- 判定（id_token 検証後、callback で 1 回）:
  - google: domains は Google の `hd`（Workspace の hosted domain）を `custom:hd` にマッピングしたものが一致すること。email のドメインでは判定しない（会社ドメインの email で作った個人 Google アカウントを弾く）。emails は `email_verified=true` の email の完全一致
  - cognito / oidc: `email_verified=true` の email のドメイン（完全一致、サブドメインは別）/ アドレスの完全一致
  - entra: Entra の id_token には `email_verified` が無い（https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference ）。テナント固有 issuer でテナント外のアカウントは入れない前提で、email（無ければ `preferred_username`）のドメイン / 完全一致で判定する。Microsoft は email / preferred_username を認可判断に使わないよう注意しているため、強い制限はシングルテナント登録（とテナント側のユーザー管理）で行い、allow はゲスト（B2B）除外などの補助と位置付ける
- 拒否: 403 の HTML（サインアウトリンク `/__flarelet/auth/logout` 付き、メールアドレスはエスケープ）。セッション Cookie は発行せず flow Cookie は消す
- セッションには発行時のポリシーの指紋（provider + 正規化したリストの sha256 先頭 16 文字、`ap`）を入れ、現在のポリシーと一致しないセッションは無効（allow を変えて deploy すると既存セッションは再サインイン・再判定になる）。ポリシーが無いときは従来どおり
- google の User Pool には `custom:hd`（String、mutable）を **allow の有無に関わらず** 付ける（後から allow を足してもスキーマが変わらないように）。cognito / oidc / entra のプールのスキーマは変えない
  - User Pool の `Schema` の更新は「No interruption」（https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html ）。カスタム属性は追加できるが変更・削除はできないので、一度付けたら変えない
  - 実 AWS E2E（`test/e2e/aws/idp-upgrade.test.ts`）で、既存 stage（cognito、ユーザーあり）を google + allow に切り替えて deploy しても User Pool ID が変わらず、ユーザーが残り、`custom:hd` が追加されることを確認済み
- app client: カスタム属性は既定では読めない／書けない（`ReadAttributes` 省略時は標準属性と `email_verified` のみ。IdP でマッピングする属性は書き込み可能である必要がある。https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html ）。google のときだけ `ReadAttributes = email, email_verified, custom:hd`、`WriteAttributes = email, custom:hd`（`email_verified` は WriteAttributes に指定すると Cognito が拒否する。実 API で確認）
- 属性マッピング: google は email / email_verified / custom:hd←hd、oidc は email / email_verified、entra は email / preferred_username
- `flarelet auth user add` は外部 IdP の stage では「招待ユーザーはサインインに使えない」と警告して続行する
- 未検証: 実 Google / Entra アカウントでのサインイン（`hd` が Cognito 経由で ID トークンに乗ること含む）は範囲外。Cognito は `custom:hd`←`hd` のマッピングを受け付けることまで実 AWS で確認

### Entra ID（`provider: entra`）
- `http.auth: { provider: entra, tenant: <ディレクトリ (テナント) ID> }`。Cognito の OIDC IdP（名前 `EntraID`、issuer `https://login.microsoftonline.com/<tenant>/v2.0`、scopes `openid email profile`、attributes_request_method GET）。資格情報 `ENTRA_CLIENT_ID` / `ENTRA_CLIENT_SECRET`（google / oidc と同じ Secrets Manager 経路）
- tenant は **GUID 必須**（AWS 公式 https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-oidc-idp.html は Entra の issuer に tenant ID / common / organizations / consumers を挙げるが、issuer 照合の要件は明記していない。以下は re:Post の事例と OIDC の iss 照合に基づく判断で、実 Entra では未検証）。ドメイン名を指定すると Entra のトークンの issuer（GUID 形式）と Cognito に設定した issuer が一致せず失敗するため（マルチテナント endpoint で issuer 不一致になるのと同じ理由。https://repost.aws/questions/QUkhhFfrn7RFuKJYS7OOcdqQ/microsoft-outlook-login-with-cognito-only-works-for-tenant-users ）。`common` / `organizations` / `consumers` と個人アカウント用テナント ID（9188040d-…）は拒否
- 手順の参照元: https://docs.aws.amazon.com/solutions/latest/spatial-data-management-on-aws/configure-entra-id.html （アプリ登録・リダイレクト URI `/oauth2/idpresponse`・scopes・issuer・email マッピング）
- User Pool は email 必須なので、email クレームを持たない Entra ユーザーはサインインできない（必須属性の変更はプール置換になるので変えない）
- `deploy` で資格情報が無いとき、IdP に登録するリダイレクト URI（`https://<prefix>.auth.<region>.amazoncognito.com/oauth2/idpresponse`、prefix は app/stage/アカウントから決定的）も表示する（google / oidc 共通）

## 独立検証の指摘対応

### PR preview の認証を強制（仕様 §9）
- 仕様 §9「PR previews are **not accidentally unauthenticated public applications**」に従い、PR preview（ephemeral）では `http.auth: false` でも Preview Auth（front Lambda の preview モード + トークン）を置く。`auth: false` が効くのは永続 stage だけ
- 実効的な認証は `effectiveAuth(ir, deployment)`（`src/ir/effective-auth.ts`）1 か所で決め、constructs / plan / deploy の表示はすべてこれを使う（IR は deployment に依存しないため IR には入れない）
- 表示: plan は `+ preview authentication (forced for pull request previews)`、deploy は `Auth  preview token (forced for pull request previews)`

### ephemeral の判定
- ephemeral は `stage = preview` かつ `version = pr-<N>` のときだけ。`release/pr-5`（`production.branch: release/*`, `version: branch`）は `prod/pr-5` の persistent
- Git 由来でこの組を作れるのは PR ref だけ（preview ブランチは `preview/current`）。`--stage preview --version pr-N` の明示は PR preview の予約名として `--pr N` と同じ扱い（スタック名 `flarelet-<app>-preview-pr-N` が同一なので、persistent として作ると既存の PR preview を別構成に置き換えてしまう。`plan` が案内する `flarelet deploy --stage preview --version pr-N` もこれで正しく PR preview になる）
- `pr-N` を他の stage（`prod` / `staging` など）で使うと通常の persistent version。`env list` の TYPE はスタックタグ `flarelet:lifecycle`（無い古いスタックは同じ規則で推定）

### アプリへの identity の信頼
- app Lambda に `FLARELET_AUTH_ENABLED`（front auth がある＝クライアントの `x-flarelet-*` を剥がす層があるなら `true`、`auth: false` の永続 stage では `false`）を渡す。`flarelet/runtime` の `identity()` は `false` のとき常に null を返す
- `auth: false` ではクライアントが送った `x-flarelet-*` がそのままアプリに届く。アプリはヘッダを信頼しないこと（README の制約）

### Cookie
- セッション Cookie は `__Host-flarelet_session`（Secure・Path=/・Domain なし。ブラウザがこの属性の場合だけ受け付ける）
- OAuth の flow Cookie は Path を `/__flarelet/auth` に絞るため `__Host-` は使えず、`__Secure-flarelet_flow`
- 名前の変更により、変更前に発行したセッションは無効（再サインイン）

### Preview トークンの URL
- `/__flarelet/auth/preview?token=...` は検証に成功すると Cookie を発行して `/` へ 302 する（トークンを含まない URL。従来から）。トークン付き URL はリンクを開いた時点のブラウザ履歴には残り得る

### CI ロール（bootstrap github）の権限を絞る
- Secrets Manager `GetSecretValue` は `aws:ResourceTag/flarelet:stage = preview` **かつ** `aws:ResourceTag/flarelet:lifecycle = ephemeral` のシークレットだけ。stage だけだと `git.preview.branch` の `preview/current`（persistent・Cognito）の Cookie 署名鍵も読めてしまうため lifecycle も条件に入れる
  - タグは CloudFormation のスタックタグ伝播に頼らず、テンプレートでシークレットに明示的に付ける（PR preview の SessionSecret / PreviewToken に `flarelet:stage` と `flarelet:lifecycle`、stage スタックの SessionSecret に `flarelet:stage`）
- CloudWatch Logs は `log-group:flarelet-*` と `log-group:flarelet-*:*` だけ。Flarelet の Lambda のロググループは名前を指定せず作っており、CloudFormation の自動命名でスタック名（`flarelet-<app>-...`）から始まる（`/aws/lambda/...` ではない）。StartLiveTail はロググループ ARN（末尾 `:*` なし）で評価されるので両方を書く
- `DeleteStack` は `flarelet-*-preview-pr-*` だけ（`destroy --ci` は PR closed でのみ動く）。永続 stage / version の削除は手元の認証情報で行う
- 実 AWS E2E は IAM ポリシーシミュレータ（`SimulatePrincipalPolicy`）でタグ・スタック名・ロググループ名ごとの許可／拒否を確認する
- 信頼ポリシーの `sub` は v0 では `repo:<owner>/<name>:*` のまま（リスクと絞り方は README）

### flarelet dev（python）の .pyc
- python の子プロセスに `PYTHONDONTWRITEBYTECODE=1` を渡す。.pyc の鮮度判定はソースの mtime（秒）とサイズなので、同じ秒に同じサイズで書き換えると古いバイトコードが使われ、再起動しても変更が反映されないことがある（利用者の実使用でも起きる）。書き込みを止めるだけなので、既存の `__pycache__` の .pyc はソースと mtime・サイズが一致する間は読まれる

## セキュリティスキャンの指摘対応

### 未検証 email（F1）
- セッションに `ev`（email_verified）を持ち、app へ `x-flarelet-user-email-verified: true|false` を渡す。`flarelet/runtime` の `identity()` は `emailVerified` を返す。`x-flarelet-user-email` は互換のため残す
- 判定: cognito / oidc / google は id_token の `email_verified` が `true` または `"true"` のときだけ true。entra は `email_verified` を出さないので常に false（allow の判定は従来どおり）。email が無い identity（preview）は false。`flarelet dev --as` は利用者が指定した擬似ユーザーなので true
- 古いセッション（`ev` なし）は false
- 認可・ユーザーの紐付けは `sub` を使う（README / runtime の JSDoc / スキルに明記）
- cognito ネイティブの User Pool に `UserAttributeUpdateSettings.AttributesRequireVerificationBeforeUpdate = [email]`（CDK `keepOriginal: { email: true }`）。新しい email は検証が済むまで反映されず、`email_verified` も元のまま。更新は「No interruption」（https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-cognito-userpool.html#cfn-cognito-userpool-userattributeupdatesettings ）。`AutoVerifiedAttributes` に email が入っていることが前提（CDK が `signInAliases.email` から入れる。unit で確認）
- 外部 IdP（google / oidc / entra）のプールには付けない（email は IdP の値でサインインのたびに上書きされる。検証待ちで止まる恐れがある）
- app client の `WriteAttributes` から email を外すことは **できない**: 実 API（使い捨ての User Pool、email 必須）で `WriteAttributes` に email を含めない組（`name` / `given_name` / `locale` 単独）はすべて `InvalidParameterException: Invalid write attributes specified while creating a client` で拒否され、`email` 単独は受理された。必須属性の変更はプール置換になるので行わない。代わりに keepOriginal と `emailVerified` で守る

### flarelet dev（F2 / F3 / F5 / F6）
- TypeScript アプリ（`flarelet init` のテンプレート、examples、実 AWS E2E のフィクスチャ）は `hostname: process.env.HOST ?? "127.0.0.1"` で listen する。Lambda では Lambda Web Adapter が 127.0.0.1:8080 にアクセスするので既定 127.0.0.1 で動く（実 AWS E2E の typescript / preview で確認）
- `flarelet dev` はアプリに `HOST=127.0.0.1` と起動ごとのランダムな `FLARELET_DEV_SECRET`（32 バイト base64url）を渡し、プロキシは転送するリクエストに `x-flarelet-dev-secret` を付ける（クライアント由来の同名ヘッダは `x-flarelet-*` として削除）。`identity()` は `FLARELET_DEV_SECRET` があればヘッダが一致するときだけ identity を返す（node:crypto に依存しない定数時間比較）。Python 向けの runtime は無いので README に同じ確認を書く
- プロキシは Host が `localhost` / `127.0.0.1` / `[::1]`（`:port` 可、大文字小文字無視）以外を 403（DNS rebinding）。Host が無い HTTP/1.1 は Node の http サーバーが 400 で拒否する
- `--as` のときだけ、`Sec-Fetch-Site: cross-site`、または Origin が `http://<Host>` と一致しない（`null` や別ポートを含む）リクエストを 403（CSRF）。`--as` なしは identity が無いので従来どおり

### セッションの失効（F4）
- セッション世代: SSM String パラメータ。永続 stage は stage スタックの `/flarelet/{app}/{stage}/auth/session-epoch`、PR preview は preview スタックの `/flarelet/{app}/{stage}/auth/{version}/session-epoch`（アプリが読む secrets パス `/flarelet/{app}/{stage}/secrets/` とは別）。auth が無い永続 stage には作らない。DeletionPolicy は Delete（スタックと一緒に消える）
- front はパラメータの **値ではなくバージョン**（`GetParameter` の `Parameter.Version`）をセッション（`se`）に入れ、現在のバージョンと一致しないセッションを拒否する。理由: CloudFormation はリソースのプロパティ（タグ等）が変わると値をテンプレートの初期値に書き戻すことがあり、値で比べると revoke 前の Cookie が復活し得る。バージョンは書き戻しでも revoke でも単調に進むので、失効が取り消される方向には倒れない。司令塔の指示（値を埋め込む）からの変更点
- front は世代を 60 秒キャッシュ（コンテナごと）。取得失敗はキャッシュせず 503（fail closed）。サインイン（callback / preview トークン）時も現在の世代を読んで埋め込む
- 名前は front Lambda の環境変数 `FLARELET_SESSION_EPOCH_PARAM` にリテラルで渡す（クロススタック Export を作らない）。front の権限は該当パラメータ 1 つの `ssm:GetParameter` だけ
- `flarelet auth revoke-sessions`（共通のターゲット指定。PR preview は `--pr N`）がパラメータを新しいランダム値で上書きしてバージョンを進める。パラメータが無い（未デプロイ、またはこの変更より前のデプロイ）ときは作らずにエラー（作ると次の deploy の CloudFormation 作成が「既に存在」で失敗するため）
- `flarelet auth user remove` も削除後に世代を進める（その stage の全員がサインインし直し）。パラメータが無ければ警告のみ
- 世代の導入により、変更前に発行したセッション（`se` なし）は無効（再サインイン）。セッションの最大寿命は 8 時間のまま

### CI ロール（bootstrap github）
- `secretsmanager:DescribeSecret` を `arn:aws:secretsmanager:{region}:{account}:secret:flarelet/*/auth/*` に追加（外部 IdP の stage を CI から deploy するときの資格情報チェック）。値（`GetSecretValue`）は従来どおり PR preview のシークレットだけ。実 AWS E2E のポリシーシミュレーションで許可／拒否を確認する


## 改名（2026-10-02）

- Flareon → Flarelet（パッケージ名・CLI 名・`flarelet.yaml`・`.flarelet/`・`x-flarelet-*`・`FLARELET_*`・`/__flarelet/auth/*`・Cookie・スタック名とタグ・SSM / Secrets Manager の名前・CI ロールまで全面的に置き換え）
- 理由: npm の `flareon` は既存パッケージあり、ポケモン（The Pokémon Company）の商標・Flare-On CTF との重複。flarelet は npm / GitHub / .dev / .sh / .io / .com が空いていた
- 既存デプロイが AWS に無いため、旧名の読み替え（後方互換）は入れない
