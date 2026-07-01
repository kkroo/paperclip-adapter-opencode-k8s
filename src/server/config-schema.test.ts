import { describe, it, expect } from "vitest";
import { getConfigSchema } from "./config-schema.js";

interface ConfigFieldSchema {
  key: string;
  label: string;
  type: string;
  default?: unknown;
  options?: { label: string; value: string }[];
  required?: boolean;
  group?: string;
}

describe("getConfigSchema", () => {
  it("returns a schema with expected field groups", () => {
    const schema = getConfigSchema();
    expect(schema.fields.length).toBeGreaterThan(0);

    const groups = schema.fields.map((f: ConfigFieldSchema) => f.group);
    const uniqueGroups = [...new Set(groups)];

    expect(uniqueGroups).toContain("Core");
    expect(uniqueGroups).toContain("Kubernetes");
  });

  it("does not include platform-provided fields", () => {
    const schema = getConfigSchema();
    const keys = schema.fields.map((f: ConfigFieldSchema) => f.key);
    // These fields are provided by the platform and should not be duplicated
    expect(keys).not.toContain("model");
    expect(keys).not.toContain("promptTemplate");
    expect(keys).not.toContain("env");
    expect(keys).not.toContain("extraArgs");
    expect(keys).not.toContain("timeoutSec");
    expect(keys).not.toContain("graceSec");
  });

  it("has imagePullPolicy as select with correct options", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "imagePullPolicy");
    expect(field).toBeDefined();
    expect(field!.type).toBe("select");
    expect(field!.options).toEqual([
      { label: "IfNotPresent", value: "IfNotPresent" },
      { label: "Always", value: "Always" },
      { label: "Never", value: "Never" },
    ]);
  });

  it("dangerouslySkipPermissions defaults to true", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "dangerouslySkipPermissions");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
    expect(field!.default).toBe(true);
  });

  it("ttlSecondsAfterFinished defaults to 300", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "ttlSecondsAfterFinished");
    expect(field).toBeDefined();
    expect(field!.type).toBe("number");
    expect(field!.default).toBe(300);
  });

  it("retainJobs is a toggle", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "retainJobs");
    expect(field).toBeDefined();
    expect(field!.type).toBe("toggle");
  });

  it("has all kubernetes resource fields", () => {
    const schema = getConfigSchema();
    const resourceKeys = [
      "resources.requests.cpu",
      "resources.requests.memory",
      "resources.limits.cpu",
      "resources.limits.memory",
    ];
    for (const key of resourceKeys) {
      const field = schema.fields.find((f: ConfigFieldSchema) => f.key === key);
      expect(field).toBeDefined();
      expect(field!.type).toBe("text");
    }
  });

  it("exposes compactThreshold as an optional number override", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "compactThreshold");
    expect(field).toBeDefined();
    expect(field!.type).toBe("number");
    expect(field!.group).toBe("Kubernetes");
    expect(field!.default).toBeUndefined();
  });

  it("has agentDbMode as select with workspace_subpath default and dedicated_pvc as explicit opt-in", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "agentDbMode");
    expect(field).toBeDefined();
    expect(field!.type).toBe("select");
    expect(field!.default).toBe("workspace_subpath");
    expect(field!.options).toContainEqual(expect.objectContaining({ value: "workspace_subpath" }));
    expect(field!.options).toContainEqual(expect.objectContaining({ value: "dedicated_pvc" }));
    expect(field!.options).toContainEqual(expect.objectContaining({ value: "ephemeral" }));
  });

  it("has agentDbStorageClass as text field with no default", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "agentDbStorageClass");
    expect(field).toBeDefined();
    expect(field!.type).toBe("text");
    expect(field!.default).toBeUndefined();
  });

  it("has agentDbStorageCapacity as text field defaulting to 1Gi", () => {
    const schema = getConfigSchema();
    const field = schema.fields.find((f: ConfigFieldSchema) => f.key === "agentDbStorageCapacity");
    expect(field).toBeDefined();
    expect(field!.type).toBe("text");
    expect(field!.default).toBe("1Gi");
  });

  it("does not include removed Option A fields", () => {
    const schema = getConfigSchema();
    const keys = schema.fields.map((f: ConfigFieldSchema) => f.key);
    expect(keys).not.toContain("opencodeDbMode");
    expect(keys).not.toContain("opencodeDbPath");
  });

  it("has nodeSelector and tolerations as textarea", () => {
    const schema = getConfigSchema();
    const nodeField = schema.fields.find((f: ConfigFieldSchema) => f.key === "nodeSelector");
    expect(nodeField).toBeDefined();
    expect(nodeField!.type).toBe("textarea");

    const tolField = schema.fields.find((f: ConfigFieldSchema) => f.key === "tolerations");
    expect(tolField).toBeDefined();
    expect(tolField!.type).toBe("textarea");
  });
});
