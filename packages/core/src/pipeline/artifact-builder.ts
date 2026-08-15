/**
 * Artifact builder — prepares write input and governed artifacts.
 *
 * Extracted from PipelineRunner. These functions handle:
 * - prepareWriteInput: assemble chapter intent + context package + rule stack
 * - createGovernedArtifacts: planner + composer → plan + composed output
 * - resolveGovernedPlan: planner LLM call (with persisted-plan reuse)
 * - buildPersistenceOutput: re-analyze chapter content via ChapterAnalyzerAgent
 *
 * They are pure functions that receive dependencies via params.
 */
import type { BookConfig } from "../models/book.js";
import type { ContextPackage, RuleStack } from "../models/input-governance.js";
import type { ContextCompressionCallback } from "../models/context-compression.js";
import type { WriteChapterInput, WriteChapterOutput } from "../agents/writer.js";
import { PlannerAgent, type PlanChapterOutput } from "../agents/planner.js";
import { ComposerAgent, composeGovernedChapter, contextBudgetFromClient, type ComposeChapterOutput } from "../agents/composer.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { loadPersistedPlan, savePersistedPlan } from "./persisted-governed-plan.js";
import { countChapterLength } from "../utils/length-metrics.js";
import type { AgentContext } from "../agents/base.js";

export interface ArtifactBuilderDeps {
  readonly inputGovernanceMode?: string;
  readonly onContextCompression?: ContextCompressionCallback;
  readonly agentCtxFor: (agent: string, bookId?: string) => AgentContext;
}

export type PreparedWriteInput = Pick<
  WriteChapterInput,
  "externalContext" | "chapterIntent" | "chapterMemo" | "chapterIntentData" | "contextPackage" | "ruleStack"
>;

export async function prepareWriteInput(
  book: BookConfig,
  bookDir: string,
  chapterNumber: number,
  externalContext: string | undefined,
  deps: ArtifactBuilderDeps,
): Promise<PreparedWriteInput> {
  if ((deps.inputGovernanceMode ?? "v2") === "legacy") {
    return { externalContext };
  }

  const { plan, composed } = await createGovernedArtifacts(
    book,
    bookDir,
    chapterNumber,
    externalContext,
    deps,
    { reuseExistingIntentWhenContextMissing: true },
  );

  return {
    externalContext,
    chapterIntent: plan.intentMarkdown,
    chapterMemo: plan.memo,
    chapterIntentData: plan.intent,
    contextPackage: composed.contextPackage,
    ruleStack: composed.ruleStack,
  };
}

export async function createGovernedArtifacts(
  book: BookConfig,
  bookDir: string,
  chapterNumber: number,
  externalContext: string | undefined,
  deps: ArtifactBuilderDeps,
  options?: {
    readonly reuseExistingIntentWhenContextMissing?: boolean;
  },
): Promise<{
  plan: PlanChapterOutput;
  composed: ComposeChapterOutput;
}> {
  const plan = await resolveGovernedPlan(book, bookDir, chapterNumber, externalContext, deps, options);
  const composerCtx = deps.agentCtxFor("composer", book.id);
  const composer = new ComposerAgent(composerCtx);
  const composed = await composeGovernedChapter({
    book,
    bookDir,
    chapterNumber,
    plan,
    contextBudget: contextBudgetFromClient(composerCtx.client),
    compressibleContextCompiler: (request) => composer.compileCompressibleContext(request),
    onContextCompression: deps.onContextCompression,
  });

  return { plan, composed };
}

export async function resolveGovernedPlan(
  book: BookConfig,
  bookDir: string,
  chapterNumber: number,
  externalContext: string | undefined,
  deps: ArtifactBuilderDeps,
  options?: {
    readonly reuseExistingIntentWhenContextMissing?: boolean;
  },
): Promise<PlanChapterOutput> {
  if (
    options?.reuseExistingIntentWhenContextMissing &&
    (!externalContext || externalContext.trim().length === 0)
  ) {
    const persisted = await loadPersistedPlan(bookDir, chapterNumber);
    if (persisted) return persisted;
  }

  const planner = new PlannerAgent(deps.agentCtxFor("planner", book.id));
  const plan = await planner.planChapter({
    book,
    bookDir,
    chapterNumber,
    externalContext,
  });
  await savePersistedPlan(bookDir, plan);
  return plan;
}

export async function buildPersistenceOutput(
  bookId: string,
  book: BookConfig,
  bookDir: string,
  chapterNumber: number,
  output: WriteChapterOutput,
  finalContent: string,
  countingMode: Parameters<typeof countChapterLength>[1],
  reducedControlInput: { chapterIntent: string; contextPackage: ContextPackage; ruleStack: RuleStack } | undefined,
  deps: ArtifactBuilderDeps,
): Promise<WriteChapterOutput> {
  if (finalContent === output.content) {
    return output;
  }

  const analyzer = new ChapterAnalyzerAgent(deps.agentCtxFor("chapter-analyzer", bookId));
  const analyzed = await analyzer.analyzeChapter({
    book,
    bookDir,
    chapterNumber,
    chapterContent: finalContent,
    chapterTitle: output.title,
    chapterIntent: reducedControlInput?.chapterIntent,
    contextPackage: reducedControlInput?.contextPackage,
    ruleStack: reducedControlInput?.ruleStack,
  });

  return {
    ...analyzed,
    content: finalContent,
    wordCount: countChapterLength(finalContent, countingMode),
    postWriteErrors: [],
    postWriteWarnings: [],
    hookHealthIssues: output.hookHealthIssues,
    tokenUsage: output.tokenUsage,
  };
}
