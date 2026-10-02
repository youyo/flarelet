import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/index.js";
import { toIR } from "../../src/ir/index.js";

const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};
const base = "version: 1\nname: myapp\nruntime: { language: python }\n";

describe("toIR", () => {
  it("fills runtime defaults", () => {
    expect(ir(base).runtime).toEqual({ language: "python", version: "3.13" });
    expect(ir("version: 1\nname: a1\nruntime: { language: typescript }\n").runtime.version).toBe(
      "24",
    );
  });

  it("http absent -> null", () => {
    expect(ir(base).http).toBeNull();
  });

  it("http: true is authenticated by default", () => {
    expect(ir(base + "http: true\n").http).toEqual({
      auth: { enabled: true, provider: "cognito" },
      throttle: "default",
    });
  });

  it("http: {} and auth omitted are authenticated", () => {
    expect(ir(base + "http: {}\n").http).toEqual({
      auth: { enabled: true, provider: "cognito" },
      throttle: "default",
    });
  });

  it("http.throttle: unspecified -> default, false -> off, object -> as is", () => {
    expect(ir(base + "http: true\n").http?.throttle).toBe("default");
    expect(ir(base + "http: { auth: false }\n").http?.throttle).toBe("default");
    expect(ir(base + "http: { throttle: false }\n").http?.throttle).toBe("off");
    expect(ir(base + "http: { throttle: { rate: 5, burst: 9 } }\n").http?.throttle).toEqual({
      rate: 5,
      burst: 9,
    });
  });

  it("alerts: unspecified -> null, specified -> topicArn", () => {
    expect(ir(base).alerts).toBeNull();
    const arn = "arn:aws:sns:ap-northeast-1:123456789012:ops";
    expect(ir(base + `alerts: { topicArn: ${arn} }\n`).alerts).toEqual({ topicArn: arn });
  });

  it("http: false -> no http", () => {
    expect(ir(base + "http: false\n").http).toBeNull();
  });

  it("auth: false is the only public form", () => {
    expect(ir(base + "http: { auth: false }\n").http).toEqual({
      auth: { enabled: false },
      throttle: "default",
    });
  });

  it("auth: true and provider forms", () => {
    expect(ir(base + "http: { auth: true }\n").http?.auth).toEqual({
      enabled: true,
      provider: "cognito",
    });
    expect(ir(base + "http: { auth: { provider: google } }\n").http?.auth).toEqual({
      enabled: true,
      provider: "google",
    });
  });

  it("normalizes resources to sorted arrays with env-var-safe names", () => {
    const r = ir(base + "database: { sessions: {}, main: {} }\nstorage: { user-files: {} }\n");
    expect(r.databases).toEqual([{ name: "main" }, { name: "sessions" }]);
    expect(r.storages).toEqual([{ name: "user-files" }]);
  });

  it("defaults collections to empty", () => {
    const r = ir(base);
    expect(r.databases).toEqual([]);
    expect(r.storages).toEqual([]);
    expect(r.aiModels).toEqual([]);
    expect(r.secrets).toEqual([]);
  });

  it("defaults git: default branch is production/current, PRs on", () => {
    expect(ir(base).git).toEqual({
      production: { branch: "default", version: "current" },
      preview: null,
      pullRequests: true,
    });
  });

  it("normalizes explicit git config", () => {
    const r = ir(
      base +
        'git:\n  production: { branch: "release/*", version: branch }\n  preview: { branch: default }\n  pullRequests: false\n',
    );
    expect(r.git).toEqual({
      production: { branch: "release/*", version: "branch" },
      preview: { branch: "default" },
      pullRequests: false,
    });
  });

  it("git.production.version defaults to current", () => {
    const r = ir(base + 'git:\n  production: { branch: "release/*" }\n');
    expect(r.git.production).toEqual({ branch: "release/*", version: "current" });
  });

  it("git with only preview keeps production = default branch? no: production default", () => {
    const r = ir(base + "git:\n  preview: { branch: develop }\n");
    expect(r.git.production).toEqual({ branch: "default", version: "current" });
    expect(r.git.preview).toEqual({ branch: "develop" });
  });
});
