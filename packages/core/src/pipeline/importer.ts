/**
 * Importer — chapter replay import pipeline.
 *
 * Extracted from PipelineRunner. Handles:
 * - buildImportFoundationSource: compress chapters into foundation context
 * - buildSpinoffFoundationContext: frame side-story foundation context
 * - importChapters: generate foundation + sequential chapter replay
 * - resetImportReplayTruthFiles / buildImportReplayStateSeed / buildImportReplayHooksSeed
 *
 * importChapters is a high-level orchestration that delegates to many
 * PipelineRunner methods via a dependency interface.
 */
import { ArchitectAgent } from "../agents/architect.js";
import { FoundationReviewerAgent } from "../agents/foundation-reviewer.js";
import { ChapterAnalyzerAgent } from "../agents/chapter-analyzer.js";
import { WriterAgent, type WriteChapterOutput } from "../agents/writer.js";
import { countChapterLength, formatLengthCount, resolveLengthCountingMode, type LengthLanguage } from "../utils/length-metrics.js";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ChapterMeta } from "../models/chapter.js";
import type { ImportChaptersInput, ImportChaptersResult } from "./runner-types.js";

// ── Types re-exported for compatibility ──
export type { ImportChaptersInput, ImportChaptersResult };
// ── File-level helper functions (previously in runner.ts) ──

interface ImportFoundationSourceOptions {
  readonly maxFullTextChars?: number;
  readonly chapterExcerptChars?: number;
  readonly titleCatalogChars?: number;
  readonly edgeChapterCount?: number;
  readonly middleAnchorCount?: number;
}

const DEFAULT_IMPORT_FOUNDATION_MAX_FULL_TEXT_CHARS = 80_000;
const DEFAULT_IMPORT_CHAPTER_EXCERPT_CHARS = 6_000;
const DEFAULT_IMPORT_TITLE_CATALOG_CHARS = 24_000;
const DEFAULT_IMPORT_EDGE_CHAPTER_COUNT = 4;
const DEFAULT_IMPORT_MIDDLE_ANCHOR_COUNT = 8;

function formatImportedChapter(
  chapter: { readonly title: string; readonly content: string },
  index: number,
  language: LengthLanguage,
  content = chapter.content,
): string {
  return language === "en"
    ? `Chapter ${index + 1}: ${chapter.title}\n\n${content}`
    : `第${index + 1}章 ${chapter.title}\n\n${content}`;
}

function estimateImportFullTextLength(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
): number {
  return chapters.reduce((total, chapter) => total + chapter.title.length + chapter.content.length + 24, 0);
}

function excerptHeadTail(text: string, maxChars: number, language: LengthLanguage): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  const headChars = Math.max(200, Math.floor(maxChars * 0.6));
  const tailChars = Math.max(200, maxChars - headChars);
  const omitted = clean.length - headChars - tailChars;
  const marker = language === "en"
    ? `\n\n[... ${omitted} chars omitted for import-context budget ...]\n\n`
    : `\n\n【中间省略 ${omitted} 字，用于控制导入上下文预算】\n\n`;
  return `${clean.slice(0, headChars).trimEnd()}${marker}${clean.slice(-tailChars).trimStart()}`;
}

function pickImportAnchorIndexes(
  chapterCount: number,
  edgeChapterCount: number,
  middleAnchorCount: number,
): ReadonlyArray<number> {
  const selected = new Set<number>();
  for (let i = 0; i < Math.min(edgeChapterCount, chapterCount); i++) selected.add(i);
  for (let i = Math.max(0, chapterCount - edgeChapterCount); i < chapterCount; i++) selected.add(i);

  const middleStart = Math.min(edgeChapterCount, chapterCount);
  const middleEnd = Math.max(middleStart, chapterCount - edgeChapterCount);
  const middleSize = middleEnd - middleStart;
  const anchors = Math.min(middleAnchorCount, middleSize);
  for (let i = 0; i < anchors; i++) {
    const offset = Math.floor(((i + 1) * middleSize) / (anchors + 1));
    selected.add(Math.min(chapterCount - 1, middleStart + offset));
  }

  return [...selected].sort((a, b) => a - b);
}

