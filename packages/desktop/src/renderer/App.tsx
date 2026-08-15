import { useState, useEffect, useCallback } from "react";

/** Type for the IPC bridge exposed by the preload script. */
interface BookInfo {
  bookId: string;
  title: string;
  genre: string;
  status: string;
  chapterCount: number;
}

interface WriteChapterResult {
  chapterNumber: number;
  title: string;
  wordCount: number;
  auditPassed: boolean;
  revised: boolean;
  status: string;
}

interface InkRhymeBridge {
  ping(): Promise<string>;
  setProjectRoot(root: string): Promise<{ ok: boolean; projectRoot: string }>;
  listBooks(projectRoot?: string): Promise<{ ok: boolean; books: BookInfo[]; error?: string }>;
  writeNextChapter(bookId: string, wordCount?: number, projectRoot?: string): Promise<{ ok: boolean; result?: WriteChapterResult; error?: string }>;
  onProgress(callback: (event: { stage: string; message: string }) => void): () => void;
}

declare global {
  interface Window {
    inkrhyme: InkRhymeBridge;
  }
}

export function App() {
  const [status, setStatus] = useState("Connecting to main process…");
  const [projectRoot, setProjectRoot] = useState("");
  const [books, setBooks] = useState<BookInfo[]>([]);
  const [selectedBook, setSelectedBook] = useState<string>("");
  const [progress, setProgress] = useState<string[]>([]);
  const [writing, setWriting] = useState(false);
  const [lastResult, setLastResult] = useState<string>("");

  useEffect(() => {
    window.inkrhyme
      .ping()
      .then((msg) => setStatus(msg))
      .catch((err) => setStatus(`IPC error: ${err}`));

    const unsubscribe = window.inkrhyme.onProgress((event) => {
      setProgress((prev) => [...prev, `[${event.stage}] ${event.message}`]);
    });
    return unsubscribe;
  }, []);

  const handleLoadBooks = useCallback(async () => {
    if (!projectRoot) return;
    setProgress([]);
    setStatus(`Loading books from ${projectRoot}…`);
    const result = await window.inkrhyme.listBooks(projectRoot);
    if (result.ok) {
      setBooks(result.books);
      if (result.books.length > 0) {
        setSelectedBook(result.books[0].bookId);
        setStatus(`Found ${result.books.length} book(s)`);
      } else {
        setStatus("No books found in project");
      }
    } else {
      setStatus(`Error: ${result.error}`);
      setBooks([]);
    }
  }, [projectRoot]);

  const handleWriteChapter = useCallback(async () => {
    if (!selectedBook || !projectRoot) return;
    setWriting(true);
    setProgress([]);
    setLastResult("");
    setStatus(`Writing next chapter for "${selectedBook}"…`);

    const result = await window.inkrhyme.writeNextChapter(selectedBook, 3000, projectRoot);
    setWriting(false);

    if (result.ok && result.result) {
      const r = result.result;
      setLastResult(
        `Chapter ${r.chapterNumber}: "${r.title}" — ${r.wordCount} words, audit: ${r.auditPassed ? "PASS" : "FAIL"}, revised: ${r.revised}, status: ${r.status}`,
      );
      setStatus(`Chapter ${r.chapterNumber} written successfully`);
      // Refresh book list to update chapter count
      handleLoadBooks();
    } else {
      setLastResult(`Error: ${result.error}`);
      setStatus("Write failed");
    }
  }, [selectedBook, projectRoot, handleLoadBooks]);

  return (
    <div className="app">
      <header className="app-header">
        <h1>InkRhyme</h1>
        <span className="status">{status}</span>
      </header>
      <main className="app-main">
        <div className="toolbar">
          <input
            type="text"
            placeholder="Project root path (e.g. D:\inkos)"
            value={projectRoot}
            onChange={(e) => setProjectRoot(e.target.value)}
            className="path-input"
          />
          <button onClick={handleLoadBooks} disabled={!projectRoot}>
            Load Books
          </button>
        </div>

        {books.length > 0 && (
          <div className="book-list">
            <label>
              Book:{" "}
              <select value={selectedBook} onChange={(e) => setSelectedBook(e.target.value)}>
                {books.map((b) => (
                  <option key={b.bookId} value={b.bookId}>
                    {b.title} ({b.genre}) — {b.chapterCount} chapters
                  </option>
                ))}
              </select>
            </label>
            <button onClick={handleWriteChapter} disabled={!selectedBook || writing}>
              {writing ? "Writing…" : "Write Next Chapter"}
            </button>
          </div>
        )}

        {lastResult && <div className="result">{lastResult}</div>}

        <div className="progress-log">
          {progress.length === 0 ? (
            <p className="placeholder">Pipeline events will appear here.</p>
          ) : (
            progress.map((line, i) => <p key={i}>{line}</p>)
          )}
        </div>
      </main>
    </div>
  );
}
