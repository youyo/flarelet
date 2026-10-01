import { describe, expect, it } from "vitest";
import { bindings, identity, bindingEnvName } from "../../src/runtime/index.js";

describe("runtime bindings", () => {
  it("maps names to env var names", () => {
    expect(bindingEnvName("DATABASE", "main", "TABLE")).toBe("FLAREON_DATABASE_MAIN_TABLE");
    expect(bindingEnvName("AI", "nova-micro", "MODEL_ID")).toBe("FLAREON_AI_NOVA_MICRO_MODEL_ID");
  });

  it("reads database/storage/ai from env", () => {
    const env = {
      FLAREON_DATABASE_MAIN_TABLE: "t1",
      FLAREON_STORAGE_FILES_BUCKET: "b1",
      FLAREON_AI_NOVA_MICRO_MODEL_ID: "us.amazon.nova-micro-v1:0",
    };
    expect(bindings.database("main", env)).toEqual({ tableName: "t1" });
    expect(bindings.storage("files", env)).toEqual({ bucketName: "b1" });
    expect(bindings.ai("nova-micro", env)).toEqual({ modelId: "us.amazon.nova-micro-v1:0" });
  });

  it("throws a helpful error when a binding is missing", () => {
    expect(() => bindings.database("main", {})).toThrow(
      /database "main".*FLAREON_DATABASE_MAIN_TABLE/,
    );
  });

  it("extracts identity from x-flareon headers (case-insensitive, plain object or Headers)", () => {
    const h = {
      "X-Flareon-User-Sub": "abc",
      "x-flareon-user-email": "a@example.com",
      "x-flareon-auth-mode": "cognito",
    };
    expect(identity(h)).toEqual({ sub: "abc", email: "a@example.com", authMode: "cognito" });
    expect(identity(new Headers({ "x-flareon-user-sub": "z" }))).toEqual({
      sub: "z",
      email: undefined,
      authMode: undefined,
    });
  });

  it("returns null when there is no authenticated user", () => {
    expect(identity({})).toBeNull();
    expect(identity({ "x-flareon-auth-mode": "cognito" })).toBeNull();
  });
});
