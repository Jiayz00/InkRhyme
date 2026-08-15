import { Command } from "commander";
import { findProjectRoot, log, logError } from "../utils.js";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureProjectDirectoryInitialized } from "../project-bootstrap.js";
import { createRequire } from "node:module";

export interface StudioLaunchSpec {
  readonly studioEntry: string;
  readonly command: string;
  readonly args: string[];
}

export interface BrowserLaunchSpec {
  readonly command: string;
  readonly args: string[];
}

export interface StudioCommandHooks {
  readonly launchStudio?: (projectRoot: string, port: string) => Promise<void> | void;
}

async function prepareStudioRoot(root: string): Promise<{ readonly root: string; readonly initialized: boolean }> {
  const initialized = await ensureProjectDirectoryInitialized(root, { language: "zh" });
  return { root, initialized };
}

async function firstAccessiblePath(paths: readonly string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      await access(path);
      return path;
    } catch {
      // continue
    }
  }
  return undefined;
}

const cliPackageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Resolve @actalk/inkos-studio package root via Node's module resolution,
 * which works across npm/pnpm/yarn global installs, local installs, and
 * linked workspaces. Returns the directory that contains the package's
 * `package.json` (so `dist/api/index.js` is a direct child under it).
 */
function resolveStudioPackageRootViaRequire(): string | null {
  try {
    // Create a require function anchored at the CLI package so the
    // resolution context is the CLI package's own dependency graph
    // (not the user's arbitrary CWD). This matters for global installs
    // where @actalk/inkos-studio is a peer/dep of @actalk/inkos and
    // may not be visible from the end-user's CWD.
    const requireFromCli = createRequire(import.meta.url);
    const pkgJsonPath = requireFromCli.resolve("@actalk/inkos-studio/package.json");
    return dirname(pkgJsonPath);
  } catch {
    try {
      // Fallback: resolve the main entry (package.json "main"),
      // then go up to the package root.
      const requireFromCli = createRequire(import.meta.url);
      const mainEntry = requireFromCli.resolve("@actalk/inkos-studio");
      // mainEntry = <studioRoot>/dist/api/index.js
      const distApiDir = dirname(mainEntry);
      const distDir = dirname(distApiDir);
      return dirname(distDir);
    } catch {
      return null;
    }
  }
}

export function toNodeImportSpecifier(path: string): string {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return `file:///${path.replace(/\\/g, "/")}`;
  }
  return path;
}

