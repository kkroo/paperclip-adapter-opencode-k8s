import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AdapterSkillContext } from "@paperclipai/adapter-utils";

vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  readPaperclipRuntimeSkillEntries: vi.fn().mockResolvedValue([]),
  resolvePaperclipDesiredSkillNames: vi.fn().mockReturnValue([]),
  readInstalledSkillTargets: vi.fn().mockResolvedValue(new Map()),
}));

import { listOpenCodeSkills, syncOpenCodeSkills } from "./skills.js";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  readInstalledSkillTargets,
} from "@paperclipai/adapter-utils/server-utils";

const mockedReadEntries = vi.mocked(readPaperclipRuntimeSkillEntries);
const mockedResolveDesired = vi.mocked(resolvePaperclipDesiredSkillNames);
const mockedReadInstalled = vi.mocked(readInstalledSkillTargets);

const ctx: AdapterSkillContext = {
  agentId: "agent-1",
  companyId: "company-1",
  adapterType: "opencode_k8s",
  config: {},
};

describe("listOpenCodeSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadEntries.mockResolvedValue([]);
    mockedResolveDesired.mockReturnValue([]);
    mockedReadInstalled.mockResolvedValue(new Map());
  });

  it("returns empty snapshot when no skills available", async () => {
    const snapshot = await listOpenCodeSkills(ctx);
    expect(snapshot.adapterType).toBe("opencode_k8s");
    expect(snapshot.supported).toBe(true);
    expect(snapshot.mode).toBe("ephemeral");
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.warnings).toEqual([]);
  });

  it("marks desired available skills as configured", async () => {
    mockedReadEntries.mockResolvedValue([
      { key: "paperclip/skill-a", runtimeName: "skill-a", source: "/skills/skill-a", required: false } as never,
    ]);
    mockedResolveDesired.mockReturnValue(["paperclip/skill-a"]);

    const snapshot = await listOpenCodeSkills(ctx);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].state).toBe("configured");
    expect(snapshot.entries[0].desired).toBe(true);
    expect(snapshot.entries[0].origin).toBe("company_managed");
  });

  it("marks required skills with paperclip_required origin", async () => {
    mockedReadEntries.mockResolvedValue([
      { key: "paperclip/core", runtimeName: "core", source: "/skills/core", required: true, requiredReason: "Bundled" } as never,
    ]);
    mockedResolveDesired.mockReturnValue(["paperclip/core"]);

    const snapshot = await listOpenCodeSkills(ctx);
    expect(snapshot.entries[0].origin).toBe("paperclip_required");
    expect((snapshot.entries[0] as { required?: boolean }).required).toBe(true);
  });

  it("adds warning for desired skill not in available entries", async () => {
    mockedReadEntries.mockResolvedValue([]);
    mockedResolveDesired.mockReturnValue(["missing/skill"]);

    const snapshot = await listOpenCodeSkills(ctx);
    expect(snapshot.warnings).toHaveLength(1);
    expect(snapshot.warnings[0]).toContain("missing/skill");
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].state).toBe("missing");
  });

  it("lists external user-installed skills", async () => {
    mockedReadInstalled.mockResolvedValue(
      new Map([["user-skill", { targetPath: "/paperclip/.claude/skills/user-skill", kind: "directory" }]]),
    );

    const snapshot = await listOpenCodeSkills(ctx);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].state).toBe("external");
    expect(snapshot.entries[0].origin).toBe("user_installed");
    expect(snapshot.entries[0].managed).toBe(false);
  });

  it("does not duplicate externally installed skills that match available entries", async () => {
    mockedReadEntries.mockResolvedValue([
      { key: "paperclip/skill-a", runtimeName: "skill-a", source: "/skills/skill-a", required: false } as never,
    ]);
    mockedReadInstalled.mockResolvedValue(
      new Map([["skill-a", { targetPath: "/paperclip/.claude/skills/skill-a", kind: "directory" }]]),
    );

    const snapshot = await listOpenCodeSkills(ctx);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].key).toBe("paperclip/skill-a");
  });

  it("sorts entries alphabetically by key", async () => {
    mockedReadEntries.mockResolvedValue([
      { key: "paperclip/zebra", runtimeName: "zebra", source: "/skills/zebra", required: false } as never,
      { key: "paperclip/alpha", runtimeName: "alpha", source: "/skills/alpha", required: false } as never,
    ]);

    const snapshot = await listOpenCodeSkills(ctx);
    expect(snapshot.entries[0].key).toBe("paperclip/alpha");
    expect(snapshot.entries[1].key).toBe("paperclip/zebra");
  });
});

describe("syncOpenCodeSkills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedReadEntries.mockResolvedValue([]);
    mockedResolveDesired.mockReturnValue([]);
    mockedReadInstalled.mockResolvedValue(new Map());
  });

  it("returns same snapshot as listOpenCodeSkills (ephemeral pass-through)", async () => {
    mockedReadEntries.mockResolvedValue([
      { key: "paperclip/skill-a", runtimeName: "skill-a", source: "/skills/skill-a", required: false } as never,
    ]);
    mockedResolveDesired.mockReturnValue(["paperclip/skill-a"]);

    const listResult = await listOpenCodeSkills(ctx);
    vi.clearAllMocks();
    mockedReadEntries.mockResolvedValue([
      { key: "paperclip/skill-a", runtimeName: "skill-a", source: "/skills/skill-a", required: false } as never,
    ]);
    mockedResolveDesired.mockReturnValue(["paperclip/skill-a"]);
    mockedReadInstalled.mockResolvedValue(new Map());

    const syncResult = await syncOpenCodeSkills(ctx, ["paperclip/skill-a"]);
    expect(syncResult).toEqual(listResult);
  });
});
