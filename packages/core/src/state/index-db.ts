/**
 * SQLite index layer for InkRhyme desktop UI queries.
 *
 * This is a READ-optimized index that mirrors metadata from markdown truth
 * files into SQLite, enabling fast structured queries for the canvas/card UI
 * (e.g., "list all foreshadowing cards", "show chapter timeline", "find
 * chapters where character X appeared").
 *
 * Design (Q8=C hybrid persistence):
 * - Markdown files remain the source of truth (written by PipelineRunner)
 * - This index is a projection: rebuilt from markdown on demand or synced
 *   on write via the syncChapterMetadata() hook
 * - The desktop UI reads from this index; it never scans markdown directly
 *
 * Uses node:sqlite (Node 22+), same as MemoryDB.
 */

import { createRequire } from "node:module";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);

export interface IndexedChapter {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly title: string;
  readonly status: string;
  readonly wordCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IndexedForeshadowing {
  readonly bookId: string;
  readonly hookId: string;
  readonly startChapter: number;
  readonly type: string;
  readonly status: string;
  readonly lastAdvancedChapter: number;
  readonly expectedPayoff: string;
  readonly notes: string;
}

export interface IndexedCharacter {
  readonly bookId: string;
  readonly name: string;
  readonly role: string;
  readonly description: string;
}

export interface BookSummary {
  readonly bookId: string;
  readonly title: string;
  readonly genre: string;
  readonly status: string;
  readonly chapterCount: number;
  readonly totalWords: number;
  readonly nextChapter: number;
}

export class IndexDB {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private db: any;

