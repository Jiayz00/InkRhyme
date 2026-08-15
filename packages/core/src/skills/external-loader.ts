import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import yaml from "js-yaml";
import {
  AgentSkillSchema,
  SkillPackageSchema,
  type AgentSkill,
  type SkillPackage,
} from "./types.js";

const MAX_SKILL_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_NAME_CHARS = 64;
const MAX_SKILL_DESCRIPTION_CHARS = 1024;
const PACKAGE_META_NAMES = [
  "PACKAGE.yaml",
  "PACKAGE.yml",
  "skill-package.yaml",
  "skill-package.yml",
] as const;

export interface LoadExternalAgentSkillsInput {
  readonly externalDirs: ReadonlyArray<string>;
  readonly source?: AgentSkill["source"];
}

export interface ExternalSkillDiagnostic {
  readonly path: string;
  readonly message: string;
}

export interface LoadExternalAgentSkillsResult {
  readonly skills: ReadonlyArray<AgentSkill>;
  readonly packages: ReadonlyArray<SkillPackage>;
  readonly diagnostics: ReadonlyArray<ExternalSkillDiagnostic>;
}

export interface LoadConfiguredAgentSkillsInput {
  readonly projectRoot: string;
  readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  readonly homeDir?: string;
}

export interface ParseAgentSkillDocumentOptions {
  readonly skillPath: string;
  readonly source?: AgentSkill["source"];
  readonly packageId?: string;
}

