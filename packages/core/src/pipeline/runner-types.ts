/**
 * Shared types for the pipeline modules.
 *
 * These types are defined here to avoid circular dependencies between
 * runner.ts and extracted modules (importer, artifact-builder, etc.).
 */
import type { ChapterMeta } from "../models/chapter.js";

export interface ImportChaptersInput {
  readonly bookId: string;
  readonly chapters: ReadonlyArray<{ readonly title: string; readonly content: string }>;
  readonly resumeFrom?: number;
  /** "continuation" (default) = pick up where the text left off, no new spacetime.
   *  "series" = shared universe but independent new story, requires new spacetime. */
  readonly importMode?: "continuation" | "series";
}

export interface ImportChaptersResult {
  readonly bookId: string;
  readonly importedCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}