  constructor(projectRoot: string) {
    const { DatabaseSync } = require("node:sqlite");
    const indexPath = join(projectRoot, ".inkrhyme", "index.db");
    this.db = new DatabaseSync(indexPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS books (
        book_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        genre TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'incubating',
        chapter_count INTEGER NOT NULL DEFAULT 0,
        total_words INTEGER NOT NULL DEFAULT 0,
        next_chapter INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS chapters (
        book_id TEXT NOT NULL,
        chapter_number INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'drafting',
        word_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (book_id, chapter_number)
      );

      CREATE TABLE IF NOT EXISTS foreshadowing (
        book_id TEXT NOT NULL,
        hook_id TEXT NOT NULL,
        start_chapter INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planted',
        last_advanced_chapter INTEGER NOT NULL DEFAULT 0,
        expected_payoff TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (book_id, hook_id)
      );

      CREATE TABLE IF NOT EXISTS characters (
        book_id TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (book_id, name)
      );

      CREATE INDEX IF NOT EXISTS idx_chapters_book ON chapters(book_id, chapter_number);
      CREATE INDEX IF NOT EXISTS idx_foreshadowing_book ON foreshadowing(book_id, status);
      CREATE INDEX IF NOT EXISTS idx_characters_book ON characters(book_id);
    `);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  // ── Book operations ──

  upsertBook(book: BookSummary): void {
    this.db.prepare(`
      INSERT INTO books (book_id, title, genre, status, chapter_count, total_words, next_chapter, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(book_id) DO UPDATE SET
        title = excluded.title,
        genre = excluded.genre,
        status = excluded.status,
        chapter_count = excluded.chapter_count,
        total_words = excluded.total_words,
        next_chapter = excluded.next_chapter,
        updated_at = datetime('now')
    `).run(book.bookId, book.title, book.genre, book.status, book.chapterCount, book.totalWords, book.nextChapter);
  }

  listBooks(): BookSummary[] {
    const rows = this.db.prepare(`
      SELECT book_id AS bookId, title, genre, status,
             chapter_count AS chapterCount, total_words AS totalWords,
             next_chapter AS nextChapter
      FROM books ORDER BY title
    `).all();
    return rows;
  }

  // ── Chapter operations ──

  upsertChapter(ch: IndexedChapter): void {
    this.db.prepare(`
      INSERT INTO chapters (book_id, chapter_number, title, status, word_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(book_id, chapter_number) DO UPDATE SET
        title = excluded.title,
        status = excluded.status,
        word_count = excluded.word_count,
        updated_at = excluded.updated_at
    `).run(ch.bookId, ch.chapterNumber, ch.title, ch.status, ch.wordCount, ch.createdAt, ch.updatedAt);
  }

  listChapters(bookId: string): IndexedChapter[] {
    const rows = this.db.prepare(`
      SELECT book_id AS bookId, chapter_number AS chapterNumber, title, status,
             word_count AS wordCount, created_at AS createdAt, updated_at AS updatedAt
      FROM chapters WHERE book_id = ? ORDER BY chapter_number
    `).all(bookId);
    return rows;
  }

  // ── Foreshadowing operations ──

  upsertForeshadowing(f: IndexedForeshadowing): void {
    this.db.prepare(`
      INSERT INTO foreshadowing (book_id, hook_id, start_chapter, type, status, last_advanced_chapter, expected_payoff, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(book_id, hook_id) DO UPDATE SET
        start_chapter = excluded.start_chapter,
        type = excluded.type,
        status = excluded.status,
        last_advanced_chapter = excluded.last_advanced_chapter,
        expected_payoff = excluded.expected_payoff,
        notes = excluded.notes
    `).run(f.bookId, f.hookId, f.startChapter, f.type, f.status, f.lastAdvancedChapter, f.expectedPayoff, f.notes);
  }

  listForeshadowing(bookId: string, status?: string): IndexedForeshadowing[] {
    if (status) {
      return this.db.prepare(`
        SELECT book_id AS bookId, hook_id AS hookId, start_chapter AS startChapter,
               type, status, last_advanced_chapter AS lastAdvancedChapter,
               expected_payoff AS expectedPayoff, notes
        FROM foreshadowing WHERE book_id = ? AND status = ? ORDER BY start_chapter
      `).all(bookId, status);
    }
    return this.db.prepare(`
      SELECT book_id AS bookId, hook_id AS hookId, start_chapter AS startChapter,
             type, status, last_advanced_chapter AS lastAdvancedChapter,
             expected_payoff AS expectedPayoff, notes
      FROM foreshadowing WHERE book_id = ? ORDER BY start_chapter
    `).all(bookId);
  }

  // ── Character operations ──

  upsertCharacter(c: IndexedCharacter): void {
    this.db.prepare(`
      INSERT INTO characters (book_id, name, role, description)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(book_id, name) DO UPDATE SET
        role = excluded.role,
        description = excluded.description
    `).run(c.bookId, c.name, c.role, c.description);
  }

  listCharacters(bookId: string): IndexedCharacter[] {
    return this.db.prepare(`
      SELECT book_id AS bookId, name, role, description
      FROM characters WHERE book_id = ? ORDER BY name
    `).all(bookId);
  }

  // ── Full rebuild from markdown truth files ──

  async rebuildFromMarkdown(bookId: string, bookDir: string, bookConfig: {
    title: string; genre: string; status: string;
  }): Promise<void> {
    // 1. Sync book summary
    const chapters = this.listChapters(bookId);
    const totalWords = chapters.reduce((sum: number, ch: IndexedChapter) => sum + ch.wordCount, 0);
    this.upsertBook({
      bookId,
      title: bookConfig.title,
      genre: bookConfig.genre,
      status: bookConfig.status,
      chapterCount: chapters.length,
      totalWords,
      nextChapter: chapters.length > 0
        ? Math.max(...chapters.map((c: IndexedChapter) => c.chapterNumber)) + 1
        : 1,
    });

    // 2. Sync foreshadowing from pending_hooks.md
    const hooksPath = join(bookDir, "story", "pending_hooks.md");
    const hooksContent = await readFile(hooksPath, "utf-8").catch(() => "");
    if (hooksContent) {
      const hooks = parseHooksMarkdown(hooksContent);
      // Clear old hooks for this book, then re-insert
      this.db.prepare("DELETE FROM foreshadowing WHERE book_id = ?").run(bookId);
      for (const hook of hooks) {
        this.upsertForeshadowing({ ...hook, bookId });
      }
    }
  }
}

/** Parse pending_hooks.md markdown table into hook records. */
function parseHooksMarkdown(content: string): Array<Omit<IndexedForeshadowing, "bookId">> {
  const hooks: Array<Omit<IndexedForeshadowing, "bookId">> = [];
  const lines = content.split("\n");
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("|") && trimmed.includes("---")) {
      inTable = true;
      continue;
    }
    if (!inTable || !trimmed.startsWith("|")) continue;

    const cells = trimmed.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;

    // Skip header row
    if (cells[0]?.toLowerCase().includes("hook_id") || cells[0]?.includes("伏笔")) continue;

    hooks.push({
      hookId: cells[0] ?? "",
      startChapter: parseInt(cells[1] ?? "0", 10) || 0,
      type: cells[2] ?? "",
      status: cells[3] ?? "planted",
      lastAdvancedChapter: parseInt(cells[4] ?? "0", 10) || 0,
      expectedPayoff: cells[5] ?? "",
      notes: cells.slice(6).join(" "),
    });
  }

  return hooks;
}
