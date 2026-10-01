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

export interface UserInfo {
  email: string | undefined;
  status: string | undefined;
  enabled: boolean | undefined;
  created: Date | undefined;
}

export interface ParameterInfo {
  name: string;
  lastModified: Date | undefined;
}

export interface Cloud {
  /** STS の呼び出し元アカウント ID。 */
  account(): Promise<string>;
  describeStack(name: string): Promise<StackInfo | undefined>;
  /** `flareon:app` タグが app のスタック（削除済みを除く）。 */
  listAppStacks(app: string): Promise<StackInfo[]>;
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
  /** 関数の環境変数に vars をマージし、更新完了まで待つ（新しいコールドスタートを強制する）。 */
  updateFunctionEnv(name: string, vars: Record<string, string>): Promise<void>;
  filterLogs(
    group: string,
    startTime: number,
    nextToken?: string,
  ): Promise<{ events: LogEvent[]; nextToken?: string }>;
  createUser(userPoolId: string, email: string): Promise<void>;
  listUsers(userPoolId: string): Promise<UserInfo[]>;
  /** 無ければ false。 */
  deleteUser(userPoolId: string, email: string): Promise<boolean>;
}

export interface DeployedStack {
  name: string;
  outputs: Record<string, string>;
}

export interface Deployer {
  /** Cloud Assembly（outdir）の全スタックをデプロイする。依存順は CDK に任せる。 */
  deploy(outdir: string, onEvent: (e: ProgressEvent) => void): Promise<DeployedStack[]>;
}
