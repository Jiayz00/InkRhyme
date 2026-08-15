import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { BrowserWindow } from "electron";
import { PipelineBridge, type BookInfo, type WriteChapterResult } from "./pipeline-bridge.js";
import { IPC_CHANNELS, type ProgressEvent } from "../shared/ipc-channels.js";

/**
 * Track the active project root and bridge instance.
 * In Phase 1, the project root is set via IPC (renderer sends path).
 * Later phases will add a project picker dialog.
 */
let activeBridge: PipelineBridge | null = null;
let activeProjectRoot: string | null = null;

function getOrCreateBridge(
  event: IpcMainInvokeEvent,
  projectRoot?: string,
): PipelineBridge {
  const root = projectRoot ?? activeProjectRoot ?? process.cwd();

  if (activeBridge && activeProjectRoot === root) {
    return activeBridge;
  }

  const win = BrowserWindow.fromWebContents(event.sender);
  const onStageLog = (stage: string, message: string) => {
    const progressEvent: ProgressEvent = { stage, message };
    win?.webContents.send(IPC_CHANNELS.PROGRESS, progressEvent);
  };

  activeBridge = new PipelineBridge({ projectRoot: root, onStageLog });
  activeProjectRoot = root;
  return activeBridge;
}

/** Register InkRhyme IPC handlers on the main process. */
export function registerIpcHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_CHANNELS.PING, async () => {
    return "InkRhyme IPC bridge is alive";
  });

  /** Set the active project root. */
  ipcMain.handle("inkrhyme:setProjectRoot", async (_event, root: string) => {
    activeProjectRoot = root;
    activeBridge = null; // Force re-creation with new root
    return { ok: true, projectRoot: root };
  });

  /** List books in the current project. */
  ipcMain.handle(IPC_CHANNELS.LIST_BOOKS, async (event, projectRoot?: string) => {
    const bridge = getOrCreateBridge(event, projectRoot);
    try {
      const books: BookInfo[] = await bridge.listBooks();
      return { ok: true, books };
    } catch (err) {
      return { ok: false, error: String(err), books: [] };
    }
  });

  /** Write the next chapter for a book. */
  ipcMain.handle(
    IPC_CHANNELS.WRITE_NEXT_CHAPTER,
    async (event, bookId: string, wordCount?: number, projectRoot?: string): Promise<{ ok: boolean; result?: WriteChapterResult; error?: string }> => {
      const bridge = getOrCreateBridge(event, projectRoot);
      try {
        const result = await bridge.writeNextChapter(bookId, wordCount);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  /** Query indexed chapters for a book (from SQLite index layer). */
  ipcMain.handle("inkrhyme:listChapters", async (event, bookId: string, projectRoot?: string) => {
    const bridge = getOrCreateBridge(event, projectRoot);
    try {
      const chapters = bridge.listIndexedChapters(bookId);
      return { ok: true, chapters };
    } catch (err) {
      return { ok: false, error: String(err), chapters: [] };
    }
  });

  /** Query indexed foreshadowing for a book (from SQLite index layer). */
  ipcMain.handle("inkrhyme:listForeshadowing", async (event, bookId: string, status: string | undefined, projectRoot?: string) => {
    const bridge = getOrCreateBridge(event, projectRoot);
    try {
      const foreshadowing = bridge.listIndexedForeshadowing(bookId, status);
      return { ok: true, foreshadowing };
    } catch (err) {
      return { ok: false, error: String(err), foreshadowing: [] };
    }
  });
}
