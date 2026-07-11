import { describe, it, expect } from "vitest";
import { computeOpenAICompatibleCost, OPENAI_PRICING_USD_PER_MTOK } from "./pricing.js";

describe("computeOpenAICompatibleCost", () => {
  it("returns a positive cost for gpt-5.6-sol with non-zero usage", () => {
    const cost = computeOpenAICompatibleCost("openai/gpt-5.6-sol", {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 5_000,
    });
    // 100k input @ $5/M + 5k output @ $30/M = $0.50 + $0.15 = $0.65
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.65, 4);
  });

  it("returns a positive cost for a known model with non-zero usage", () => {
    const cost = computeOpenAICompatibleCost("openai/gpt-5.5", {
      inputTokens: 100_000,
      cachedInputTokens: 0,
      outputTokens: 5_000,
    });
    // 100k input @ $3/M + 5k output @ $12/M = $0.30 + $0.06 = $0.36
    expect(cost).not.toBeNull();
    expect(cost).toBeCloseTo(0.36, 4);
  });

  it("returns null for an unknown model so the caller falls back to $0", () => {
    const cost = computeOpenAICompatibleCost("openai/unknown-model", {
      inputTokens: 1000,
      cachedInputTokens: 0,
      outputTokens: 100,
    });
    expect(cost).toBeNull();
  });

  it("returns null when total usage is zero", () => {
    const cost = computeOpenAICompatibleCost("openai/gpt-5.5", {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });
    expect(cost).toBeNull();
  });

  it("returns null when model is null", () => {
    const cost = computeOpenAICompatibleCost(null, {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 50,
    });
    expect(cost).toBeNull();
  });

  it("matches Ally-sized run within plausible range", () => {
    // From the BLO-7436 issue body, a real Ally run on gpt-5.5:
    // 138336 input + 1400320 cached + 5226 output
    const cost = computeOpenAICompatibleCost("openai/gpt-5.5", {
      inputTokens: 138_336,
      cachedInputTokens: 1_400_320,
      outputTokens: 5_226,
    });
    // input: 138336 * 3 / 1e6 = 0.415
    // cached: 1400320 * 0.3 / 1e6 = 0.420
    // output: 5226 * 12 / 1e6 = 0.063
    // total ~= $0.898
    expect(cost).not.toBeNull();
    expect(cost).toBeGreaterThan(0.8);
    expect(cost).toBeLessThan(1.0);
  });

  it("sanity-checks every priced model has positive rates", () => {
    for (const [model, rate] of Object.entries(OPENAI_PRICING_USD_PER_MTOK)) {
      expect(rate.input, `${model} input rate`).toBeGreaterThan(0);
      expect(rate.output, `${model} output rate`).toBeGreaterThan(0);
      // cachedInput can in principle be zero on some providers, but we don't
      // expect that for OpenAI today — flag if it ever drops.
      expect(rate.cachedInput, `${model} cachedInput rate`).toBeGreaterThan(0);
    }
  });
});
