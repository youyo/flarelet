import type { CfnTemplate } from "./concepts.js";
import type { ProgressEvent } from "./iohost.js";

/** CLI が使う AWS 操作の境界。実装は ./real.ts（AWS SDK）、unit テストでは差し替える。 */

export interface StackInfo {
  name: string;
  status: string;
  tags: Record<string, string>;
  outputs: Record<string, string>;
}

export interface StackResource {
  logicalId: string;
  physicalId: string;
  type: string;
}

export interface LogEvent {
  id: string;
  timestamp: number;
  message: string;
}

export interface LiveLogEvent {
  /** ロググループ名。 */
  group: string;
  timestamp: number;
  message: string;
}

export interface UserInfo {
  email: string | undefined;
  status: string | undefined;
  enabled: boolean | undefined;
  created: Date | undefined;
}

export interface SecretInfo {
  versionId: string;
  lastChanged: Date | undefined;
}

export interface ParameterInfo {
  name: string;
  lastModified: Date | undefined;
}

export interface Cloud {
  /** STS の呼び出し元アカウント ID。 */
  account(): Promise<string>;
  describeStack(name: string): Promise<StackInfo | undefined>;
  /** CDK bootstrap のバージョン（SSM `/cdk-bootstrap/<qualifier>/version`）。未 bootstrap なら undefined。 */
  bootstrapVersion(qualifier: string): Promise<number | undefined>;
  /** `flarelet:app` タグが app のスタック（削除済みを除く）。 */
  listAppStacks(app: string): Promise<StackInfo[]>;
  /** 指定タグキーを持つスタック（削除済みを除く）。 */
  listStacksWithTag(key: string): Promise<StackInfo[]>;
  /** URL（https://host）の IAM OIDC プロバイダの ARN。無ければ undefined。 */
  findOidcProvider(url: string): Promise<string | undefined>;
  /** 信頼ポリシーが指定プロバイダを参照している IAM ロール名。 */
  listRolesTrustingProvider(providerArn: string): Promise<string[]>;
  /** デプロイ済みテンプレート。スタックが無ければ undefined。 */
  getTemplate(name: string): Promise<CfnTemplate | undefined>;
  listStackResources(name: string): Promise<StackResource[]>;
  /** スタックを削除し、消えるまで待つ。状態変化を onStatus に通知する。 */
  deleteStack(name: string, onStatus: (status: string) => void): Promise<void>;
  /** RETAIN でスタック外に残った物理リソースを削除する（無ければ何もしない）。 */
  deleteRetained(resource: StackResource): Promise<void>;
  getSecretValue(arn: string): Promise<string>;
  putParameter(name: string, value: string): Promise<void>;
  listParameters(path: string): Promise<ParameterInfo[]>;
  /** 無ければ false。 */
  deleteParameter(name: string): Promise<boolean>;
  /**
   * 既存の String パラメータの値を新しいランダム値に書き換える（バージョンが進む）。無ければ作らず false。
   * セッション世代（flarelet auth revoke-sessions）に使う。
   */
  rotateParameter(name: string): Promise<boolean>;
  /** 関数の環境変数に vars をマージし、更新完了まで待つ（新しいコールドスタートを強制する）。 */
  updateFunctionEnv(name: string, vars: Record<string, string>): Promise<void>;
  filterLogs(
    group: string,
    startTime: number,
    nextToken?: string,
  ): Promise<{ events: LogEvent[]; nextToken?: string }>;
  /**
   * CloudWatch Logs Live Tail。セッション開始で onStarted、受信ごとに onEvent を呼ぶ。
   * signal が中断されるか、セッションが終わる（最大 3 時間）と resolve する。使えない場合は reject。
   * 未実装の Cloud では undefined（呼び出し側はポーリングにフォールバックする）。
   */
  liveTail?(
    groups: string[],
    onEvent: (e: LiveLogEvent) => void,
    signal: AbortSignal,
    onStarted: () => void,
  ): Promise<void>;
  createUser(userPoolId: string, email: string): Promise<void>;
  listUsers(userPoolId: string): Promise<UserInfo[]>;
  /** 無ければ false。 */
  deleteUser(userPoolId: string, email: string): Promise<boolean>;
  /** Secrets Manager のシークレットのメタデータ（値は返さない）。無い・削除予定なら undefined。 */
  describeSecret(name: string): Promise<SecretInfo | undefined>;
  /** Secrets Manager のシークレットを作成または更新する。 */
  putSecret(name: string, value: string): Promise<void>;
  /** 復旧期間なしで削除する。無ければ false。 */
  deleteSecret(name: string): Promise<boolean>;
  /** Lambda 関数の環境変数。 */
  getFunctionEnv(name: string): Promise<Record<string, string>>;
  /** path 直下の SecureString を復号して返す（キーは path からの相対名）。 */
  getParameterValues(path: string): Promise<Record<string, string>>;
}

export interface DeployedStack {
  name: string;
  outputs: Record<string, string>;
}

export interface BootstrapTarget {
  account: string;
  region: string;
  qualifier: string;
}

export interface Deployer {
  /** Cloud Assembly（outdir）の全スタックをデプロイする。依存順は CDK に任せる。 */
  deploy(outdir: string, onEvent: (e: ProgressEvent) => void): Promise<DeployedStack[]>;
  /**
   * CDK bootstrap（CDKToolkit スタック）を新規作成する。
   * 既存の CDKToolkit を更新しないよう、呼び出し側が事前に未 bootstrap であることを確認する。
   */
  bootstrap(target: BootstrapTarget, onEvent: (e: ProgressEvent) => void): Promise<void>;
}
