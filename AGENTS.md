# AGENTS.md — InkRhyme

InkRhyme is an interactive AI writing workbench for long-form fiction, built on top of the InkOS writing engine. The project restructures InkOS into a two-package monorepo with an Electron desktop application.

## Setup

```bash
node --version  # must be >=20 (prefer 22 per .node-version)
pnpm install    # pnpm >=9, .npmrc is gitignored — recreate if missing
pnpm build
```

## Monorepo (pnpm workspace)

Two primary packages with strict build order:

```
@inkrhyme/core     (writing engine — no workspace deps, builds first)
  ^
@inkrhyme/desktop  (Electron app — depends on core)
```

Legacy packages (will be removed once desktop matures):
- `@actalk/inkos` — original CLI (commander + ink TUI), depends on core + studio
- `@actalk/inkos-studio` — original web workbench (Hono + Vite/React), depends on core

- `pnpm -r build` resolves order automatically.
- Core must be built before desktop or legacy packages can typecheck/test.

## Dev commands

```bash
pnpm build                              # build all packages
pnpm dev                                # parallel tsc --watch in all packages
pnpm dev:desktop                        # run Electron desktop app in dev mode
pnpm --filter @inkrhyme/core test       # core unit tests
pnpm --filter @inkrhyme/core typecheck  # core typecheck
pnpm --filter @inkrhyme/desktop typecheck # desktop typecheck
```

## Package structure

### @inkrhyme/core (`packages/core/`)

The writing engine — pure logic, no UI. Contains:
- `models/` — domain schema (Book, Chapter, Project, State, etc.) with zod
- `agents/` — writing agents (planner, composer, writer, settler, auditor, reviser, etc.)
- `pipeline/` — PipelineRunner orchestration (slated for拆分 into orchestrator/artifact-builder/chapter-writer/review-cycle/state-validator/persistence)
- `llm/` — LLM abstraction (provider.ts is the single seam, bound to `@mariozechner/pi-ai`)
- `state/` — file I/O + runtime state + SQLite memory
- `agent/` — conversational agent layer (bound to `@mariozechner/pi-agent-core`)
- `materials/` — writing craft knowledge RAG
- `genres/` + `seed-materials/` — genre profiles and craft knowledge assets
- `utils/` — writing support utilities (context filtering, length metrics, etc.)

### @inkrhyme/desktop (`packages/desktop/`)

Electron desktop application. Contains:
- `src/main/` — Electron main process (window creation, IPC handlers)
- `src/preload/` — context bridge (exposes `window.inkrhyme` API to renderer)
- `src/renderer/` — React frontend (Vite-bundled, port 5173 in dev)
- `src/shared/` — shared types between main and renderer

Dev workflow: `pnpm dev:desktop` starts Vite dev server + Electron concurrently.

## TypeScript quirks

- **Root tsconfig**: `module: Node16`, `moduleResolution: Node16`, `strict: true`.
- **Core tsconfig** extends root, outputs to `dist/`.
- **Desktop renderer tsconfig** uses `module: "ESNext"`, `moduleResolution: "bundler"`, `noEmit: true` (Vite handles bundling). Path aliases `@inkrhyme/core` and `@inkrhyme/core/*` resolve to source.
- **Desktop main tsconfig** extends root but uses `module: "ESNext"`, `moduleResolution: "bundler"`, `jsx: "react-jsx"`.
- **Studio tsconfig** (legacy) DOES NOT extend root. Uses `module: "ESNext"`, `moduleResolution: "bundler"`.
- **CLI tsconfig** (legacy) extends root but adds `jsx: "react-jsx"`.

## Architecture decisions

- **Extraction approach**: InkRhyme extracts InkOS's writing core (models/agents/pipeline/llm/state/utils) and wraps it in a new Electron shell. Legacy CLI/Studio are retained for reference but will be removed.
- **Performance target**: Runner.ts (159KB monolith) will be split into 5+ focused modules. Key optimizations: remove LLM-based outline selection, merge writer Phase 1+2, downgrade state-validator to local rules.
- **Persistence**: hybrid model — markdown-as-truth (from InkOS) + SQLite index layer (new, for canvas/card queries).
- **Interaction**: conversation-primary with structured card沉淀 + canvas view. Mode-switchable, splittable.

## Notable dependencies

- Agent runtime: `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` (version pinned in root `pnpm.overrides`).
- Desktop: `electron`, `react`, `react-dom`, `vite`.
- Schema validation: `zod` (core), `@sinclair/typebox` (core).
- Legacy CLI TUI: `ink` (React for terminals) + `commander`.
- Legacy Studio: `hono`, `zustand`, `@xyflow/react`.

## Project runtime data (gitignored)

These are user-generated at runtime, not source code:
- `.inkos/` — secrets, session state
- `books/`, `worlds/` — story data
- `inkos.json` — per-project config
- `prompt/` — custom prompt packs

## skills/ vs packages/core/src/skills/

- `skills/SKILL.md` is the **OpenClaw agent descriptor** (how external agents invoke InkOS).
- `packages/core/src/skills/` is the **code implementation** (registry, types, loader for user-provided Agent Skills).
- They are different things. Don't confuse them.

## Agent skills

### Issue tracker

Issues 与 specs 以 markdown 文件存放在 `.scratch/<feature-slug>/` 下。See `docs/agents/issue-tracker.md`.

### Triage labels

使用五个默认 canonical triage 标签（needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix）。See `docs/agents/triage-labels.md`.

### Domain docs

Single-context：根 `CONTEXT.md` + `docs/adr/`。See `docs/agents/domain.md`.
