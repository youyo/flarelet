// http.auth.allow の判定（front auth Lambda が id_token 検証後に行う）。
import { describe, expect, it } from "vitest";
import { isAllowed, policyFingerprint } from "../../src/auth/allow.js";
import { COGNITO_ENV } from "./auth-fixtures.js";
import { parseAuthConfig } from "../../src/auth/config.js";

const domains = (...d: string[]) => ({ domains: d, emails: [] });
const emails = (...e: string[]) => ({ domains: [], emails: e });

describe("isAllowed", () => {
  it("allows everyone the IdP authenticated when no policy is set", () => {
    expect(isAllowed({ email: "x@any.com" }, "google", undefined)).toBe(true);
  });

  describe("google", () => {
    it("domains require the Workspace hosted domain (hd), not just the email domain", () => {
      const p = domains("example.com");
      expect(
        isAllowed(
          { email: "a@example.com", email_verified: true, "custom:hd": "example.com" },
          "google",
          p,
        ),
      ).toBe(true);
      // 会社ドメインの email で作った個人 Google アカウント（hd なし）は弾く
      expect(isAllowed({ email: "a@example.com", email_verified: true }, "google", p)).toBe(false);
      expect(
        isAllowed(
          { email: "a@example.com", email_verified: true, "custom:hd": "other.com" },
          "google",
          p,
        ),
      ).toBe(false);
      expect(isAllowed({ email: "a@other.com", "custom:hd": "EXAMPLE.com" }, "google", p)).toBe(
        true,
      );
    });
    it("emails match exactly (case-insensitive) and need email_verified", () => {
      const p = emails("alice@gmail.com");
      expect(isAllowed({ email: "Alice@gmail.com", email_verified: true }, "google", p)).toBe(true);
      expect(isAllowed({ email: "alice@gmail.com", email_verified: "true" }, "google", p)).toBe(
        true,
      );
      expect(isAllowed({ email: "alice@gmail.com", email_verified: false }, "google", p)).toBe(
        false,
      );
      expect(isAllowed({ email: "alice@gmail.com" }, "google", p)).toBe(false);
      expect(isAllowed({ email: "bob@gmail.com", email_verified: true }, "google", p)).toBe(false);
    });
    it("either list may grant access", () => {
      const p = { domains: ["example.com"], emails: ["alice@gmail.com"] };
      expect(isAllowed({ email: "alice@gmail.com", email_verified: true }, "google", p)).toBe(true);
      expect(
        isAllowed(
          { email: "b@x.com", email_verified: true, "custom:hd": "example.com" },
          "google",
          p,
        ),
      ).toBe(true);
    });
  });

  describe.each(["cognito", "oidc"] as const)("%s", (provider) => {
    it("checks the verified email's domain and exact address", () => {
      expect(
        isAllowed(
          { email: "a@Example.com", email_verified: true },
          provider,
          domains("example.com"),
        ),
      ).toBe(true);
      expect(
        isAllowed(
          { email: "a@example.com", email_verified: false },
          provider,
          domains("example.com"),
        ),
      ).toBe(false);
      expect(isAllowed({ email: "a@example.com" }, provider, domains("example.com"))).toBe(false);
      // サブドメインや末尾一致では通さない
      expect(
        isAllowed(
          { email: "a@evil-example.com", email_verified: true },
          provider,
          domains("example.com"),
        ),
      ).toBe(false);
      expect(
        isAllowed(
          { email: "a@sub.example.com", email_verified: true },
          provider,
          domains("example.com"),
        ),
      ).toBe(false);
      expect(
        isAllowed(
          { email: "a@example.com", email_verified: true },
          provider,
          emails("a@example.com"),
        ),
      ).toBe(true);
      expect(
        isAllowed(
          { email: "b@example.com", email_verified: true },
          provider,
          emails("a@example.com"),
        ),
      ).toBe(false);
      expect(isAllowed({ email_verified: true }, provider, domains("example.com"))).toBe(false);
    });
  });

  describe("entra", () => {
    it("uses email without email_verified (Entra does not send it)", () => {
      expect(isAllowed({ email: "a@contoso.com" }, "entra", domains("contoso.com"))).toBe(true);
      expect(isAllowed({ email: "a@fabrikam.com" }, "entra", domains("contoso.com"))).toBe(false);
      expect(isAllowed({ email: "A@contoso.com" }, "entra", emails("a@contoso.com"))).toBe(true);
    });
    it("falls back to preferred_username when email is missing", () => {
      expect(
        isAllowed({ preferred_username: "a@contoso.com" }, "entra", domains("contoso.com")),
      ).toBe(true);
      expect(isAllowed({}, "entra", domains("contoso.com"))).toBe(false);
    });
  });
});

describe("policyFingerprint", () => {
  it("is undefined without a policy and changes when the policy changes", () => {
    expect(policyFingerprint("google", undefined)).toBeUndefined();
    const a = policyFingerprint("google", domains("example.com"));
    expect(a).toEqual(policyFingerprint("google", domains("example.com")));
    expect(a).not.toEqual(policyFingerprint("google", domains("example.org")));
    expect(a).not.toEqual(policyFingerprint("oidc", domains("example.com")));
  });
});

describe("parseAuthConfig (allow)", () => {
  it("reads the provider and allow lists", () => {
    const c = parseAuthConfig({
      ...COGNITO_ENV,
      FLARELET_AUTH_PROVIDER: "google",
      FLARELET_AUTH_ALLOW_DOMAINS: "example.com,example.org",
      FLARELET_AUTH_ALLOW_EMAILS: "a@gmail.com",
    });
    expect(c.mode === "cognito" && c.cognito.provider).toBe("google");
    expect(c.mode === "cognito" && c.cognito.allow).toEqual({
      domains: ["example.com", "example.org"],
      emails: ["a@gmail.com"],
    });
  });
  it("defaults to the built-in provider and no policy", () => {
    const c = parseAuthConfig(COGNITO_ENV);
    expect(c.mode === "cognito" && c.cognito.provider).toBe("cognito");
    expect(c.mode === "cognito" && c.cognito.allow).toBeUndefined();
  });
  it("rejects unknown providers", () => {
    expect(() => parseAuthConfig({ ...COGNITO_ENV, FLARELET_AUTH_PROVIDER: "saml" })).toThrow(
      /FLARELET_AUTH_PROVIDER/,
    );
  });
});
