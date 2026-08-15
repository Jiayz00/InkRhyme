import { contextBridge, ipcRenderer } from "electron";

export interface BookInfo {
  bookId: string;
  title: string;
  genre: string;
  status: string;
  chapterCount: number;
}

export interface WriteChapterResult {
  chapterNumber: number;
  title: string;
  wordCount: number;
  auditPassed: boolean;
  revised: boolean;
  status: string;
}

export interface ListBooksResponse {
  ok: boolean;
  books: BookInfo[];
  error?: string;
}

export interface WriteChapterResponse {
  ok: boolean;
  result?: WriteChapterResult;
  error?: string;
}

const api = {
  /** Ping the main process to verify IPC is working. */
  ping: (): Promise<string> => ipcRenderer.invoke("inkrhyme:ping"),

  /** Set the active project root directory. */
  setProjectRoot: (root: string): Promise<{ ok: boolean; projectRoot: string }> =>
    ipcRenderer.invoke("inkrhyme:setProjectRoot", root),

  /** List books in the current project. */
  listBooks: (projectRoot?: string): Promise<ListBooksResponse> =>
    ipcRenderer.invoke("inkrhyme:listBooks", projectRoot),

  /** Write the next chapter for a book. */
  writeNextChapter: (bookId: string, wordCount?: number, projectRoot?: string): Promise<WriteChapterResponse> =>
    ipcRenderer.invoke("inkrhyme:writeNextChapter", bookId, wordCount, projectRoot),

  /** Query indexed chapters (SQLite index layer). */
  listChapters: (bookId: string, projectRoot?: string): Promise<{ ok: boolean; chapters: unknown[]; error?: string }> =>
    ipcRenderer.invoke("inkrhyme:listChapters", bookId, projectRoot),

  /** Query indexed foreshadowing (SQLite index layer). */
  listForeshadowing: (bookId: string, status: string | undefined, projectRoot?: string): Promise<{ ok: boolean; foreshadowing: unknown[]; error?: string }> =>
    ipcRenderer.invoke("inkrhyme:listForeshadowing", bookId, status, projectRoot),

  /** Subscribe to pipeline progress events. */
  onProgress: (callback: (event: { stage: string; message: string }) => void): (() => void) => {
    const listener = (_event: unknown, data: { stage: string; message: string }) => callback(data);
    ipcRenderer.on("inkrhyme:progress", listener);
    return () => ipcRenderer.removeListener("inkrhyme:progress", listener);
  },
};

contextBridge.exposeInMainWorld("inkrhyme", api);
