/**
 * Persistence helpers extracted from PipelineRunner.
 *
 * These functions handle:
 * - SQLite MemoryDB fact/summary/hook index rebuilding
 * - Audit drift guidance file management
 * - Book status activation
 * - Length telemetry and warnings
 *
 * They are pure functions that receive dependencies via params.
 * The `memoryIndexFallbackWarned` mutable flag is encapsulated in
 * a `PersistenceState` object to preserve the "warn once" semantic.
 */
import { MemoryDB, type Fact } from "../state/memory-db.js";
import { loadNarrativeMemorySeed, loadSnapshotCurrentStateFacts } from "../state/runtime-state-store.js";
import { rewriteStructuredStateFromMarkdown } from "../state/state-bootstrap.js";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AuditIssue, AuditResult } from "../agents/continuity.js";
import type { LengthSpec, LengthTelemetry } from "../models/length-governance.js";
import type { LengthLanguage } from "../utils/length-metrics.js";
import { isOutsideHardRange } from "../utils/length-metrics.js";
import type { WriteChapterOutput } from "../agents/writer.js";
import type { Logger } from "../utils/logger.js";

/** Mutable state for persistence helpers (preserves "warn once" semantics). */
export interface PersistenceState {
  memoryIndexFallbackWarned: boolean;
}

export function createPersistenceState(): PersistenceState {
  return { memoryIndexFallbackWarned: false };
}

export interface PersistenceDeps {
  readonly logger?: Pick<Logger, "warn" | "info">;
  readonly localize: (language: LengthLanguage, messages: { zh: string; en: string }) => string;
  readonly resolveBookLanguageById: (bookId: string) => Promise<LengthLanguage>;
  readonly languageFromLengthSpec: (lengthSpec: Pick<LengthSpec, "countingMode">) => LengthLanguage;
}

// ── MemoryDB index helpers ──

export async function syncCurrentStateFactHistory(
  bookId: string,
  bookDir: string,
  uptoChapter: number,
  state: PersistenceState,
  deps: PersistenceDeps,
): Promise<void> {
  try {
    await rebuildCurrentStateFactHistory(bookDir, uptoChapter);
  } catch (error) {
    if (isMemoryIndexUnavailableError(error)) {
      if (canOpenMemoryIndex(bookDir)) {
        try {
          await rebuildCurrentStateFactHistory(bookDir, uptoChapter);
          return;
        } catch (retryError) {
          error = retryError;
        }
      } else {
        if (!state.memoryIndexFallbackWarned) {
          state.memoryIndexFallbackWarned = true;
          const lang = await deps.resolveBookLanguageById(bookId);
          deps.logger?.warn(deps.localize(lang, {
            zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
            en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
          }));
          await logMemoryIndexDebugInfo(bookId, error, deps);
        }
        return;
      }
    }
    const lang = await deps.resolveBookLanguageById(bookId);
    deps.logger?.warn(deps.localize(lang, {
      zh: `状态事实同步已跳过：${String(error)}`,
      en: `State fact sync skipped: ${String(error)}`,
    }));
  }
}

export async function syncLegacyStructuredStateFromMarkdown(
  bookDir: string,
  chapterNumber: number,
  output?: {
    readonly runtimeStateDelta?: WriteChapterOutput["runtimeStateDelta"];
    readonly runtimeStateSnapshot?: WriteChapterOutput["runtimeStateSnapshot"];
  },
): Promise<void> {
  if (output?.runtimeStateDelta || output?.runtimeStateSnapshot) {
    return;
  }
  await rewriteStructuredStateFromMarkdown({
    bookDir,
    fallbackChapter: chapterNumber,
  });
}

export async function syncNarrativeMemoryIndex(
  bookId: string,
  bookDir: string,
  state: PersistenceState,
  deps: PersistenceDeps,
): Promise<void> {
  try {
    await rebuildNarrativeMemoryIndex(bookDir);
  } catch (error) {
    if (isMemoryIndexUnavailableError(error)) {
      if (canOpenMemoryIndex(bookDir)) {
        try {
          await rebuildNarrativeMemoryIndex(bookDir);
          return;
        } catch (retryError) {
          error = retryError;
        }
      } else {
        if (!state.memoryIndexFallbackWarned) {
          state.memoryIndexFallbackWarned = true;
          const lang = await deps.resolveBookLanguageById(bookId);
          deps.logger?.warn(deps.localize(lang, {
            zh: "当前 Node 运行时不支持 SQLite 记忆索引，继续使用 Markdown 回退方案。",
            en: "SQLite memory index unavailable on this Node runtime; continuing with markdown fallback.",
          }));
          await logMemoryIndexDebugInfo(bookId, error, deps);
        }
        return;
      }
    }
    const lang = await deps.resolveBookLanguageById(bookId);
    deps.logger?.warn(deps.localize(lang, {
      zh: `叙事记忆同步已跳过：${String(error)}`,
      en: `Narrative memory sync skipped: ${String(error)}`,
    }));
  }
}

