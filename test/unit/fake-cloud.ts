import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Cloud,
  DeployedStack,
  Deployer,
  LogEvent,
  ParameterInfo,
  StackInfo,
  StackResource,
  UserInfo,
} from "../../src/aws/cloud.js";
import type { CfnTemplate } from "../../src/aws/concepts.js";
import type { ProgressEvent } from "../../src/aws/iohost.js";
import type { OpsDeps } from "../../src/cli/ops.js";
import type { BuildOptions } from "../../src/constructs/index.js";
import { stackNames } from "../../src/constructs/names.js";

/** メモリ上の AWS。呼び出しを calls に記録する。 */
export class FakeCloud implements Cloud {
  calls: string[] = [];
  accountId = "123456789012";
  stacks = new Map<string, StackInfo>();
  templates = new Map<string, CfnTemplate>();
  resources = new Map<string, StackResource[]>();
  secrets = new Map<string, string>();
  params = new Map<string, { value: string; lastModified: Date }>();
  functionEnv = new Map<string, Record<string, string>>();
  logs = new Map<string, LogEvent[]>();
  users = new Map<string, Map<string, UserInfo>>();
  deleted: StackResource[] = [];
  failAccount: Error | undefined;
  liveTail?: NonNullable<Cloud["liveTail"]>;

  addStack(s: Partial<StackInfo> & { name: string }): void {
    this.stacks.set(s.name, { status: "CREATE_COMPLETE", tags: {}, outputs: {}, ...s });
  }

  async account() {
    this.calls.push("account");
    if (this.failAccount) throw this.failAccount;
    return this.accountId;
  }
  async describeStack(name: string) {
    return this.stacks.get(name);
  }
  async listAppStacks(app: string) {
    return [...this.stacks.values()].filter((s) => s.tags["flareon:app"] === app);
  }
  oidcProvider: string | undefined;
  trustingRoles: string[] = [];
  async listStacksWithTag(key: string) {
    return [...this.stacks.values()].filter((s) => key in s.tags);
  }
  async findOidcProvider() {
    return this.oidcProvider;
  }
  async listRolesTrustingProvider() {
    return this.trustingRoles;
  }
  async getTemplate(name: string) {
    return this.stacks.has(name) ? this.templates.get(name) : undefined;
  }
  async listStackResources(name: string) {
    return this.resources.get(name) ?? [];
  }
  async deleteStack(name: string, onStatus: (s: string) => void) {
    this.calls.push(`deleteStack:${name}`);
    onStatus("DELETE_IN_PROGRESS");
    this.stacks.delete(name);
  }
  async deleteRetained(r: StackResource) {
    this.calls.push(`deleteRetained:${r.type}:${r.physicalId}`);
    this.deleted.push(r);
  }
  async getSecretValue(arn: string) {
    const v = this.secrets.get(arn);
    if (v === undefined) throw new Error(`no secret ${arn}`);
    return v;
  }
  async putParameter(name: string, value: string) {
    this.calls.push(`putParameter:${name}`);
    this.params.set(name, { value, lastModified: new Date(0) });
  }
  async listParameters(path: string): Promise<ParameterInfo[]> {
    return [...this.params.entries()]
      .filter(([n]) => n.startsWith(path))
      .map(([name, p]) => ({ name, lastModified: p.lastModified }));
  }
  async rotateParameter(name: string) {
    this.calls.push(`rotateParameter:${name}`);
    const p = this.params.get(name);
    if (!p) return false;
    this.params.set(name, { value: `rotated-${this.calls.length}`, lastModified: new Date(0) });
    return true;
  }
  async deleteParameter(name: string) {
    this.calls.push(`deleteParameter:${name}`);
    return this.params.delete(name);
  }
  async updateFunctionEnv(name: string, vars: Record<string, string>) {
    this.calls.push(`updateFunctionEnv:${name}`);
    this.functionEnv.set(name, { ...(this.functionEnv.get(name) ?? {}), ...vars });
  }
  async filterLogs(group: string, startTime: number, nextToken?: string) {
    this.calls.push(`filterLogs:${group}:${startTime}${nextToken ? `:${nextToken}` : ""}`);
    return { events: (this.logs.get(group) ?? []).filter((e) => e.timestamp >= startTime) };
  }
  async createUser(pool: string, email: string) {
    this.calls.push(`createUser:${pool}:${email}`);
    const m = this.users.get(pool) ?? new Map();
    m.set(email, {
      email,
      status: "FORCE_CHANGE_PASSWORD",
      enabled: true,
      created: new Date(0),
    });
    this.users.set(pool, m);
  }
  async listUsers(pool: string) {
    return [...(this.users.get(pool)?.values() ?? [])];
  }
  async deleteUser(pool: string, email: string) {
    this.calls.push(`deleteUser:${pool}:${email}`);
    return this.users.get(pool)?.delete(email) ?? false;
  }
  /** Secrets Manager（名前 → 値とバージョン）。 */
  smSecrets = new Map<string, { value: string; versionId: string }>();
  async describeSecret(name: string) {
    const v = this.smSecrets.get(name);
    return v ? { versionId: v.versionId, lastChanged: new Date(0) } : undefined;
  }
  async putSecret(name: string, value: string) {
    this.calls.push(`putSecret:${name}`);
    this.smSecrets.set(name, { value, versionId: `v${this.smSecrets.size + 1}` });
  }
  async deleteSecret(name: string) {
    this.calls.push(`deleteSecret:${name}`);
    return this.smSecrets.delete(name);
  }
  async getFunctionEnv(name: string) {
    this.calls.push(`getFunctionEnv:${name}`);
    const env = this.functionEnv.get(name);
    if (!env) throw new Error(`no function ${name}`);
    return env;
  }
  async getParameterValues(path: string) {
    this.calls.push(`getParameterValues:${path}`);
    const out: Record<string, string> = {};
    for (const [n, p] of this.params) if (n.startsWith(path)) out[n.slice(path.length)] = p.value;
    return out;
  }
}

