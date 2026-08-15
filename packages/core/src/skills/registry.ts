import type {
  AgentSkill,
  SkillPackage,
  SkillRegistry,
  SkillResolutionInput,
  SkillResolutionResult,
} from "./types.js";

export interface CreateSkillRegistryOptions {
  readonly skills?: ReadonlyArray<AgentSkill>;
  readonly packages?: ReadonlyArray<SkillPackage>;
}

export function createSkillRegistry(options: CreateSkillRegistryOptions = {}): SkillRegistry {
  const skills = dedupeSkills(options.skills ?? []);
  const packages = dedupePackages(options.packages ?? [], skills);
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const packagesById = new Map(packages.map((pkg) => [pkg.id, pkg]));

  return {
    listSkills() {
      return skills;
    },
    listPackages() {
      return packages;
    },
    getSkill(id) {
      return byId.get(normalizeSkillId(id));
    },
    getPackage(id) {
      return packagesById.get(normalizeSkillId(id));
    },
    resolveSkills(input: SkillResolutionInput) {
      const disabled = new Set(normalizeIdList(input.disabledSkills));
      const requested = normalizeIdList(input.requestedSkills);
      const missingSkillIds: string[] = [];
      const disabledSkillIds = [...disabled].filter((id) => byId.has(id));
      const used = new Map<string, AgentSkill>();
      const forcedSkillIds: string[] = [];

      const expand = (id: string): string[] => {
        const skill = byId.get(id);
        if (skill) return [id];
        const pkg = packagesById.get(id);
        if (pkg) return pkg.skillIds;
        return [];
      };

      for (const id of requested) {
        const expanded = expand(id);
        if (expanded.length === 0) {
          // 仍然记录为缺失：区分是请求包 id 还是裸 skill id
          missingSkillIds.push(id);
          continue;
        }
        for (const childId of expanded) {
          if (disabled.has(childId)) continue;
          const skill = byId.get(childId);
          if (!skill) continue;
          if (!used.has(childId)) {
            used.set(childId, skill);
            forcedSkillIds.push(childId);
          }
        }
      }

      const availableSkills = skills.filter((skill) => !disabled.has(skill.id));

      return {
        usedSkills: [...used.values()],
        forcedSkillIds,
        missingSkillIds: dedupeStrings(missingSkillIds),
        disabledSkillIds,
        availableSkills,
        availableSkillIds: availableSkills.map((skill) => skill.id),
      } satisfies SkillResolutionResult;
    },
  };
}

function dedupeSkills(skills: ReadonlyArray<AgentSkill>): AgentSkill[] {
  const byId = new Map<string, AgentSkill>();
  for (const skill of skills) {
    byId.set(normalizeSkillId(skill.id), {
      ...skill,
      id: normalizeSkillId(skill.id),
    });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function dedupePackages(
  packages: ReadonlyArray<SkillPackage>,
  skills: ReadonlyArray<AgentSkill>,
): SkillPackage[] {
  const existingSkillIds = new Set(skills.map((skill) => skill.id));
  const byId = new Map<string, SkillPackage>();
  for (const pkg of packages) {
    const id = normalizeSkillId(pkg.id);
    const skillIds = dedupeStrings(
      pkg.skillIds
        .map(normalizeSkillId)
        .filter((skillId) => existingSkillIds.has(skillId)),
    );
    byId.set(id, { ...pkg, id, skillIds });
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeIdList(values: ReadonlyArray<string> | undefined): string[] {
  return dedupeStrings((values ?? []).map(normalizeSkillId).filter(Boolean));
}

function normalizeSkillId(value: string): string {
  return value.trim().toLowerCase();
}

function dedupeStrings(values: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