async function rebuildCurrentStateFactHistory(bookDir: string, uptoChapter: number): Promise<void> {
  const memoryDb = await withMemoryIndexRetry(async () => {
    const db = new MemoryDB(bookDir);
    try {
      db.resetFacts();
      const activeFacts = new Map<string, { id: number; object: string }>();
      for (let chapter = 0; chapter <= uptoChapter; chapter++) {
        const snapshotFacts = await loadSnapshotCurrentStateFacts(bookDir, chapter);
        if (snapshotFacts.length === 0) continue;
        const nextFacts = new Map<string, Omit<Fact, "id">>();
        for (const fact of snapshotFacts) {
          nextFacts.set(factKey(fact), {
            subject: fact.subject,
            predicate: fact.predicate,
            object: fact.object,
            validFromChapter: chapter,
            validUntilChapter: null,
            sourceChapter: chapter,
          });
        }
        for (const [key, previous] of activeFacts.entries()) {
          const next = nextFacts.get(key);
          if (!next || next.object !== previous.object) {
            db.invalidateFact(previous.id, chapter);
            activeFacts.delete(key);
          }
        }
        for (const [key, fact] of nextFacts.entries()) {
          if (activeFacts.has(key)) continue;
          const id = db.addFact(fact);
          activeFacts.set(key, { id, object: fact.object });
        }
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  });
  try {
    // No-op: keep the db open only for the duration of the rebuild.
  } finally {
    memoryDb.close();
  }
}

async function rebuildNarrativeMemoryIndex(bookDir: string): Promise<void> {
  const memorySeed = await loadNarrativeMemorySeed(bookDir);
  const memoryDb = await withMemoryIndexRetry(() => {
    const db = new MemoryDB(bookDir);
    try {
      db.replaceSummaries(memorySeed.summaries);
      db.replaceHooks(memorySeed.hooks);
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  });
  try {
    // No-op
  } finally {
    memoryDb.close();
  }
}

function canOpenMemoryIndex(bookDir: string): boolean {
  let memoryDb: MemoryDB | null = null;
  try {
    memoryDb = new MemoryDB(bookDir);
    return true;
  } catch {
    return false;
  } finally {
    memoryDb?.close();
  }
}

async function logMemoryIndexDebugInfo(
  bookId: string,
  error: unknown,
  deps: PersistenceDeps,
): Promise<void> {
  if (process.env.INKOS_DEBUG_SQLITE_MEMORY !== "1") {
    return;
  }
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  const lang = await deps.resolveBookLanguageById(bookId);
  deps.logger?.warn(deps.localize(lang, {
    zh: `SQLite 记忆索引调试：node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
    en: `SQLite memory debug: node=${process.version}; execArgv=${JSON.stringify(process.execArgv)}; code=${code || "(none)"}; message=${message}`,
  }));
}

async function withMemoryIndexRetry<T>(operation: () => Promise<T> | T): Promise<T> {
  const retryDelaysMs = [0, 25, 75];
  let lastError: unknown;
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isMemoryIndexBusyError(error) || attempt === retryDelaysMs.length - 1) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelaysMs[attempt + 1]!));
    }
  }
  throw lastError;
}

function isMemoryIndexUnavailableError(error: unknown): boolean {
  if (!error) return false;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  const normalizedMessage = message.trim();
  return /^No such built-in module:\s*node:sqlite$/i.test(normalizedMessage)
    || /^Cannot find module ['"]node:sqlite['"]$/i.test(normalizedMessage)
    || (code === "ERR_UNKNOWN_BUILTIN_MODULE" && /\bnode:sqlite\b/i.test(normalizedMessage));
}

function isMemoryIndexBusyError(error: unknown): boolean {
  if (!error) return false;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : String(error);
  return code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || /\bSQLITE_BUSY\b/i.test(message)
    || /\bSQLITE_LOCKED\b/i.test(message)
    || /database is locked/i.test(message)
    || /database is busy/i.test(message);
}

function factKey(fact: Pick<Fact, "subject" | "predicate">): string {
  return `${fact.subject}::${fact.predicate}`;
}

// ── Audit drift guidance ──

export async function persistAuditDriftGuidance(params: {
  readonly bookDir: string;
  readonly chapterNumber: number;
  readonly issues: ReadonlyArray<AuditIssue>;
  readonly language: LengthLanguage;
  readonly localize: (language: LengthLanguage, messages: { zh: string; en: string }) => string;
}): Promise<void> {
  const storyDir = join(params.bookDir, "story");
  const driftPath = join(storyDir, "audit_drift.md");
  const statePath = join(storyDir, "current_state.md");
  const currentState = await readFile(statePath, "utf-8").catch(() => "");
  const sanitizedState = stripAuditDriftCorrectionBlock(currentState).trimEnd();

  if (sanitizedState !== currentState) {
    await writeFile(statePath, sanitizedState, "utf-8");
  }

  if (params.issues.length === 0) {
    await rm(driftPath, { force: true }).catch(() => undefined);
    return;
  }

  const block = [
    params.localize(params.language, { zh: "# 审计纠偏", en: "# Audit Drift" }),
    "",
    params.localize(params.language, {
      zh: "## 审计纠偏（自动生成，下一章写作前参照）",
      en: "## Audit Drift Correction",
    }),
    "",
    params.localize(params.language, {
      zh: `> 第${params.chapterNumber}章审计发现以下问题，下一章写作时必须避免：`,
      en: `> Chapter ${params.chapterNumber} audit found the following issues to avoid in the next chapter:`,
    }),
    ...params.issues.map((issue) => `> - [${issue.severity}] ${issue.category}: ${issue.description}`),
    "",
  ].join("\n");

  await writeFile(driftPath, block, "utf-8");
}

export function stripAuditDriftCorrectionBlock(currentState: string): string {
  const headers = [
    "## 审计纠偏（自动生成，下一章写作前参照）",
    "## Audit Drift Correction",
    "# 审计纠偏",
    "# Audit Drift",
  ];
  let cutIndex = -1;
  for (const header of headers) {
    const index = currentState.indexOf(header);
    if (index >= 0 && (cutIndex < 0 || index < cutIndex)) {
      cutIndex = index;
    }
  }
  if (cutIndex < 0) {
    return currentState;
  }
  return currentState.slice(0, cutIndex).trimEnd();
}

// ── Book status ──

export async function markBookActiveIfNeeded(
  bookId: string,
  deps: { loadBookConfig: (id: string) => Promise<{ status: string }>; saveBookConfig: (id: string, config: Record<string, unknown>) => Promise<void> },
): Promise<void> {
  const book = await deps.loadBookConfig(bookId);
  if (book.status !== "outlining") return;
  await deps.saveBookConfig(bookId, {
    ...book,
    status: "active",
    updatedAt: new Date().toISOString(),
  });
}

// ── Length telemetry ──

export function buildLengthWarnings(
  chapterNumber: number,
  finalCount: number,
  lengthSpec: LengthSpec,
  localize: (language: LengthLanguage, messages: { zh: string; en: string }) => string,
  languageFromLengthSpec: (lengthSpec: Pick<LengthSpec, "countingMode">) => LengthLanguage,
): string[] {
  if (!isOutsideHardRange(finalCount, lengthSpec)) {
    return [];
  }
  return [
    localize(languageFromLengthSpec(lengthSpec), {
      zh: `第${chapterNumber}章经过一次字数归一化后仍超出硬区间（${lengthSpec.hardMin}-${lengthSpec.hardMax}，实际 ${finalCount}）。`,
      en: `Chapter ${chapterNumber} remains outside hard range (${lengthSpec.hardMin}-${lengthSpec.hardMax}, actual ${finalCount}) after a single normalization pass.`,
    }),
  ];
}

export function buildLengthTelemetry(params: {
  lengthSpec: LengthSpec;
  writerCount: number;
  postWriterNormalizeCount: number;
  postReviseCount: number;
  finalCount: number;
  normalizeApplied: boolean;
  lengthWarning: boolean;
}): LengthTelemetry {
  return {
    target: params.lengthSpec.target,
    softMin: params.lengthSpec.softMin,
    softMax: params.lengthSpec.softMax,
    hardMin: params.lengthSpec.hardMin,
    hardMax: params.lengthSpec.hardMax,
    countingMode: params.lengthSpec.countingMode,
    writerCount: params.writerCount,
    postWriterNormalizeCount: params.postWriterNormalizeCount,
    postReviseCount: params.postReviseCount,
    finalCount: params.finalCount,
    normalizeApplied: params.normalizeApplied,
    lengthWarning: params.lengthWarning,
  };
}

export function logLengthWarnings(
  lengthWarnings: ReadonlyArray<string>,
  logger?: Pick<Logger, "warn">,
): void {
  for (const warning of lengthWarnings) {
    logger?.warn(warning);
  }
}

// ── Audit issue restoration (used by review-cycle) ──

export function restoreLostAuditIssues(previous: AuditResult, next: AuditResult): AuditResult {
  if (next.passed || next.issues.length > 0 || previous.issues.length === 0) {
    return next;
  }
  return {
    ...next,
    issues: previous.issues,
    summary: next.summary || previous.summary,
  };
}
