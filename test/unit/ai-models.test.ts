import { describe, expect, it } from "vitest";
import {
  AI_MODEL_NAMES,
  isKnownModel,
  resolveModel,
  UnknownModelError,
} from "../../src/constructs/ai-models.js";

describe("ai model registry", () => {
  it("knows the logical names", () => {
    for (const n of ["sonnet", "haiku", "opus", "nova-micro", "nova-lite", "nova-pro"]) {
      expect(isKnownModel(n)).toBe(true);
      expect(AI_MODEL_NAMES).toContain(n);
    }
    expect(isKnownModel("gpt-9")).toBe(false);
  });

  it("resolves Claude models to global inference profiles in any region", () => {
    const m = resolveModel("sonnet", "ap-northeast-1");
    expect(m.profileId).toMatch(/^global\.anthropic\.claude-sonnet-/);
    expect(m.foundationModelId).toBe(m.profileId.replace(/^global\./, ""));
    expect(resolveModel("sonnet", "us-east-1").profileId).toBe(m.profileId);
  });

  it("resolves Nova models to the geo profile of the region", () => {
    expect(resolveModel("nova-micro", "us-west-2").profileId).toBe("us.amazon.nova-micro-v1:0");
    expect(resolveModel("nova-micro", "eu-central-1").profileId).toBe("eu.amazon.nova-micro-v1:0");
    expect(resolveModel("nova-pro", "ap-northeast-1").profileId).toBe("apac.amazon.nova-pro-v1:0");
    expect(resolveModel("nova-pro", "us-east-1").foundationModelId).toBe("amazon.nova-pro-v1:0");
  });

  it("resolves Nova micro/lite to apac profiles in Asia Pacific", () => {
    // aws bedrock list-inference-profiles --region ap-northeast-1（2026-10-01）で実在を確認
    expect(resolveModel("nova-micro", "ap-northeast-1").profileId).toBe(
      "apac.amazon.nova-micro-v1:0",
    );
    expect(resolveModel("nova-lite", "ap-northeast-1").profileId).toBe(
      "apac.amazon.nova-lite-v1:0",
    );
  });

  it("fails clearly when a geo profile is unavailable for the region", () => {
    expect(() => resolveModel("nova-micro", "sa-east-1")).toThrow(/nova-micro.*sa-east-1/);
  });

  it("rejects unknown names", () => {
    expect(() => resolveModel("nope", "us-east-1")).toThrow(UnknownModelError);
  });
});
