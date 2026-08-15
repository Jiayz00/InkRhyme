import { startStudioServer } from "./server.js";
import { resolve, join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureStudioProjectInitialized, saveStudioGlobalConfig } from "../utils/studio-global-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the project root exactly like the original Studio bootstrap:
// explicit CLI arg > explicit env var > current working directory.
// This preserves the "launch directory is the project" contract; the server
// will auto-initialise the directory if it is not already an InkOS project.
function resolveStudioProjectRoot(): string {
  if (process.argv[2]) {
    return resolve(process.argv[2]);
  }
  const env = process.env.INKOS_PROJECT_ROOT;
  if (env) {
    return resolve(env);
  }
  return resolve(process.cwd());
}

const root = resolveStudioProjectRoot();

// Ensure the launch directory is a usable InkOS project. When the server is
// started directly (rather than through `inkos studio`), the directory may not
// have been initialised yet. This is idempotent and preserves existing projects.
const { initialized } = await ensureStudioProjectInitialized(root);
if (initialized) {
  console.log(`[Studio] initialised new project at ${root}`);
}

// Remember this project globally so the Studio UI can offer it as a recent
// project and so that external launchers can read the last-used location.
await saveStudioGlobalConfig({ lastProjectRoot: root }).catch(() => {
  /* ignore permission errors */
});

const port = parseInt(process.env.INKOS_STUDIO_PORT ?? "4567", 10);

// Find studio package root (2 levels up from src/api/)
const studioRoot = resolve(__dirname, "../..");
const distDir = join(studioRoot, "dist");

// Auto-build frontend if dist/ doesn't exist
if (!existsSync(join(distDir, "index.html"))) {
  console.log("Building frontend...");
  try {
    execSync("npx vite build", { cwd: studioRoot, stdio: "inherit" });
  } catch {
    console.error("Failed to build frontend. Run 'cd packages/studio && pnpm build' manually.");
    process.exit(1);
  }
}

console.log(`[Studio] project root = ${root}`);
console.log(`[Studio] API server port = ${port}`);

startStudioServer(root, port, { staticDir: distDir }).catch((e) => {
  console.error("Failed to start studio:", e);
  process.exit(1);
});
