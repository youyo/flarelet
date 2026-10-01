import { describe, expect, it } from "vitest";
import { formatIssues, idpSecretNames, parseConfig } from "../../src/config/index.js";
import { toIR } from "../../src/ir/index.js";

const base = "version: 1\nname: myapp\nruntime: { language: python }\n";

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

describe("http.auth.provider: google", () => {
  it("is accepted and normalized in the IR", () => {
    const c = ok(base + "http:\n  auth:\n    provider: google\n");
    expect(toIR(c).http?.auth).toEqual({ enabled: true, provider: "google" });
  });

  it("rejects OIDC-only settings", () => {
    const issues = fail(
      base + "http:\n  auth:\n    provider: google\n    issuer: https://example.com\n",
    );
    expect(issues[0]?.path).toBe("http.auth.issuer");
    expect(issues[0]?.message).toMatch(/only.*oidc/);
  });

  it("reserves its credential names: they must not be declared under secrets", () => {
    const issues = fail(
      base + "http:\n  auth:\n    provider: google\nsecrets: [API_KEY, GOOGLE_CLIENT_SECRET]\n",
    );
    expect(issues[0]?.path).toBe("secrets");
    expect(issues[0]?.message).toMatch(/GOOGLE_CLIENT_SECRET.*provider: google/);
  });

  it("leaves those names free when the provider is not google", () => {
    expect(() => ok(base + "http: true\nsecrets: [GOOGLE_CLIENT_SECRET]\n")).not.toThrow();
  });
});

describe("http.auth.provider: oidc", () => {
  it("requires the issuer", () => {
    const issues = fail(base + "http:\n  auth:\n    provider: oidc\n");
    expect(issues[0]?.path).toBe("http.auth.issuer");
    expect(issues[0]?.message).toMatch(/required/);
  });

  it("requires an https issuer URL", () => {
    const issues = fail(
      base + "http:\n  auth:\n    provider: oidc\n    issuer: http://idp.example.com\n",
    );
    expect(issues[0]?.path).toBe("http.auth.issuer");
    expect(issues[0]?.message).toMatch(/https/);
  });

  it("normalizes defaults (scopes, display name) in the IR", () => {
    const c = ok(
      base + "http:\n  auth:\n    provider: oidc\n    issuer: https://idp.example.com/\n",
    );
    expect(toIR(c).http?.auth).toEqual({
      enabled: true,
      provider: "oidc",
      oidc: {
        issuer: "https://idp.example.com/",
        scopes: ["openid", "email", "profile"],
        name: "OIDC",
      },
    });
  });

  it("accepts custom scopes and name", () => {
    const c = ok(
      base +
        "http:\n  auth:\n    provider: oidc\n    issuer: https://idp.example.com\n    scopes: [openid, email]\n    name: Okta\n",
    );
    expect(toIR(c).http?.auth).toMatchObject({
      oidc: { scopes: ["openid", "email"], name: "Okta" },
    });
  });

  it("requires the openid scope", () => {
    const issues = fail(
      base +
        "http:\n  auth:\n    provider: oidc\n    issuer: https://idp.example.com\n    scopes: [email]\n",
    );
    expect(issues[0]?.path).toBe("http.auth.scopes");
    expect(issues[0]?.message).toMatch(/openid/);
  });

  it("rejects reserved or invalid display names", () => {
    for (const name of ["Google", "COGNITO", "has:colon", "x".repeat(33)]) {
      const issues = fail(
        base +
          `http:\n  auth:\n    provider: oidc\n    issuer: https://idp.example.com\n    name: "${name}"\n`,
      );
      expect(issues[0]?.path, name).toBe("http.auth.name");
    }
  });

  it("reserves OIDC_CLIENT_ID / OIDC_CLIENT_SECRET", () => {
    const issues = fail(
      base +
        "http:\n  auth:\n    provider: oidc\n    issuer: https://idp.example.com\nsecrets: [OIDC_CLIENT_ID]\n",
    );
    expect(issues[0]?.path).toBe("secrets");
  });
});

describe("unsupported providers", () => {
  it("saml fails with a clear v0 message", () => {
    const issues = fail(base + `http:\n  auth:\n    provider: saml\n`);
    expect(issues[0]?.path).toBe("http.auth.provider");
    expect(issues[0]?.message).toMatch(/not supported in v0/);
    expect(issues[0]?.message).toMatch(/google, oidc, entra/);
  });
});

const TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";

