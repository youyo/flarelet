import { describe, expect, it } from "vitest";
import { buildPlan, renderPlan } from "../../src/planner/index.js";
import { parseConfig } from "../../src/config/index.js";
import { toIR } from "../../src/ir/index.js";

const ir = (yaml: string) => {
  const r = parseConfig(yaml);
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return toIR(r.config);
};

const full = ir(`version: 1
name: myapp
runtime: { language: python }
http: true
database: { main: {} }
storage: { files: {} }
ai: { models: [sonnet] }
secrets: [API_KEY]
`);

describe("plan", () => {
  it("lists everything as new when nothing exists", () => {
    const p = buildPlan(full, { stage: "prod", version: "v2", lifecycle: "persistent" });
    expect(p.changes).toBe(p.items.length);
    expect(renderPlan(p)).toBe(`Flarelet will create myapp (prod/v2)

  + application version v2
  + database.main
  + storage.files
  + authentication
  + ai.sonnet
  + secrets (API_KEY)

6 changes

Deploy with:
  flarelet deploy --stage prod --version v2
`);
  });

  it("marks existing items with = and counts only changes", () => {
    const p = buildPlan(
      full,
      { stage: "prod", version: "v2", lifecycle: "persistent" },
      new Set(["database.main", "storage.files", "authentication"]),
    );
    const out = renderPlan(p);
    expect(out).toContain("Flarelet will update myapp (prod/v2)");
    expect(out).toContain("  = database.main");
    expect(out).toContain("  + application version v2");
    expect(out).toContain("3 changes");
  });

  it("describes ephemeral previews", () => {
    const p = buildPlan(full, { stage: "preview", version: "pr-12", lifecycle: "ephemeral" });
    const out = renderPlan(p);
    expect(out).toContain("(preview/pr-12)");
    expect(out).toContain("ephemeral");
    expect(out).toContain("preview authentication");
  });

  it("forces preview authentication on ephemeral previews even with auth:false", () => {
    const open = ir(
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp: { auth: false }\n",
    );
    const out = renderPlan(
      buildPlan(open, { stage: "preview", version: "pr-3", lifecycle: "ephemeral" }),
    );
    expect(out).toContain("+ preview authentication (forced for pull request previews)");
    expect(out).not.toContain("public endpoint");
  });

  it("omits authentication for auth:false and http-less apps", () => {
    const open = ir(
      "version: 1\nname: myapp\nruntime: { language: python }\nhttp: { auth: false }\n",
    );
    expect(
      renderPlan(buildPlan(open, { stage: "prod", version: "current", lifecycle: "persistent" })),
    ).toContain("public endpoint (no authentication)");
  });
});

describe("plan against deployed state", () => {
  const d = { stage: "prod", version: "v2", lifecycle: "persistent" } as const;

  it("shows + / ~ / = / - in Flarelet terms", () => {
    const p = buildPlan(full, d, {
      existing: new Set(["application", "database.main", "storage.files", "authentication"]),
      changed: new Set(["application", "storage.files"]),
      removed: new Set(["database.legacy", "ai.nova-micro"]),
    });
    const out = renderPlan(p);
    expect(out).toContain("Flarelet will update myapp (prod/v2)");
    expect(out).toContain("  ~ application version v2");
    expect(out).toContain("  = database.main");
    expect(out).toContain("  ~ storage.files");
    expect(out).toContain("  = authentication");
    expect(out).toContain("  + ai.sonnet");
    expect(out).toContain("  - database.legacy");
    expect(out).toContain("  - ai.nova-micro");
    // ~ 2, + 2 (ai.sonnet, secrets), - 2
    expect(out).toContain("6 changes");
    expect(p.items.find((i) => i.key === "database.legacy")?.action).toBe("delete");
  });

  it("reports no changes when everything is up to date", () => {
    const keys = ["application", "database.main", "storage.files", "authentication"];
    const all = [...keys, "ai.sonnet", "secrets"];
    const p = buildPlan(full, d, { existing: new Set(all) });
    expect(p.changes).toBe(0);
    expect(renderPlan(p)).toContain("No changes");
  });
});
