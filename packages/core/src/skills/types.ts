import { z } from "zod";

export const AgentSkillSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  body: z.string().default(""),
  source: z.enum(["project", "user", "external"]).default("external"),
  baseDir: z.string().min(1).optional(),
  packageId: z.string().max(64).optional(),
}).strict();
export type AgentSkill = z.infer<typeof AgentSkillSchema>;

export const SkillPackageSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  source: z.enum(["project", "user", "external"]).default("external"),
  skillIds: z.array(z.string().max(64)).default([]),
  baseDir: z.string().min(1).optional(),
  tags: z.array(z.string().max(32)).default([]),
}).strict();
export type SkillPackage = z.infer<typeof SkillPackageSchema>;

export interface HierarchicalSkillCatalog {
  readonly packages: ReadonlyArray<SkillPackage>;
  readonly skills: ReadonlyArray<AgentSkill>;
}

export interface SkillResolutionInput {
  readonly requestedSkills?: ReadonlyArray<string>;
  readonly disabledSkills?: ReadonlyArray<string>;
}

export interface SkillResolutionResult {
  readonly usedSkills: ReadonlyArray<AgentSkill>;
  readonly forcedSkillIds: ReadonlyArray<string>;
  readonly missingSkillIds: ReadonlyArray<string>;
  readonly disabledSkillIds: ReadonlyArray<string>;
  readonly availableSkills: ReadonlyArray<AgentSkill>;
  readonly availableSkillIds: ReadonlyArray<string>;
}

export interface SkillRegistry {
  listSkills(): ReadonlyArray<AgentSkill>;
  listPackages(): ReadonlyArray<SkillPackage>;
  getSkill(id: string): AgentSkill | undefined;
  getPackage(id: string): SkillPackage | undefined;
  resolveSkills(input: SkillResolutionInput): SkillResolutionResult;
}
