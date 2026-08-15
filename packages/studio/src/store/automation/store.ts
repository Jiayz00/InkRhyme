import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ReviewScope, WorkflowTarget } from "@inkrhyme/core/workflow";

export interface StepProgress {
  readonly chapterNumber?: number;
  readonly stepIndex: number;
  readonly totalSteps: number;
  readonly agent: string;
  readonly status: "pending" | "running" | "done" | "error";
}

export interface BatchProgress {
  readonly bookId: string;
  readonly totalChapters: number;
  completedCount: number;
  currentChapter?: number;
  failures: number;
  running: boolean;
  paused?: boolean;
  readonly workflowId?: string;
  readonly workflowName?: string;
  readonly target?: string;
  readonly scope?: ReviewScope;
}

export interface LogEntry {
  readonly event: string;
  readonly data: Record<string, unknown>;
  readonly time: string;
  readonly key: string;
}

/**
 * UI-side shape mirroring the server's AutomationExecutionSnapshot. We keep
 * a trimmed version so the frontend can restore progress / step state after
 * the user navigates away from the Automation page.
 */
export interface AutomationSnapshot {
  readonly bookId: string;
  readonly workflowId?: string;
  readonly workflowName?: string;
  readonly target?: WorkflowTarget;
  readonly scope?: ReviewScope;
  readonly totalUnits?: number;
  readonly completedCount?: number;
  readonly failures?: number;
  readonly running?: boolean;
  readonly paused?: boolean;
  readonly currentUnitLabel?: string;
  readonly currentChapterNumber?: number;
  readonly stepProgress?: StepProgress;
  readonly startedAt?: string;
  readonly updatedAt?: string;
  readonly latestError?: string;
}

interface AutomationStore {
  // ----- execution state (kept across page navigation) -----
  progress: BatchProgress | null;
  setProgress: (p: BatchProgress | null | ((prev: BatchProgress | null) => BatchProgress | null)) => void;
  stepProgress: StepProgress | null;
  setStepProgress: (s: StepProgress | null) => void;
  logs: LogEntry[];
  appendLogs: (entries: LogEntry[]) => void;
  clearLogs: () => void;

  // ----- review scope UI state (per workflow target defaults) -----
  reviewScope: Record<string, ReviewScope>;
  setReviewScope: (target: WorkflowTarget, scope: ReviewScope) => void;
  resetReviewScope: (target: WorkflowTarget) => void;

  // ----- latest snapshot from the server (for cold restores) -----
  lastSnapshot: AutomationSnapshot | null;
  applySnapshot: (snap: AutomationSnapshot) => void;
  clear: () => void;

  // ----- skill selection (persisted across page navigation) -----
  selectedSkills: string[];
  setSelectedSkills: (skills: string[]) => void;
}

const DEFAULT_SCOPE_BOILER: Record<string, ReviewScope> = {};

/**
 * Persisted to localStorage so a page refresh or navigation away from the
 * Automation page does not lose execution progress, logs, or skill selection.
 * The server snapshot (fetched on mount via /executions/current) remains the
 * source of truth and will overwrite these values once the page loads.
 */
const PERSISTED_KEYS = [
  "progress",
  "stepProgress",
  "logs",
  "reviewScope",
  "lastSnapshot",
  "selectedSkills",
] as const;

export const useAutomationStore = create<AutomationStore>()(
  persist(
    (set, get) => ({
      progress: null,
      setProgress: (p) =>
        set({
          progress:
            typeof p === "function" ? (p as (prev: BatchProgress | null) => BatchProgress | null)(get().progress) : p,
        }),
      stepProgress: null,
      setStepProgress: (s) => set({ stepProgress: s }),
      logs: [],
      appendLogs: (entries) =>
        set({
          logs: [...get().logs, ...entries].slice(-300),
        }),
      clearLogs: () => set({ logs: [] }),

      reviewScope: DEFAULT_SCOPE_BOILER,
      setReviewScope: (target, scope) =>
        set({
          reviewScope: { ...get().reviewScope, [target]: scope },
        }),
      resetReviewScope: (target) =>
        set((state) => {
          const next = { ...state.reviewScope };
          delete next[target];
          return { reviewScope: next };
        }),

      lastSnapshot: null,
      applySnapshot: (snap) => set({ lastSnapshot: snap }),
      clear: () =>
        set({
          progress: null,
          stepProgress: null,
          logs: [],
          lastSnapshot: null,
        }),

      selectedSkills: [],
      setSelectedSkills: (skills) => set({ selectedSkills: skills }),
    }),
    {
      name: "inkos.automation.store",
      partialize: (state) => {
        const picked: Record<string, unknown> = {};
        const source = state as unknown as Record<string, unknown>;
        for (const key of PERSISTED_KEYS) {
          picked[key] = source[key];
        }
        return picked;
      },
    },
  ),
);
