/** IPC channel names shared between main and renderer. */
export const IPC_CHANNELS = {
  PING: "inkrhyme:ping",
  SET_PROJECT_ROOT: "inkrhyme:setProjectRoot",
  LIST_BOOKS: "inkrhyme:listBooks",
  WRITE_NEXT_CHAPTER: "inkrhyme:writeNextChapter",
  LIST_CHAPTERS: "inkrhyme:listChapters",
  LIST_FORESHADOWING: "inkrhyme:listForeshadowing",
  PROGRESS: "inkrhyme:progress",
} as const;

/** Pipeline progress event sent from main to renderer. */
export interface ProgressEvent {
  stage: string;
  message: string;
}
