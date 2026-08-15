/**
 * Bridge between Electron main process and @inkrhyme/core's PipelineRunner.
 *
 * This module isolates all core-engine imports so the rest of the main
 * process stays thin. It exposes a small facade that the IPC layer calls.
 */
import {
  PipelineRunner,
  StateManager,
  createLLMClient,
  createLogger,
  createStderrSink,
  resolveEffectiveLLMConfig,
  loadLLMEnvLayers,
  resolveChapterReviewMode,
  IndexDB,
  type ProjectConfig,
  type PipelineConfig,
  type ChapterPipelineResult,
} from "@inkrhyme/core";

export interface BookInfo {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chapterCount: number;
}

export interface WriteChapterResult {
  readonly chapterNumber: number;
  readonly title: string;
  readonly wordCount: number;
  readonly auditPassed: boolean;
  readonly revised: boolean;
  readonly status: string;
}

export interface PipelineBridgeOptions {
  readonly projectRoot: string;
  readonly onStageLog?: (stage: string, message: string) => void;
}

export class PipelineBridge {
  private readonly projectRoot: string;
  private readonly onStageLog?: (stage: string, message: string) => void;
  private config: ProjectConfig | null = null;

  constructor(options: PipelineBridgeOptions) {
    this.projectRoot = options.projectRoot;
    this.onStageLog = options.onStageLog;
  }

  /** Load (or reload) the project config from disk. */
  async loadConfig(): Promise<ProjectConfig> {
    const envLayers = await loadLLMEnvLayers(this.projectRoot);
    const result = await resolveEffectiveLLMConfig({
      consumer: "cli",
      projectRoot: this.projectRoot,
      envLayers,
      requireApiKey: false,
    });
    this.config = result.config;
    return result.config;
  }

  /** List all books in the project. */
  async listBooks(): Promise<BookInfo[]> {
    const state = new StateManager(this.projectRoot);
    const bookIds = await state.listBooks();
    const books: BookInfo[] = [];
    for (const bookId of bookIds) {
      try {
        const book = await state.loadBookConfig(bookId);
        const index = await state.loadChapterIndex(bookId);
        books.push({
          bookId,
          title: book.title ?? bookId,
          genre: book.genre,
          status: book.status,
          chapterCount: index.length,
        });
      } catch {
        // Skip books that fail to load
      }
    }
    return books;
  }

  /** Write the next chapter for a book. */
  async writeNextChapter(bookId: string, wordCount?: number): Promise<WriteChapterResult> {
    const config = this.config ?? (await this.loadConfig());
    const state = new StateManager(this.projectRoot);
    const book = await state.loadBookConfig(bookId);

    const pipelineConfig = this.buildPipelineConfig(config, book);
    const pipeline = new PipelineRunner(pipelineConfig);

    const result: ChapterPipelineResult = await pipeline.writeNextChapter(bookId, wordCount);

    // Sync to SQLite index layer for UI queries
    await this.syncToIndex(bookId);

    return {
      chapterNumber: result.chapterNumber,
      title: result.title,
      wordCount: result.wordCount,
      auditPassed: result.auditResult.passed,
      revised: result.revised,
      status: result.status,
    };
  }

  /** Sync book metadata + chapters + foreshadowing to the SQLite index. */
  private async syncToIndex(bookId: string): Promise<void> {
    try {
      const state = new StateManager(this.projectRoot);
      const book = await state.loadBookConfig(bookId);
      const bookDir = state.bookDir(bookId);
      const chapters = await state.loadChapterIndex(bookId);

      const index = new IndexDB(this.projectRoot);

      // Upsert book summary
      const totalWords = chapters.reduce((sum, ch) => sum + (ch.wordCount ?? 0), 0);
      index.upsertBook({
        bookId,
        title: book.title ?? bookId,
        genre: book.genre,
        status: book.status,
        chapterCount: chapters.length,
        totalWords,
        nextChapter: chapters.length > 0 ? chapters[chapters.length - 1]!.number + 1 : 1,
      });

      // Upsert chapters
      for (const ch of chapters) {
        index.upsertChapter({
          bookId,
          chapterNumber: ch.number,
          title: ch.title ?? "",
          status: ch.status ?? "drafting",
          wordCount: ch.wordCount ?? 0,
          createdAt: ch.createdAt ?? "",
          updatedAt: ch.updatedAt ?? "",
        });
      }

      // Rebuild foreshadowing from markdown
      await index.rebuildFromMarkdown(bookId, bookDir, {
        title: book.title ?? bookId,
        genre: book.genre,
        status: book.status,
      });

      index.close();
    } catch (err) {
      // Index sync is best-effort; don't fail the write
      this.onStageLog?.("index-sync", `Index sync skipped: ${String(err)}`);
    }
  }

  /** Query indexed chapters for a book (for UI chapter list). */
  listIndexedChapters(bookId: string): unknown[] {
    const index = new IndexDB(this.projectRoot);
    try {
      return index.listChapters(bookId);
    } finally {
      index.close();
    }
  }

  /** Query indexed foreshadowing for a book (for UI canvas/card view). */
  listIndexedForeshadowing(bookId: string, status?: string): unknown[] {
    const index = new IndexDB(this.projectRoot);
    try {
      return index.listForeshadowing(bookId, status);
    } finally {
      index.close();
    }
  }

  private buildPipelineConfig(
    config: ProjectConfig,
    book: { readonly writing?: { readonly reviewMode?: "auto" | "manual"; readonly revisionGate?: "strict" | "lenient" | "always" } },
  ): PipelineConfig {
    const sinks = [createStderrSink({ minLevel: "info" })];
    const logger = createLogger({ tag: "inkrhyme", sinks });

    const onStreamProgress = (progress: { readonly status: string; readonly totalChars: number; readonly elapsedMs: number }) => {
      if (progress.status === "streaming") {
        this.onStageLog?.("streaming", `${Math.round(progress.elapsedMs / 1000)}s, ${progress.totalChars} chars`);
      }
    };

    const onStageLog = (stage: string, message: string) => {
      this.onStageLog?.(stage, message);
    };

    return {
      client: createLLMClient(config.llm),
      model: config.llm.model,
      projectRoot: this.projectRoot,
      defaultLLMConfig: config.llm,
      foundationReviewRetries: config.foundation.reviewRetries,
      writingReviewRetries: config.writing?.reviewRetries ?? 1,
      chapterReviewMode: resolveChapterReviewMode(book, config.writing),
      modelOverrides: config.modelOverrides,
      inputGovernanceMode: config.inputGovernanceMode,
      logger,
      onStreamProgress,
      onStageLog,
    };
  }
}