export async function loadExternalAgentSkills(
  input: LoadExternalAgentSkillsInput,
): Promise<LoadExternalAgentSkillsResult> {
  const roots = await normalizeExternalRoots(input.externalDirs);
  const skills: AgentSkill[] = [];
  const packages: SkillPackage[] = [];
  const diagnostics: ExternalSkillDiagnostic[] = [];

  for (const root of roots) {
    try {
      const classification = await classifyExternalRoot(root);
      if (classification.kind === "package") {
        const result = await loadPackageDirectory(classification, input.source);
        packages.push(result.pkg);
        skills.push(...result.skills);
        diagnostics.push(...result.diagnostics);
      } else {
        const skill = await loadSkillManifest(classification.skillPath, input.source);
        skills.push(skill);
      }
    } catch (error) {
      diagnostics.push({
        path: root,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { skills, packages, diagnostics };
}

export async function loadConfiguredAgentSkills(
  input: LoadConfiguredAgentSkillsInput,
): Promise<LoadExternalAgentSkillsResult> {
  const candidates = configuredSkillDirs(input);
  const skills: AgentSkill[] = [];
  const packages: SkillPackage[] = [];
  const diagnostics: ExternalSkillDiagnostic[] = [];

  for (const candidate of candidates) {
    try {
      const result = await loadExternalAgentSkills({
        externalDirs: [candidate.path],
        source: candidate.source,
      });
      skills.push(...result.skills);
      packages.push(...result.packages);
      diagnostics.push(...result.diagnostics);
    } catch (error) {
      if (!candidate.explicit && isMissingPathError(error)) continue;
      diagnostics.push({
        path: candidate.path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { skills, packages, diagnostics };
}

interface ConfiguredSkillDir {
  readonly path: string;
  readonly explicit: boolean;
  readonly source: AgentSkill["source"];
}

function configuredSkillDirs(input: LoadConfiguredAgentSkillsInput): ConfiguredSkillDir[] {
  const env = input.env ?? process.env;
  const envDirs = (env.INKOS_SKILL_DIRS ?? "")
    .split(delimiter)
    .map((value) => value.trim())
    .filter(Boolean);
  const homeDir = input.homeDir ?? homedir();
  return [
    ...envDirs.map((path) => ({ path, explicit: true, source: "external" as const })),
    { path: join(homeDir, ".openclaw", "skills"), explicit: false, source: "user" },
    { path: join(homeDir, ".agents", "skills"), explicit: false, source: "user" },
    { path: join(input.projectRoot, ".agents", "skills"), explicit: false, source: "project" },
    { path: join(input.projectRoot, "skills"), explicit: false, source: "project" },
  ];
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}

async function normalizeExternalRoots(externalDirs: ReadonlyArray<string>): Promise<string[]> {
  const found: string[] = [];
  for (const dir of externalDirs) {
    if (!isAbsolute(dir)) {
      throw new Error(`External skill directory must be absolute: ${dir}`);
    }
    const info = await stat(dir);
    if (!info.isDirectory()) {
      throw new Error(`External skill path is not a directory: ${dir}`);
    }
    const classification = await classifyExternalRoot(dir).catch(() => null);
    // 如果 dir 本身是裸 skill 或包，直接进列表
    if (classification) {
      found.push(dir);
      continue;
    }
    // 否则在 depth=2 范围内扫描所有直接子目录（保持旧 discoverSkillDirs 行为），
    // 并补充对 package 根目录的识别
    found.push(...await discoverRootsBelow(dir, 2));
  }
  return [...new Set(found)].sort();
}

async function discoverRootsBelow(root: string, remainingDepth: number): Promise<string[]> {
  if (remainingDepth <= 0) return [];
  const dirs: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(root, entry.name);
    const kind = await classifyExternalRoot(child).catch(() => null);
    if (kind) {
      dirs.push(child);
      continue;
    }
    dirs.push(...await discoverRootsBelow(child, remainingDepth - 1));
  }
  return dirs;
}

type ExternalClassification =
  | { readonly kind: "standalone"; readonly skillPath: string; readonly dir: string }
  | { readonly kind: "package"; readonly dir: string; readonly manifest?: PackageManifest; readonly subDirs: ReadonlyArray<string> };

interface PackageManifest {
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

async function classifyExternalRoot(dir: string): Promise<ExternalClassification> {
  if (await hasSkillManifest(dir)) {
    return { kind: "standalone", skillPath: join(dir, "SKILL.md"), dir };
  }
  const manifest = await readPackageManifest(dir);
  const subDirs = await listPackageSubdirectories(dir);
  if (manifest || subDirs.length >= 2) {
    return { kind: "package", dir, manifest, subDirs };
  }
  throw new Error(`Not a skill folder: ${dir}`);
}

async function hasSkillManifest(dir: string): Promise<boolean> {
  try {
    const info = await stat(join(dir, "SKILL.md"));
    return info.isFile();
  } catch {
    return false;
  }
}

async function readPackageManifest(dir: string): Promise<PackageManifest | undefined> {
  for (const name of PACKAGE_META_NAMES) {
    const p = join(dir, name);
    try {
      const info = await stat(p);
      if (!info.isFile()) continue;
      const raw = await readFile(p, "utf-8");
      const parsed = yaml.load(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const rec = parsed as Record<string, unknown>;
      const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : undefined;
      const description = typeof rec.description === "string" && rec.description.trim() ? rec.description.trim() : undefined;
      const tags = Array.isArray(rec.tags) && rec.tags.every((t) => typeof t === "string")
        ? rec.tags as readonly string[]
        : undefined;
      return { name, description, tags };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function listPackageSubdirectories(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(dir, entry.name);
    if (await hasSkillManifest(child)) results.push(child);
  }
  return results.sort();
}

async function loadSkillManifest(
  skillPath: string,
  source: AgentSkill["source"] = "external",
  packageId?: string,
): Promise<AgentSkill> {
  const info = await stat(skillPath);
  if (info.size > MAX_SKILL_MANIFEST_BYTES) {
    throw new Error(`SKILL.md exceeds ${MAX_SKILL_MANIFEST_BYTES} bytes.`);
  }
  const raw = await readFile(skillPath, "utf-8");
  return parseAgentSkillDocument(raw, { skillPath, source, packageId });
}

async function loadPackageDirectory(
  classification: Extract<ExternalClassification, { readonly kind: "package" }>,
  source: AgentSkill["source"] = "external",
): Promise<{
  readonly pkg: SkillPackage;
  readonly skills: ReadonlyArray<AgentSkill>;
  readonly diagnostics: ReadonlyArray<ExternalSkillDiagnostic>;
}> {
  const fallbackName = basename(classification.dir);
  const manifest = classification.manifest;
  const pkgId = normalizeExternalSkillId(manifest?.name ?? fallbackName, fallbackName);
  const packageDir = classification.dir;

  const name = (manifest?.name?.trim()) || fallbackName;
  const description = (manifest?.description?.trim()) || `Skill 包：${fallbackName}（${classification.subDirs.length} 个 Skill）`;
  const tags = manifest?.tags?.filter((t) => t && t.length <= 32) ?? [];

  const loaded: AgentSkill[] = [];
  const diagnostics: ExternalSkillDiagnostic[] = [];
  for (const subDir of classification.subDirs) {
    const manifestPath = join(subDir, "SKILL.md");
    try {
      loaded.push(await loadSkillManifest(manifestPath, source, pkgId));
    } catch (error) {
      diagnostics.push({
        path: manifestPath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const sorted = [...loaded].sort((a, b) => a.name.localeCompare(b.name));

  const pkg = SkillPackageSchema.parse({
    id: pkgId,
    name,
    description,
    source,
    skillIds: sorted.map((skill) => skill.id),
    baseDir: packageDir,
    tags,
  });

  return { pkg, skills: sorted, diagnostics };
}

export function parseAgentSkillDocument(
  raw: string,
  options: ParseAgentSkillDocumentOptions,
): AgentSkill {
  const parsed = parseFrontmatter(raw);
  if (!parsed.data || typeof parsed.data !== "object" || Array.isArray(parsed.data)) {
    throw new Error("SKILL.md frontmatter must be a YAML object.");
  }
  const data = parsed.data as Record<string, unknown>;
  const fallbackId = basename(dirname(options.skillPath));
  const name = requiredText(data.name, "name", MAX_SKILL_NAME_CHARS);
  const description = requiredText(
    data.description,
    "description",
    MAX_SKILL_DESCRIPTION_CHARS,
  );
  const id = normalizeExternalSkillId(name, fallbackId);
  const payload: Record<string, unknown> = {
    id,
    name,
    description,
    body: parsed.body.trim(),
    source: options.source ?? "external",
    baseDir: dirname(options.skillPath),
  };
  if (options.packageId) payload.packageId = options.packageId;
  return AgentSkillSchema.parse(payload) as AgentSkill;
}

function parseFrontmatter(raw: string): { readonly data: unknown; readonly body: string } {
  const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    throw new Error("SKILL.md must start with YAML frontmatter delimiters.");
  }
  const end = normalized.indexOf("\n---", 4);
  if (end < 0) {
    throw new Error("SKILL.md is missing closing YAML frontmatter delimiter.");
  }
  const frontmatter = normalized.slice(4, end).trim();
  const body = normalized.slice(end + "\n---".length).replace(/^\r?\n/, "");
  return {
    data: yaml.load(frontmatter),
    body,
  };
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredText(value: unknown, field: string, maxChars?: number): string {
  const text = optionalText(value);
  if (!text) throw new Error(`SKILL.md frontmatter requires ${field}.`);
  if (maxChars !== undefined && text.length > maxChars) {
    throw new Error(`SKILL.md frontmatter ${field} must be at most ${maxChars} characters.`);
  }
  return text;
}

function normalizeExternalSkillId(value: string, fallback: string): string {
  const normalize = (candidate: string): string => candidate
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const id = normalize(value) || normalize(fallback);
  if (!id) throw new Error("SKILL.md requires a name that can be used as a skill id.");
  const normalized = /^[a-z]/.test(id) ? id : `skill-${id}`;
  if (normalized.length > MAX_SKILL_NAME_CHARS) {
    throw new Error(`SKILL.md skill id must be at most ${MAX_SKILL_NAME_CHARS} characters.`);
  }
  return normalized;
}
