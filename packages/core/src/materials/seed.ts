import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { MaterialAsset } from "./ingest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);

const SEED_MARKER = "builtin-seed";
const EXCERPT_CHARS = 1600;

function slug(title: string): string {
  return String(title)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "material";
}

function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

function resolveBuiltinSeedDir(): string {
  // core package layout: dist/materials/seed.js vs src/materials/seed.ts;
  // seed-materials/ is a sibling of dist/ and src/ in the package root.
  // package.json -> files: ["dist"] means when packed, seed-materials must be
  // copied. For runtime resolution from within dist/ we find the package root.
  // Walk up from __dirname until we find package.json with name @inkrhyme/core.
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    try {
      const pkgRaw = require.resolve(join(dir, "package.json"));
      const pkg = require(pkgRaw) as { name?: string };
      if (pkg.name === "@inkrhyme/core") {
        const candidate = join(dir, "seed-materials");
        const stats = require("node:fs").statSync(candidate);
        if (stats.isDirectory()) return candidate;
      }
    } catch {
      /* walk up */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "seed-materials directory not found next to @inkrhyme/core package.json. Re-run pnpm build or ensure package was installed with its dist assets.",
  );
}

export interface SeededMaterialResult {
  readonly cleaned: number;
  readonly seeded: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly sourceDir: string;
  readonly materialsDir: string;
}

/**
 * Built-in seed: for each markdown in `packages/core/seed-materials/*.md`,
 * write a MaterialAsset pair (.json + .md) into
 * `<projectRoot>/.inkos/materials/`. The manifest carries `seededBy =
 * "builtin-seed"` so we can safely rebuild without touching user-ingested
 * assets.
 *
 * Idempotent:
 *  - Clears any asset previously written by THIS seed (seededBy match + id / markdownPath truthy)
 *  - Does NOT touch assets written by user's `ingest_material` tool or by
 *    older "ingest-seed" scripts (different marker).
 */
export async function seedProjectBuiltinMaterials(
  projectRoot: string,
  options?: { readonly sourceDir?: string; readonly now?: Date },
): Promise<SeededMaterialResult> {
  const projectRootResolved = resolve(projectRoot);
  const sourceDir = options?.sourceDir ?? resolveBuiltinSeedDir();
  const materialsDir = join(projectRootResolved, ".inkos", "materials");
  const now = options?.now ?? new Date();

  let files: readonly string[];
  try {
    files = (await readdir(sourceDir))
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch (error) {
    throw new Error(
      `Seed materials source missing or unreadable at ${sourceDir}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (files.length === 0) {
    throw new Error(`Seed materials source has no markdown files: ${sourceDir}`);
  }

  await mkdir(materialsDir, { recursive: true });

  let cleaned = 0;
  const existingEntries = await readdir(materialsDir).catch(() => [] as string[]);
  for (const entry of existingEntries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const raw = JSON.parse(await readFile(join(materialsDir, entry), "utf-8"));
      if (
        raw &&
        typeof raw === "object" &&
        (raw as Record<string, unknown>).seededBy === SEED_MARKER &&
        typeof (raw as Record<string, unknown>).id === "string" &&
        typeof (raw as Record<string, unknown>).markdownPath === "string"
      ) {
        await rm(join(materialsDir, entry), { force: true });
        const mdName = basename((raw as Record<string, unknown>).markdownPath as string);
        await rm(join(materialsDir, mdName), { force: true });
        cleaned += 1;
      }
    } catch {
      /* skip corrupt manifest */
    }
  }

  const nowStamp = now.toISOString().replace(/[:.]/g, "-");
  const seeded: Array<{ readonly id: string; readonly title: string }> = [];
  for (const file of files) {
    const mdPath = join(sourceDir, file);
    const text = await readFile(mdPath, "utf-8");
    const title = (text.match(/^#\s+(.+)$/m)?.[1] || file.replace(/\.md$/i, "")).trim().slice(0, 120);
    const id = `${nowStamp}-${slug(title)}`;
    const markdownPathAbs = join(materialsDir, `${id}.md`);
    const manifestPathAbs = join(materialsDir, `${id}.json`);

    const markdown = [
      `# ${title}`,
      "",
      `> source: ${toPosix(relative(projectRootResolved, mdPath))}`,
      `> purpose: reference`,
      `> kind: text`,
      "",
      text,
      "",
    ].join("\n");

    await writeFile(markdownPathAbs, markdown, "utf-8");

    const asset: MaterialAsset & { readonly seededBy: string } = {
      id,
      title,
      kind: "text",
      purpose: "reference",
      source: toPosix(relative(projectRootResolved, mdPath)),
      mimeType: "text/markdown",
      markdownPath: toPosix(relative(projectRootResolved, markdownPathAbs)),
      manifestPath: toPosix(relative(projectRootResolved, manifestPathAbs)),
      charCount: markdown.length,
      excerpt: markdown.slice(0, EXCERPT_CHARS),
      seededBy: SEED_MARKER,
    } as const;
    await writeFile(manifestPathAbs, JSON.stringify(asset, null, 2), "utf-8");
    seeded.push({ id, title });
  }

  return { cleaned, seeded, sourceDir, materialsDir };
}

export { SEED_MARKER as BUILTIN_SEED_MARKER };
