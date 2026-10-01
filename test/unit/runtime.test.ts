import { describe, expect, it } from "vitest";
import { bindings, identity, bindingEnvName } from "../../src/runtime/index.js";

describe("runtime bindings", () => {
  it("maps names to env var names", () => {
    expect(bindingEnvName("DATABASE", "main", "TABLE")).toBe("FLARELET_DATABASE_MAIN_TABLE");
    expect(bindingEnvName("AI", "nova-micro", "MODEL_ID")).toBe("FLARELET_AI_NOVA_MICRO_MODEL_ID");
  });

  it("reads database/storage/ai from env", () => {
    const env = {
      FLARELET_DATABASE_MAIN_TABLE: "t1",
      FLARELET_STORAGE_FILES_BUCKET: "b1",
      FLARELET_AI_NOVA_MICRO_MODEL_ID: "us.amazon.nova-micro-v1:0",
    };
    expect(bindings.database("main", env)).toEqual({ tableName: "t1" });
    expect(bindings.storage("files", env)).toEqual({ bucketName: "b1" });
    expect(bindings.ai("nova-micro", env)).toEqual({ modelId: "us.amazon.nova-micro-v1:0" });
  });

  it("throws a helpful error when a binding is missing", () => {
    expect(() => bindings.database("main", {})).toThrow(
      /database "main".*FLARELET_DATABASE_MAIN_TABLE/,
    );
  });

  it("extracts identity from x-flarelet headers (case-insensitive, plain object or Headers)", () => {
    const h = {
      "X-Flarelet-User-Sub": "abc",
      "x-flarelet-user-email": "a@example.com",
      "x-flarelet-auth-mode": "cognito",
    };
    expect(identity(h)).toEqual({
      sub: "abc",
      email: "a@example.com",
      emailVerified: false,
      authMode: "cognito",
    });
    expect(identity(new Headers({ "x-flarelet-user-sub": "z" }))).toEqual({
      sub: "z",
      email: undefined,
      emailVerified: false,
      authMode: undefined,
    });
  });

  it("returns null when there is no authenticated user", () => {
    expect(identity({})).toBeNull();
    expect(identity({ "x-flarelet-auth-mode": "cognito" })).toBeNull();
  });

  it("never trusts x-flarelet-* headers when the app is public (FLARELET_AUTH_ENABLED=false)", () => {
    // auth: false では front auth Lambda が無く、クライアントが送ったヘッダがそのまま届くため
    const forged = { "x-flarelet-user-sub": "admin", "x-flarelet-user-email": "admin@example.com" };
    expect(identity(forged, { FLARELET_AUTH_ENABLED: "false" })).toBeNull();
    expect(identity(forged, { FLARELET_AUTH_ENABLED: "true" })).toMatchObject({ sub: "admin" });
    expect(identity(forged, {})).toMatchObject({ sub: "admin" });
  });

  it("reads FLARELET_AUTH_ENABLED from process.env by default", () => {
    const prev = process.env.FLARELET_AUTH_ENABLED;
    process.env.FLARELET_AUTH_ENABLED = "false";
    try {
      expect(identity({ "x-flarelet-user-sub": "admin" })).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.FLARELET_AUTH_ENABLED;
      else process.env.FLARELET_AUTH_ENABLED = prev;
    }
  });
});

describe("identity(): email verification (F1)", () => {
  it("exposes emailVerified only when the front auth says the email is verified", () => {
    const base = { "x-flarelet-user-sub": "abc", "x-flarelet-user-email": "a@example.com" };
    expect(identity({ ...base, "x-flarelet-user-email-verified": "true" }, {})).toMatchObject({
      email: "a@example.com",
      emailVerified: true,
    });
    expect(identity({ ...base, "x-flarelet-user-email-verified": "false" }, {})).toMatchObject({
      emailVerified: false,
    });
    expect(identity({ ...base, "x-flarelet-user-email-verified": "TRUE " }, {})).toMatchObject({
      emailVerified: false,
    });
    expect(identity(base, {})).toMatchObject({ emailVerified: false });
  });
});

describe("identity(): flarelet dev secret (F2)", () => {
  const forged = {
    "x-flarelet-user-sub": "dev:admin@example.com",
    "x-flarelet-user-email": "admin@example.com",
  };
  const env = { FLARELET_AUTH_ENABLED: "true", FLARELET_DEV_SECRET: "s3cret-value" };

  it("under flarelet dev, ignores identity headers that did not come through the dev proxy", () => {
    // アプリに直接届いたリクエスト（プロキシを経由しない）には秘密ヘッダが無い
    expect(identity(forged, env)).toBeNull();
    expect(identity({ ...forged, "x-flarelet-dev-secret": "wrong" }, env)).toBeNull();
    expect(identity({ ...forged, "x-flarelet-dev-secret": "s3cret-valu" }, env)).toBeNull();
  });

  it("accepts identity headers that carry the per-session dev secret", () => {
    expect(identity({ ...forged, "x-flarelet-dev-secret": "s3cret-value" }, env)).toMatchObject({
      sub: "dev:admin@example.com",
    });
    expect(
      identity(new Headers({ ...forged, "x-flarelet-dev-secret": "s3cret-value" }), env),
    ).toMatchObject({ sub: "dev:admin@example.com" });
  });

  it("does not require the secret when FLARELET_DEV_SECRET is unset (Lambda)", () => {
    expect(identity(forged, { FLARELET_AUTH_ENABLED: "true" })).toMatchObject({
      sub: "dev:admin@example.com",
    });
  });
});
