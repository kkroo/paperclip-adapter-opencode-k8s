import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
  AdapterSkillEntry,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
  readInstalledSkillTargets,
} from "@paperclipai/adapter-utils/server-utils";
import path from "node:path";

const SKILLS_HOME = "/paperclip/.claude/skills";

/**
 * Forward-compat view of the skill contract: the host marks bundled-core
 * skills as required ("Required by Paperclip") and renders the
 * `paperclip_required` origin plus `required`/`requiredReason` on snapshot
 * entries, but the published adapter-utils types do not declare any of it
 * yet. Read the input flag and emit the output fields defensively so the
 * adapter tracks the host feature without pinning an unpublished library.
 */
type RequiredAwareSkillEntry = {
  required?: boolean;
  requiredReason?: string | null;
};

type RequiredAwareAdapterSkillEntry = Omit<AdapterSkillEntry, "origin"> & {
  origin?: AdapterSkillEntry["origin"] | "paperclip_required";
  required?: boolean;
  requiredReason?: string | null;
};

function skillEntryRequired(entry: unknown): RequiredAwareSkillEntry {
  return (entry ?? {}) as RequiredAwareSkillEntry;
}

async function buildOpenCodeSkillSnapshot(
  config: Record<string, unknown>,
): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, import.meta.dirname ?? __dirname);
  const availableByKey = new Map(availableEntries.map((e) => [e.key, e]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const installed = await readInstalledSkillTargets(SKILLS_HOME);

  const entries: RequiredAwareAdapterSkillEntry[] = availableEntries.map((entry) => {
    const { required, requiredReason } = skillEntryRequired(entry);
    return {
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired: desiredSet.has(entry.key),
      managed: true,
      state: desiredSet.has(entry.key) ? "configured" : "available",
      origin: required ? "paperclip_required" : "company_managed",
      originLabel: required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desiredSet.has(entry.key)
        ? "Injected via prompt bundle into ephemeral K8s Job pods."
        : null,
      required: Boolean(required),
      requiredReason: requiredReason ?? null,
    };
  });

  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill in the runtime skills directory.",
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((e) => e.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: "~/.claude/skills",
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(SKILLS_HOME, name),
      detail: "Installed outside Paperclip management in the Claude skills home.",
    });
  }

  entries.sort((a, b) => a.key.localeCompare(b.key));

  return {
    adapterType: "opencode_k8s",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    // Additive forward-compat fields (required/requiredReason, the
    // paperclip_required origin) ride through until the published
    // AdapterSkillEntry type declares them.
    entries: entries as AdapterSkillEntry[],
    warnings,
  };
}

export async function listOpenCodeSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config);
}

export async function syncOpenCodeSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildOpenCodeSkillSnapshot(ctx.config);
}