function buildTitleCatalog(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
  maxChars: number,
): string {
  const lines = chapters.map((chapter, index) =>
    language === "en"
      ? `- Chapter ${index + 1}: ${chapter.title} (${chapter.content.length} chars)`
      : `- 第${index + 1}章：${chapter.title}（${chapter.content.length}字）`,
  );
  const joined = lines.join("\n");
  if (joined.length <= maxChars) return joined;

  const headBudget = Math.floor(maxChars * 0.55);
  const tailBudget = maxChars - headBudget;
  const head: string[] = [];
  const tail: string[] = [];
  let headChars = 0;
  let tailChars = 0;
  for (const line of lines) {
    if (headChars + line.length + 1 > headBudget) break;
    head.push(line);
    headChars += line.length + 1;
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (tailChars + line.length + 1 > tailBudget) break;
    tail.unshift(line);
    tailChars += line.length + 1;
  }
  const omitted = lines.length - head.length - tail.length;
  const marker = language === "en"
    ? `- ... ${omitted} chapter titles omitted ...`
    : `- ……中间 ${omitted} 个章节标题省略……`;
  return [...head, marker, ...tail].join("\n");
}

export function buildSpinoffFoundationContext(
  parentCanon: string,
  direction: string | undefined,
  language: "zh" | "en",
): string {
  const dir = direction?.trim();
  if (language === "en") {
    return [
      "## This is a SIDE-STORY (番外)",
      "Reuse the established characters, world, and rules from the parent canon below. Tell an INDEPENDENT side plot — a bonus arc, a character backstory, or a what-if — that does NOT advance or contradict the parent work's main storyline.",
      dir ? `\n## Side-story direction\n${dir}` : "",
      `\n## Parent canon (reuse these characters and settings)\n${parentCanon}`,
    ].filter(Boolean).join("\n");
  }
  return [
    "## 这是一部番外",
    "复用下方正传正典里已确立的角色、世界观与规则。讲一个独立的侧篇故事——支线、角色前传或 what-if——不要推进或违背正传的主线剧情。",
    dir ? `\n## 番外方向\n${dir}` : "",
    `\n## 正传正典（复用以下角色与设定）\n${parentCanon}`,
  ].filter(Boolean).join("\n");
}

export function buildImportFoundationSource(
  chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>,
  language: LengthLanguage,
  options: ImportFoundationSourceOptions = {},
): string {
  const maxFullTextChars = options.maxFullTextChars ?? DEFAULT_IMPORT_FOUNDATION_MAX_FULL_TEXT_CHARS;
  const chapterExcerptChars = options.chapterExcerptChars ?? DEFAULT_IMPORT_CHAPTER_EXCERPT_CHARS;
  const titleCatalogChars = options.titleCatalogChars ?? DEFAULT_IMPORT_TITLE_CATALOG_CHARS;
  const edgeChapterCount = options.edgeChapterCount ?? DEFAULT_IMPORT_EDGE_CHAPTER_COUNT;
  const middleAnchorCount = options.middleAnchorCount ?? DEFAULT_IMPORT_MIDDLE_ANCHOR_COUNT;

  if (estimateImportFullTextLength(chapters) <= maxFullTextChars) {
    return chapters.map((chapter, index) => formatImportedChapter(chapter, index, language)).join("\n\n---\n\n");
  }

  const anchorIndexes = pickImportAnchorIndexes(chapters.length, edgeChapterCount, middleAnchorCount);
  const header = language === "en"
    ? [
        "## Import foundation source package",
        "",
        `The imported book has ${chapters.length} chapters. To avoid overflowing the LLM context, this package keeps the opening chapters, ending/continuation point, selected middle anchors, and a capped title catalog. Full chapters will still be replayed sequentially after foundation generation to rebuild truth files.`,
      ].join("\n")
    : [
        "## 导入基础设定压缩资料包",
        "",
        `本次导入共 ${chapters.length} 章。为避免超出 LLM 上下文，这里保留开篇、结尾续写点、少量中段锚点和标题目录；完整章节将在后续顺序回放中逐章分析并沉淀 truth files。`,
      ].join("\n");
  const catalogTitle = language === "en" ? "## Capped chapter title catalog" : "## 章节标题目录（截断）";
  const anchorsTitle = language === "en" ? "## Source excerpts for architecture" : "## 用于反推基础设定的正文摘录";
  const anchorText = anchorIndexes
    .map((index) => {
      const chapter = chapters[index]!;
      return formatImportedChapter(
        chapter,
        index,
        language,
        excerptHeadTail(chapter.content, chapterExcerptChars, language),
      );
    })
    .join("\n\n---\n\n");

  return [
    header,
    "",
    catalogTitle,
    buildTitleCatalog(chapters, language, titleCatalogChars),
    "",
    anchorsTitle,
    anchorText,
  ].join("\n");
}