export class FakeDeployer implements Deployer {
  outdirs: string[] = [];
  events: ProgressEvent[] = [];
  result: DeployedStack[] = [];
  error: Error | undefined;
  async deploy(outdir: string, onEvent: (e: ProgressEvent) => void) {
    this.outdirs.push(outdir);
    for (const e of this.events) onEvent(e);
    if (this.error) throw this.error;
    return this.result;
  }
}

export interface Harness {
  dir: string;
  file: string;
  out: string[];
  err: string[];
  cloud: FakeCloud;
  deployer: FakeDeployer;
  synthCalls: BuildOptions[];
  deps: OpsDeps;
  /** synth で書き出すテンプレート（スタック名 → テンプレート）。 */
  synthTemplates: Map<string, CfnTemplate>;
  secretInput: string | undefined;
  cleanup: () => Promise<void>;
}

export async function harness(yaml: string, env: Record<string, string> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "flareon-ops-"));
  const file = join(dir, "flareon.yaml");
  await writeFile(file, yaml);
  let clock = 1_000_000;
  const h: Harness = {
    dir,
    file,
    out: [],
    err: [],
    cloud: new FakeCloud(),
    deployer: new FakeDeployer(),
    synthCalls: [],
    synthTemplates: new Map(),
    secretInput: undefined,
    cleanup: () => rm(dir, { recursive: true, force: true }),
    deps: undefined as unknown as OpsDeps,
  };
  h.deps = {
    io: { stdout: (l) => h.out.push(l), stderr: (l) => h.err.push(l) },
    detectGit: async () => ({}),
    env,
    synthesize: (o) => {
      h.synthCalls.push(o);
      const names = stackNames(o.ir.name, o.deployment);
      const stacks: { name: string; kind: "stage" | "version" | "preview" }[] = [];
      if (names.stage) stacks.push({ name: names.stage, kind: "stage" });
      stacks.push({
        name: names.version,
        kind: o.deployment.lifecycle === "ephemeral" ? "preview" : "version",
      });
      // plan が読むテンプレートを書き出す
      mkdirSync(o.outdir, { recursive: true });
      for (const st of stacks) {
        const t = h.synthTemplates.get(st.name) ?? { Resources: {} };
        writeFileSync(join(o.outdir, `${st.name}.template.json`), JSON.stringify(t));
      }
      return { outdir: o.outdir, stacks };
    },
    cloud: () => h.cloud,
    deployer: () => h.deployer,
    now: () => (clock += 1000),
    sleep: async () => {},
    readSecret: async () => {
      if (h.secretInput === undefined) throw new Error("no input");
      return h.secretInput;
    },
  };
  return h;
}
