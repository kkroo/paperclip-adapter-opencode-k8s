import { describe, it, expect } from "vitest";
import { createServerAdapter } from "./index.js";

describe("createServerAdapter", () => {
  it("declares the opencode_k8s type", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("opencode_k8s");
  });

  it("exposes a non-empty static models list so the UI renders before listModels resolves", () => {
    const adapter = createServerAdapter();
    expect(Array.isArray(adapter.models)).toBe(true);
    expect(adapter.models!.length).toBeGreaterThan(0);
    expect(adapter.models!.some((m) => m.id === "anthropic/claude-opus-5")).toBe(true);
    for (const m of adapter.models!) {
      expect(m.id).toMatch(/^[^/]+\/.+/);
      expect(m.label).toBe(m.id);
    }
  });

  it("exposes listModels for dynamic model discovery", () => {
    const adapter = createServerAdapter();
    expect(typeof adapter.listModels).toBe("function");
  });
});
