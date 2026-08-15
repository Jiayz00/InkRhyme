import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

export const STUDIO_GLOBAL_CONFIG_DIR = join(homedir(), ".inkos");
export const STUDIO_GLOBAL_CONFIG_PATH = join(STUDIO_GLOBAL_CONFIG_DIR, "studio.json");

export interface StudioGlobalConfig {
  version: number;
  lastProjectRoot?: string;
  updatedAt?: string;
}

const CURRENT_VERSION = 1;

const defaultConfig = (): StudioGlobalConfig => ({
  version: CURRENT_VERSION,
});

export async function loadStudioGlobalConfig(): Promise<StudioGlobalConfig> {
  if (!existsSync(STUDIO_GLOBAL_CONFIG_PATH)) {
    return defaultConfig();
  }
  try {
    const raw = await readFile(STUDIO_GLOBAL_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<StudioGlobalConfig>;
    return {
      ...defaultConfig(),
      ...parsed,
      version: CURRENT_VERSION,
    };
  } catch {
    return defaultConfig();
  }
}

export async function saveStudioGlobalConfig(
  patch: Partial<Omit<StudioGlobalConfig, "version" | "updatedAt">>,
): Promise<StudioGlobalConfig> {
  await mkdir(STUDIO_GLOBAL_CONFIG_DIR, { recursive: true });
  const existing = await loadStudioGlobalConfig();
  const next: StudioGlobalConfig = {
    ...existing,
    ...patch,
    version: CURRENT_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await writeFile(STUDIO_GLOBAL_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

export interface StudioProjectInitResult {
  initialized: boolean;
  root: string;
}

export async function ensureStudioProjectInitialized(
  projectDir: string,
  language: "zh" | "en" = "zh",
): Promise<StudioProjectInitResult> {
  const configPath = join(projectDir, "inkos.json");
  try {
    await access(configPath);
    return { initialized: false, root: projectDir };
  } catch {
    // Not a project yet — create a minimal skeleton so the server can start.
  }

  await mkdir(projectDir, { recursive: true });
  await mkdir(join(projectDir, "books"), { recursive: true });

  const config = {
    name: basename(projectDir),
    version: "0.1.0",
    language,
    llm: {
      provider: "openai" as const,
      service: "custom" as const,
      configSource: "studio" as const,
      baseUrl: "",
      model: "",
      apiFormat: "chat" as const,
      stream: true,
    },
    notify: [],
    inputGovernanceMode: "v2" as const,
    daemon: {
      schedule: {
        radarCron: "0 */6 * * *",
        writeCron: "*/15 * * * *",
      },
      maxConcurrentBooks: 3,
    },
  };

  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return { initialized: true, root: projectDir };
}