export function resolveBrowserLaunch(
  platform: NodeJS.Platform,
  url: string,
): BrowserLaunchSpec {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

export async function resolveStudioLaunch(root: string): Promise<StudioLaunchSpec | null> {
  const sourceEntry = await firstAccessiblePath([
    join(root, "packages", "studio", "src", "api", "index.ts"),
    join(root, "..", "packages", "studio", "src", "api", "index.ts"),
    join(root, "..", "studio", "src", "api", "index.ts"),
  ]);
  if (sourceEntry) {
    const studioPackageRoot = dirname(dirname(dirname(sourceEntry)));
    const localTsxLoader = await firstAccessiblePath([
      join(studioPackageRoot, "node_modules", "tsx", "dist", "loader.mjs"),
    ]);
    if (localTsxLoader) {
      return {
        studioEntry: sourceEntry,
        command: "node",
        args: ["--import", toNodeImportSpecifier(localTsxLoader), sourceEntry, root],
      };
    }

    const localTsx = await firstAccessiblePath([
      join(studioPackageRoot, "node_modules", ".bin", "tsx"),
    ]);
    if (localTsx) {
      return {
        studioEntry: sourceEntry,
        command: localTsx,
        args: [sourceEntry, root],
      };
    }
    return {
      studioEntry: sourceEntry,
      command: "npx",
      args: ["tsx", sourceEntry, root],
    };
  }

  const resolvedStudioRoot = resolveStudioPackageRootViaRequire();
  const builtEntryCandidates: string[] = [];
  if (resolvedStudioRoot) {
    // Highest confidence: the exact folder Node resolved for
    // @actalk/inkos-studio as a dependency of the CLI package.
    builtEntryCandidates.push(
      join(resolvedStudioRoot, "dist", "api", "index.js"),
      join(resolvedStudioRoot, "server.cjs"),
    );
  }
  builtEntryCandidates.push(
    join(root, "node_modules", "@actalk", "inkos-studio", "dist", "api", "index.js"),
    join(root, "node_modules", "@actalk", "inkos-studio", "server.cjs"),
    join(cliPackageRoot, "node_modules", "@actalk", "inkos-studio", "dist", "api", "index.js"),
    join(cliPackageRoot, "node_modules", "@actalk", "inkos-studio", "server.cjs"),
    join(cliPackageRoot, "..", "inkos-studio", "dist", "api", "index.js"),
    join(cliPackageRoot, "..", "inkos-studio", "server.cjs"),
  );
  const builtEntry = await firstAccessiblePath(builtEntryCandidates);
  if (builtEntry) {
    return {
      studioEntry: builtEntry,
      command: "node",
      args: [builtEntry, root],
    };
  }

  return null;
}

export async function launchStudioWorkbench(root: string, port: string): Promise<void> {
  const prepared = await prepareStudioRoot(root);
  const url = prepared.initialized
    ? `http://localhost:${port}#/services`
    : `http://localhost:${port}`;
  const launch = await resolveStudioLaunch(root);

  if (!launch) {
    logError(
      "InkOS Studio not found. If you cloned the repo, run:\n" +
      "  cd packages/studio && pnpm install && pnpm build\n" +
      "Then run 'inkos studio' from the project root.",
    );
    process.exit(1);
  }

  log(`Starting InkOS Studio on ${url}`);

  const child = spawn(launch.command, launch.args, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      INKOS_STUDIO_PORT: port,
      // Pass the resolved project root explicitly via the canonical env
      // variable, so even if the launched server ends up falling through to
      // env-based resolution (e.g. someone used INKOS_PROJECT_ROOT=../.. in
      // a dev script without passing an argv[2] path), it still lands on the
      // right project. argv[2] always wins over INKOS_PROJECT_ROOT inside
      // src/api/index.ts's resolveStudioProjectRoot(), so this is safe.
      INKOS_PROJECT_ROOT: prepared.root,
    },
  });

  child.on("error", (e) => {
    logError(`Failed to start studio: ${e.message}`);
    process.exit(1);
  });

  const browserLaunch = resolveBrowserLaunch(process.platform, url);
  const browser = spawn(browserLaunch.command, browserLaunch.args, {
    cwd: root,
    stdio: "ignore",
    detached: true,
  });
  browser.on("error", () => {
    // Best effort only — server startup should not fail just because browser open failed.
  });
  if (typeof browser.unref === "function") {
    browser.unref();
  }

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

export async function launchStudioEntry(
  root: string,
  port: string,
  hooks: StudioCommandHooks = {},
): Promise<void> {
  const prepared = await prepareStudioRoot(root);
  if (prepared.initialized) {
    log(`No inkos.json found in ${root}. Initialized a minimal InkOS project for Studio.`);
  }

  if (hooks.launchStudio) {
    await hooks.launchStudio(prepared.root, port);
    return;
  }

  await launchStudioWorkbench(prepared.root, port);
}

export function createStudioCommand(hooks: StudioCommandHooks = {}): Command {
  return new Command("studio")
  .description("Start InkOS Studio web workbench for a specific project directory. Defaults to INKOS_PROJECT_ROOT env, else the nearest inkos project above CWD.")
  .option("-p, --port <port>", "Server port", "4567")
  .option("--project <dir>", "Path to the novel project directory (the folder that contains inkos.json / books/ / .inkos/). If omitted, resolves from INKOS_PROJECT_ROOT env or the nearest inkos project above CWD.")
  .action(async (opts) => {
    const root = findProjectRoot({ explicitOverride: opts.project });
    const port = opts.port;
    log(`Studio project root: ${root}`);
    await launchStudioEntry(root, port, hooks);
  });
}

export const studioCommand = createStudioCommand();
