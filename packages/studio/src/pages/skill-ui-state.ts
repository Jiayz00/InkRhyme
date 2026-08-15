export interface StudioSkill {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly body?: string;
  readonly source?: string;
  readonly editable?: boolean;
  readonly path?: string;
  readonly packageId?: string;
}

export interface StudioSkillPackage {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "project" | "user" | "external";
  readonly editable: boolean;
  readonly skillIds: readonly string[];
  readonly path?: string;
  readonly tags: readonly string[];
}

export interface SkillImportFilePayload {
  readonly path: string;
  readonly dataUrl: string;
}

const MAX_SKILL_IMPORT_FILES = 128;
const MAX_SKILL_IMPORT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SKILL_IMPORT_TOTAL_BYTES = 8 * 1024 * 1024;

export function normalizeSkillId(value: string): string {
  const id = value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!id) return "";
  return /^[a-z]/.test(id) ? id : `skill-${id}`;
}

export function toggleSelectedSkillIds(selected: ReadonlyArray<string>, skillId: string): string[] {
  const id = normalizeSkillId(skillId);
  if (!id) return [...selected];
  if (selected.includes(id)) return selected.filter((item) => item !== id);
  return [...selected, id];
}

/**
 * 切换"包/子skill"的选中态，考虑层级：
 * - 如果 toggleId 是包id：
 *   - 当前包未完全启用 → 启用包下全部 skill（保留包id，也保留子skill id 去重）
 *   - 否则 → 禁用包下全部 skill + 包 id
 * - 如果 toggleId 是 skillId：按普通逻辑切换；如果是包内 skill，且所有子skill都被选中，则补上包id；否则如果包id原本在且现在有子 skill 未选，则移除包id
 */
export function toggleSelectedSkillIdsHierarchical(
  selected: ReadonlyArray<string>,
  toggleId: string,
  packages: ReadonlyArray<StudioSkillPackage>,
): string[] {
  const ids = selected.map(normalizeSkillId).filter(Boolean);
  const id = normalizeSkillId(toggleId);
  if (!id) return ids;

  const getPackage = (pid: string) => packages.find((pkg) => pkg.id === pid);
  const set = new Set(ids);

  // 情况 A：toggle 是包 id
  const asPackage = getPackage(id);
  if (asPackage) {
    const children = asPackage.skillIds.map(normalizeSkillId).filter(Boolean);
    const allChildrenSelected = children.length > 0 && children.every((c) => set.has(c));
    if (set.has(id) || allChildrenSelected) {
      set.delete(id);
      for (const c of children) set.delete(c);
    } else {
      set.add(id);
      for (const c of children) set.add(c);
    }
    return ids.filter((orig) => set.has(orig)).concat([...set].filter((x) => !ids.includes(x)));
  }

  // 情况 B：toggle 是某个 skill id；如果它属于某个包，考虑包 id 的同步
  const parent = packages.find((pkg) => pkg.skillIds.some((sid) => normalizeSkillId(sid) === id));
  if (set.has(id)) {
    set.delete(id);
    if (parent) {
      const children = parent.skillIds.map(normalizeSkillId).filter(Boolean);
      const anyMissing = children.some((c) => !set.has(c));
      if (anyMissing) set.delete(parent.id);
    }
  } else {
    set.add(id);
    if (parent) {
      const children = parent.skillIds.map(normalizeSkillId).filter(Boolean);
      if (children.length > 0 && children.every((c) => set.has(c))) set.add(parent.id);
    }
  }
  // 保持原顺序，新增放末尾
  const out: string[] = [];
  for (const orig of ids) if (set.has(orig)) out.push(orig);
  for (const curr of set) if (!ids.includes(curr)) out.push(curr);
  return out;
}

export function selectedSkillIdsForSend(selected: ReadonlyArray<string>): string[] | undefined {
  const ids = Array.from(new Set(selected.map(normalizeSkillId).filter(Boolean)));
  return ids.length > 0 ? ids : undefined;
}

export async function serializeSkillFolder(files: FileList | ReadonlyArray<File>): Promise<SkillImportFilePayload[]> {
  const selectedFiles = Array.from(files);
  if (selectedFiles.length > MAX_SKILL_IMPORT_FILES) {
    throw new Error(`A skill may contain at most ${MAX_SKILL_IMPORT_FILES} files.`);
  }
  let totalBytes = 0;
  for (const file of selectedFiles) {
    if (file.size > MAX_SKILL_IMPORT_FILE_BYTES) {
      throw new Error(`${file.name} exceeds ${MAX_SKILL_IMPORT_FILE_BYTES} bytes.`);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_SKILL_IMPORT_TOTAL_BYTES) {
      throw new Error(`Skill folder exceeds ${MAX_SKILL_IMPORT_TOTAL_BYTES} bytes.`);
    }
  }
  const out: SkillImportFilePayload[] = [];
  for (const file of selectedFiles) {
    const path = (file as File & { readonly webkitRelativePath?: string }).webkitRelativePath || file.name;
    const bytes = new Uint8Array(await file.arrayBuffer());
    out.push({
      path,
      dataUrl: `data:${file.type || "application/octet-stream"};base64,${bytesToBase64(bytes)}`,
    });
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

