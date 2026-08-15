import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";

/**
 * Per-chapter memoizing cache for read-only truth files. Eliminates the
 * triple-read pattern where planner, composer, and writer each independently
 * read story_frame.md / volume_map.md / current_state.md / pending_hooks.md /
 * chapter_summaries.md / previous-chapter markdown for the same chapter.
 *
 * Scoped to a single chapter's prepare→writeChapter lifecycle via
 * withBookContextCache. A fresh cache must be used for each chapter because
 * truth files are mutated by the writer's settle (persisted via
 * saveChapter / early-persist) and by the post-write hook-promotion pass.
 *
 * The cache MUST be reset (clear()) once writeChapter returns, before any
 * post-write phase that reads mutated truths (hook promotion, early-persist,
 * validation retry via settleChapterState). Post-write sync functions use raw
 * readFile and bypass this cache regardless.
 */
export class BookContextCache {
  private readonly textCache = new Map<string, Promise<string>>();

  /** Read a file as utf-8 text, memoized by absolute path. Rejects on miss. */
  readText(path: string): Promise<string> {
    let cached = this.textCache.get(path);
    if (!cached) {
      cached = readFile(path, "utf-8");
      this.textCache.set(path, cached);
    }
    return cached;
  }

  /** Drop every memoized entry. Subsequent reads hit disk again. */
  clear(): void {
    this.textCache.clear();
  }
}

const storage = new AsyncLocalStorage<BookContextCache>();

/** Run `fn` with `cache` as the active BookContextCache. */
export function withBookContextCache<T>(
  cache: BookContextCache,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(cache, fn);
}

/** Active cache, or undefined outside a withBookContextCache scope. */
export function getActiveBookContextCache(): BookContextCache | undefined {
  return storage.getStore();
}

/**
 * Read a file as utf-8 text. Uses the active BookContextCache when available
 * (memoized by absolute path, including rejections so missing-file reads also
 * dedupe), otherwise reads directly. Rejects when the file is missing —
 * callers wrap in try/catch to apply their own fallback.
 */
export async function cachedReadFile(path: string): Promise<string> {
  const cache = getActiveBookContextCache();
  if (cache) {
    return cache.readText(path);
  }
  return readFile(path, "utf-8");
}