// ── Truth file reset helpers ──

export async function resetImportReplayTruthFiles(
  bookDir: string,
  language: LengthLanguage,
): Promise<void> {
  const storyDir = join(bookDir, "story");

  await Promise.all([
    writeFile(
      join(storyDir, "current_state.md"),
      buildImportReplayStateSeed(language),
      "utf-8",
    ),
    writeFile(
      join(storyDir, "pending_hooks.md"),
      buildImportReplayHooksSeed(language),
      "utf-8",
    ),
    rm(join(storyDir, "chapter_summaries.md"), { force: true }),
    rm(join(storyDir, "subplot_board.md"), { force: true }),
    rm(join(storyDir, "emotional_arcs.md"), { force: true }),
    rm(join(storyDir, "character_matrix.md"), { force: true }),
    rm(join(storyDir, "volume_summaries.md"), { force: true }),
    rm(join(storyDir, "particle_ledger.md"), { force: true }),
    rm(join(storyDir, "memory.db"), { force: true }),
    rm(join(storyDir, "memory.db-shm"), { force: true }),
    rm(join(storyDir, "memory.db-wal"), { force: true }),
    rm(join(storyDir, "state"), { recursive: true, force: true }),
    rm(join(storyDir, "snapshots"), { recursive: true, force: true }),
  ]);
}

function buildImportReplayStateSeed(language: LengthLanguage): string {
  if (language === "en") {
    return [
      "# Current State",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Current Chapter | 0 |",
      "| Current Location | (not set) |",
      "| Protagonist State | (not set) |",
      "| Current Goal | (not set) |",
      "| Current Constraint | (not set) |",
      "| Current Alliances | (not set) |",
      "| Current Conflict | (not set) |",
      "",
    ].join("\n");
  }

  return [
    "# 当前状态",
    "",
    "| 字段 | 值 |",
    "| --- | --- |",
    "| 当前章节 | 0 |",
    "| 当前位置 | （未设定） |",
    "| 主角状态 | （未设定） |",
    "| 当前目标 | （未设定） |",
    "| 当前限制 | （未设定） |",
    "| 当前敌我 | （未设定） |",
    "| 当前冲突 | （未设定） |",
    "",
  ].join("\n");
}

function buildImportReplayHooksSeed(language: LengthLanguage): string {
  if (language === "en") {
    return [
      "# Pending Hooks",
      "",
      "| hook_id | start_chapter | type | status | last_advanced_chapter | expected_payoff | notes |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "",
    ].join("\n");
  }

  return [
    "# 伏笔池",
    "",
    "| hook_id | 起始章节 | 类型 | 状态 | 最近推进 | 预期回收 | 备注 |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "",
  ].join("\n");
}
