import { describe, expect, it } from "vitest";
import { parseConfig, formatIssues } from "../../src/config/index.js";

const ok = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(formatIssues(r.issues));
  return r.config;
};
const fail = (yaml: string) => {
  const r = parseConfig(yaml);
  if (r.ok) throw new Error("expected failure");
  return r.issues;
};

const full = `
version: 1
name: myapp
runtime:
  language: python
  version: "3.13"
http:
  auth: true
database:
  main: {}
storage:
  files: {}
ai:
  models:
    - sonnet
secrets:
  - EXTERNAL_API_KEY
git:
  production:
    branch: "release/*"
    version: branch
  preview:
    branch: default
  pullRequests: true
`;

describe("parseConfig: valid", () => {
  it("accepts the full representative config from the spec", () => {
    const c = ok(full);
    expect(c.name).toBe("myapp");
    expect(c.runtime).toEqual({ language: "python", version: "3.13" });
    expect(c.git?.production).toEqual({ branch: "release/*", version: "branch" });
    expect(c.secrets).toEqual(["EXTERNAL_API_KEY"]);
  });

  it("accepts the minimal config", () => {
    const c = ok("version: 1\nname: myapp\nruntime:\n  language: typescript\n");
    expect(c.http).toBeUndefined();
  });

  it.each([
    "true",
    "false",
    "{ auth: false }",
    "{ auth: true }",
    "{ auth: { provider: google } }",
    "{ auth: { provider: oidc } }",
  ])("accepts http: %s", (http) => {
    expect(() =>
      ok(`version: 1\nname: myapp\nruntime: { language: typescript }\nhttp: ${http}\n`),
    ).not.toThrow();
  });

  it("treats null resource bodies (`main:`) as {}", () => {
    const c = ok(
      "version: 1\nname: myapp\nruntime: { language: typescript }\ndatabase:\n  main:\n",
    );
    expect(c.database).toEqual({ main: {} });
  });
});

describe("parseConfig: errors carry paths", () => {
  it("reports invalid YAML syntax", () => {
    const issues = fail("version: 1\nname: [unclosed\n");
    expect(issues[0]?.message).toMatch(/YAML/i);
  });

  it("reports missing required keys with the path", () => {
    const issues = fail("version: 1\nruntime: { language: python }\n");
    expect(issues).toContainEqual(expect.objectContaining({ path: "name" }));
  });

  it("rejects wrong version", () => {
    expect(fail("version: 2\nname: myapp\nruntime: { language: python }\n")[0]?.path).toBe(
      "version",
    );
  });

  it("rejects unknown language with nested path", () => {
    const issues = fail("version: 1\nname: myapp\nruntime: { language: ruby }\n");
    expect(issues[0]?.path).toBe("runtime.language");
    expect(issues[0]?.message).toMatch(/python|typescript/);
  });

  it("rejects unknown top-level keys (no AWS resource names)", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\nlambda: {}\ndynamodb: {}\n",
    );
    expect(issues.map((i) => i.message).join("\n")).toMatch(/lambda/);
  });

  it("rejects unknown provider with path", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp:\n  auth:\n    provider: github\n",
    );
    expect(issues[0]?.path).toBe("http.auth.provider");
  });

  it("rejects numeric runtime.version with a quoting hint", () => {
    const issues = fail("version: 1\nname: myapp\nruntime:\n  language: python\n  version: 3.13\n");
    expect(issues[0]?.path).toBe("runtime.version");
    expect(issues[0]?.message).toMatch(/quote/i);
  });

  it("rejects non-empty resource bodies", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\ndatabase:\n  main:\n    tableName: foo\n",
    );
    expect(issues[0]?.path).toBe("database.main");
  });

  it("rejects secrets that are not env-var style or use reserved prefixes", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\nsecrets: [bad-name, FLAREON_X, AWS_Y]\n",
    );
    expect(issues.map((i) => i.path)).toEqual(["secrets.0", "secrets.1", "secrets.2"]);
  });

  it("rejects duplicate secrets and models", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\nsecrets: [A, A]\nai: { models: [sonnet, sonnet] }\n",
    );
    expect(issues.map((i) => i.path).sort()).toEqual(["ai.models", "secrets"]);
  });

  it("rejects AI model names that are not in the registry", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\nai: { models: [sonnet, gpt-9] }\n",
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.path).toBe("ai.models.1");
    expect(issues[0]?.message).toContain("unknown AI model");
    expect(issues[0]?.message).toContain("nova-micro");
  });

  it("requires git.production.branch", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\ngit:\n  production:\n    version: branch\n",
    );
    expect(issues[0]?.path).toBe("git.production.branch");
  });

  it("reports multiple issues at once", () => {
    expect(fail("version: 3\nname: BAD\nruntime: { language: x }\n").length).toBeGreaterThanOrEqual(
      3,
    );
  });
});

describe("name and resource name validation", () => {
  const withName = (n: string) => `version: 1\nname: ${n}\nruntime: { language: python }\n`;
  it.each(["myapp", "my-app-2", "a1"])("accepts app name %s", (n) => {
    expect(() => ok(withName(n))).not.toThrow();
  });
  it.each([
    "MyApp",
    "my_app",
    "-app",
    "app-",
    "my--app",
    "1app",
    "a",
    "x".repeat(25),
    "my.app",
    "アプリ",
  ])("rejects app name %s", (n) => {
    expect(fail(withName(n))[0]?.path).toBe("name");
  });
  it("rejects bad resource names", () => {
    const issues = fail(
      "version: 1\nname: myapp\nruntime: { language: python }\nstorage:\n  Bad_Name: {}\n",
    );
    expect(issues[0]?.path).toBe("storage.Bad_Name");
  });
  it("accepts hyphenated resource names", () => {
    expect(
      ok("version: 1\nname: myapp\nruntime: { language: python }\nstorage:\n  user-files: {}\n")
        .storage,
    ).toEqual({ "user-files": {} });
  });
});