describe("http.auth.provider: entra", () => {
  it("is accepted with a tenant ID and normalized in the IR", () => {
    const c = ok(
      base + `http:\n  auth:\n    provider: entra\n    tenant: ${TENANT.toUpperCase()}\n`,
    );
    expect(toIR(c).http?.auth).toEqual({
      enabled: true,
      provider: "entra",
      entra: { tenant: TENANT },
    });
  });

  it("requires the tenant", () => {
    const issues = fail(base + "http:\n  auth:\n    provider: entra\n");
    expect(issues[0]?.path).toBe("http.auth.tenant");
    expect(issues[0]?.message).toMatch(/required/);
  });

  it.each(["common", "organizations", "consumers", "9188040d-6c67-4c5b-b112-36a304b66dad"])(
    "rejects the multi-tenant / personal-account tenant %s",
    (t) => {
      const issues = fail(base + `http:\n  auth:\n    provider: entra\n    tenant: ${t}\n`);
      expect(issues[0]?.path).toBe("http.auth.tenant");
      expect(issues[0]?.message).toMatch(/single|multi|personal/i);
    },
  );

  it("requires the tenant ID (GUID), not a domain name", () => {
    const issues = fail(
      base + "http:\n  auth:\n    provider: entra\n    tenant: contoso.onmicrosoft.com\n",
    );
    expect(issues[0]?.path).toBe("http.auth.tenant");
    expect(issues[0]?.message).toMatch(/Directory \(tenant\) ID/);
  });

  it("tenant only applies to entra; issuer/scopes/name do not apply to entra", () => {
    expect(
      fail(base + `http:\n  auth:\n    provider: google\n    tenant: ${TENANT}\n`)[0]?.path,
    ).toBe("http.auth.tenant");
    expect(
      fail(
        base +
          `http:\n  auth:\n    provider: entra\n    tenant: ${TENANT}\n    issuer: https://x.example.com\n`,
      )[0]?.path,
    ).toBe("http.auth.issuer");
  });

  it("reserves ENTRA_CLIENT_ID / ENTRA_CLIENT_SECRET", () => {
    const issues = fail(
      base +
        `http:\n  auth:\n    provider: entra\n    tenant: ${TENANT}\nsecrets: [ENTRA_CLIENT_SECRET]\n`,
    );
    expect(issues[0]?.path).toBe("secrets");
  });
});

describe("http.auth.allow", () => {
  it("is optional and normalized (lowercase) in the IR for every provider", () => {
    const c = ok(
      base +
        "http:\n  auth:\n    provider: google\n    allow:\n      domains: [Example.com]\n      emails: [Alice@Gmail.com]\n",
    );
    expect(toIR(c).http?.auth).toEqual({
      enabled: true,
      provider: "google",
      allow: { domains: ["example.com"], emails: ["alice@gmail.com"] },
    });
    const cognito = ok(base + "http:\n  auth:\n    allow: { emails: [a@example.com] }\n");
    expect(toIR(cognito).http?.auth).toEqual({
      enabled: true,
      provider: "cognito",
      allow: { domains: [], emails: ["a@example.com"] },
    });
    expect(toIR(ok(base + "http:\n  auth:\n    provider: google\n")).http?.auth).not.toHaveProperty(
      "allow",
    );
  });

  it("rejects an empty allow (it would silently allow everyone)", () => {
    expect(fail(base + "http:\n  auth:\n    allow: {}\n")[0]?.path).toBe("http.auth.allow");
    expect(fail(base + "http:\n  auth:\n    allow: { domains: [], emails: [] }\n")[0]?.path).toBe(
      "http.auth.allow",
    );
  });

  it("validates domains and emails", () => {
    expect(fail(base + 'http:\n  auth:\n    allow: { domains: ["@example.com"] }\n')[0]?.path).toBe(
      "http.auth.allow.domains.0",
    );
    expect(
      fail(base + 'http:\n  auth:\n    allow: { domains: ["*.example.com"] }\n')[0]?.path,
    ).toBe("http.auth.allow.domains.0");
    expect(fail(base + "http:\n  auth:\n    allow: { emails: [nope] }\n")[0]?.path).toBe(
      "http.auth.allow.emails.0",
    );
    expect(fail(base + 'http:\n  auth:\n    allow: { emails: ["a,b@x.com"] }\n')[0]?.path).toBe(
      "http.auth.allow.emails.0",
    );
    expect(fail(base + "http:\n  auth:\n    allow: { users: [a] }\n")[0]?.path).toMatch(
      /http\.auth\.allow/,
    );
  });

  it("limits the total size (it is passed to the front Lambda as environment variables)", () => {
    const many = Array.from({ length: 200 }, (_, i) => `user${i}@example.com`).join(", ");
    expect(fail(base + `http:\n  auth:\n    allow: { emails: [${many}] }\n`)[0]?.path).toBe(
      "http.auth.allow",
    );
  });

  it("auth: false still validates without allow", () => {
    expect(() => ok(base + "http:\n  auth: false\n")).not.toThrow();
  });
});

describe("idpSecretNames", () => {
  it("returns the credential secret names per provider", () => {
    expect(idpSecretNames("google")).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]);
    expect(idpSecretNames("oidc")).toEqual(["OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"]);
    expect(idpSecretNames("entra")).toEqual(["ENTRA_CLIENT_ID", "ENTRA_CLIENT_SECRET"]);
    expect(idpSecretNames("cognito")).toEqual([]);
  });
});
