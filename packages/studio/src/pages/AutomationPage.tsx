import { fetchJson, invalidateApiPaths, postApi, putApi, useApi } from "../hooks/use-api";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  CircleHelp,
  CopyPlus,
  GripVertical,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Square,
  Trash2,
  X,
  CheckSquare,
  FileText,
  Search,
} from "lucide-react";
import type { Theme } from "../hooks/use-theme";
import type { TFunction } from "../hooks/use-i18n";
import { useColors } from "../hooks/use-colors";
import type { SSEMessage } from "../hooks/use-sse";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../components/ui/tooltip";
import {
  AGENT_CAPABILITIES,
  AGENT_ORDER,
  AGENT_PHASE_LABELS,
  BUILTIN_AGENT_NAMES,
  type BuiltinAgentName,
} from "@actalk/inkos-core/agents/builtin-names";
import {
  buildDefaultWorkflow,
  defaultReviewScope,
  makeDefaultStep,
  newStepId,
  stepsByPhase,
  validateReviewScope,
  validateWorkflowSteps,
  type ReviewScope,
  type ReviewScopeKind,
  type WorkflowDefinition,
  type WorkflowStep,
  type WorkflowTarget,
} from "@actalk/inkos-core/workflow";
import { useAutomationStore } from "../store/automation/store";

interface BookSummary {
  id: string;
  title: string;
  status: string;
  genre?: string;
  platform?: string;
  targetChapters?: number;
  chaptersWritten?: number;
  chapterWordCount?: number;
  language?: string;
}

interface ChapterMeta {
  number: number;
  title: string;
  status: string;
  wordCount: number;
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
  source?: string;
  packageId?: string;
}

interface SkillPackageSummary {
  id: string;
  name: string;
  description: string;
  source?: string;
  skillIds: string[];
}

interface BookDetail {
  book: {
    id: string;
    title: string;
    status: string;
    genre?: string;
    platform?: string;
    targetChapters?: number;
    chapterWordCount?: number;
    language?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  chapters: ChapterMeta[];
  nextChapter: number;
}

interface Nav {
  toDashboard: () => void;
  toBook?: (bookId: string) => void;
}

interface WorkflowsResponse {
  workflows: WorkflowDefinition[];
  targets: Record<WorkflowTarget, { zh: string; en: string }>;
}

const WORKFLOW_SAVE_KEY = "inkos.automation.draft";
const REVIEW_SCOPE_KEY = "inkos.automation.review-scope";
const SELECTED_BOOK_KEY = "inkos.automation.selected-book";
const CHAPTER_COUNT_KEY = "inkos.automation.chapter-count";

function loadPersistedString(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(key);
    return raw && raw.length > 0 ? raw : fallback;
  } catch {
    return fallback;
  }
}

function loadPersistedNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export function AutomationPage({ nav, theme, t, sse }: { nav: Nav; theme: Theme; t: TFunction; sse: { messages: ReadonlyArray<SSEMessage> } }) {
  const c = useColors(theme);
  const { data: booksData } = useApi<{ books: BookSummary[] }>("/books");
  const books = booksData?.books ?? [];
  const { data: wfData, error: wfError, refetch: refetchWorkflows } = useApi<WorkflowsResponse>("/workflows");
  const { data: skillsData } = useApi<{ skills: SkillSummary[]; packages: SkillPackageSummary[] }>("/skills");
  const allSkills = skillsData?.skills ?? [];
  const skillPackages = skillsData?.packages ?? [];
  // 属于某个 package 的 skill 不单独展示，由 package 统一选择
  const packagedSkillIds = new Set(skillPackages.flatMap((p) => p.skillIds));
  const standaloneSkills = allSkills.filter((s) => !packagedSkillIds.has(s.id));
  const isZh = t("nav.connected") === "已连接";
  const activeBooks = books.filter((b) => b.status === "active" || b.status === "outlining");

  // ===== Cross-page automation state (zustand store) =====
  const progress = useAutomationStore((s) => s.progress);
  const setProgress = useAutomationStore((s) => s.setProgress);
  const stepProgress = useAutomationStore((s) => s.stepProgress);
  const setStepProgress = useAutomationStore((s) => s.setStepProgress);
  const logs = useAutomationStore((s) => s.logs);
  const appendLogs = useAutomationStore((s) => s.appendLogs);
  const clearLogs = useAutomationStore((s) => s.clearLogs);
  const storedScopes = useAutomationStore((s) => s.reviewScope);
  const setReviewScope = useAutomationStore((s) => s.setReviewScope);

  // ===== UI state =====
  const [selectedBookId, setSelectedBookId] = useState(() => loadPersistedString(SELECTED_BOOK_KEY, ""));
  const [chapterCount, setChapterCount] = useState(() => loadPersistedNumber(CHAPTER_COUNT_KEY, 3));
  const [loading, setLoading] = useState(false);
  const [aborting, setAborting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const { data: bookDetail } = useApi<BookDetail>(selectedBookId ? `/books/${encodeURIComponent(selectedBookId)}` : "/books/__none__");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);

  // Validate the restored selectedBookId once the book list loads: clear it
  // if the book was deleted so we don't drive automation against a stale id.
  useEffect(() => {
    if (!selectedBookId || books.length === 0) return;
    const stillExists = books.some((b) => b.id === selectedBookId);
    if (!stillExists) setSelectedBookId("");
  }, [books, selectedBookId]);
  // Workflow editor state
  const [mode, setMode] = useState<"list" | "editor">("list");
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("builtin/fast-write");
  const [draftId, setDraftId] = useState<string>("");
  const [draftName, setDraftName] = useState<string>("");
  const [draftDesc, setDraftDesc] = useState<string>("");
  const [draftTarget, setDraftTarget] = useState<WorkflowTarget>("fast-write");
  const [draftSteps, setDraftSteps] = useState<WorkflowStep[]>([]);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  // Prevents the "load default write-chapter" effect from clobbering a
  // workflow the user has explicitly selected or restored from localStorage.
  const draftInitializedRef = useRef(false);

  // ===== Skill selection (persisted in store across page navigation) =====
  const selectedSkills = useAutomationStore((s) => s.selectedSkills);
  const setSelectedSkills = useAutomationStore((s) => s.setSelectedSkills);

  // ===== Review scope UI state (declared after draftTarget to avoid TDZ) =====
  const isReviewTarget = draftTarget === "review" || draftTarget === "review-chapters" || draftTarget === "review-foundation";
  const resolvedReviewScope: ReviewScope = useMemo(() => {
    const fromStore = storedScopes[draftTarget];
    if (fromStore) return fromStore;
    try {
      const raw = localStorage.getItem(REVIEW_SCOPE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, ReviewScope> | undefined;
        if (parsed?.[draftTarget]) return parsed[draftTarget]!;
      }
    } catch { /* ignore */ }
    return defaultReviewScope(draftTarget);
  }, [draftTarget, storedScopes]);

  // Single source of truth for review scope. Derived from the zustand store
  // (per-target) with localStorage fallback and a default per target. Every
  // input change immediately persists back so the UI never diverges from what
  // will actually be submitted to the runner.
  const reviewKind = resolvedReviewScope.kind;
  const startChapter = resolvedReviewScope.startChapter ?? 1;
  const endChapter = resolvedReviewScope.endChapter ?? 0;
  const chapterListText = resolvedReviewScope.chapterList ? resolvedReviewScope.chapterList.join(",") : "";
  const customPathsText = resolvedReviewScope.paths ? resolvedReviewScope.paths.join("\n") : "";
  const foundationTargets = resolvedReviewScope.foundationTargets ?? defaultReviewScope("review-foundation").foundationTargets ?? {};

  function buildReviewScopeForSubmit(): ReviewScope {
    // The persisted scope is already validated/normalized on every change,
    // but run a final guard here before sending it to the runner.
    const invalid = validateReviewScope(resolvedReviewScope, draftTarget);
    if (!invalid) return resolvedReviewScope;
    const fallback = defaultReviewScope(draftTarget);
    persistReviewScope(fallback);
    return fallback;
  }

  function mergeReviewScope(patch: Partial<ReviewScope>): void {
    const next: ReviewScope = { ...resolvedReviewScope, ...patch };
    persistReviewScope(next);
  }

  const persistReviewScope = (next: ReviewScope) => {
    setReviewScope(draftTarget, next);
    try {
      const raw = localStorage.getItem(REVIEW_SCOPE_KEY);
      const map: Record<string, ReviewScope> = raw ? (JSON.parse(raw) as Record<string, ReviewScope>) : {};
      map[draftTarget] = next;
      localStorage.setItem(REVIEW_SCOPE_KEY, JSON.stringify(map));
    } catch { /* ignore quota errors */ }
  };

  // ===== Default draft from builtin on first load =====
  useEffect(() => {
    if (!wfData) return;
    if (draftInitializedRef.current) return; // keep user/restored selection
    // Always default to the standard write-chapter builtin workflow. User
    // workflows are returned first by the API, so falling back to
    // workflows[0] would load a custom workflow and confuse users who expect
    // the page to start in "write chapter" mode.
    const defaultBuiltin = wfData.workflows.find((w) => w.id === "builtin/write-chapter");
    if (defaultBuiltin) {
      loadWorkflowIntoDraft(defaultBuiltin);
      draftInitializedRef.current = true;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wfData]);

  // Restore draft from localStorage if any
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WORKFLOW_SAVE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<{
        draftId: string; draftName: string; draftDesc: string; draftTarget: WorkflowTarget; draftSteps: WorkflowStep[]; selectedWorkflowId: string;
      }>;
      if (saved.draftSteps && saved.draftSteps.length > 0) {
        // Ensure enabled has a value (older localStorage drafts may lack it)
        setDraftSteps(saved.draftSteps.map((s) => ({ ...s, enabled: s.enabled ?? true })));
        const restoredTarget = saved.draftTarget ?? "write-chapter";
        setDraftId(saved.draftId ?? "");
        setDraftName(saved.draftName ?? "");
        setDraftDesc(saved.draftDesc ?? "");
        setDraftTarget(restoredTarget);
        if (saved.selectedWorkflowId) {
          setSelectedWorkflowId(saved.selectedWorkflowId);
        } else if (!saved.draftId) {
          setSelectedWorkflowId(`builtin/${restoredTarget}`);
        } else {
          setSelectedWorkflowId(saved.draftId);
        }
        draftInitializedRef.current = true;
      }
    } catch { /* ignore */ }
  }, []);

  // Persist draft on change
  useEffect(() => {
    try {
      localStorage.setItem(WORKFLOW_SAVE_KEY, JSON.stringify({
        draftId, draftName, draftDesc, draftTarget, draftSteps, selectedWorkflowId,
      }));
    } catch { /* ignore */ }
  }, [draftId, draftName, draftDesc, draftTarget, draftSteps, selectedWorkflowId]);

  // Persist selected book + chapter count so a refresh keeps the user's context
  useEffect(() => {
    try {
      if (selectedBookId) localStorage.setItem(SELECTED_BOOK_KEY, selectedBookId);
      else localStorage.removeItem(SELECTED_BOOK_KEY);
    } catch { /* ignore */ }
  }, [selectedBookId]);

  useEffect(() => {
    try {
      localStorage.setItem(CHAPTER_COUNT_KEY, String(chapterCount));
    } catch { /* ignore */ }
  }, [chapterCount]);

  function loadWorkflowIntoDraft(wf: WorkflowDefinition) {
    setSelectedWorkflowId(wf.id);
    setDraftId(wf.builtin ? "" : wf.id); // builtin ones are save-as (no id in draft until saved)
    setDraftName(wf.builtin ? `${wf.name}（副本）` : wf.name);
    setDraftDesc(wf.description ?? "");
    setDraftTarget(wf.target);
    // Assign new step ids so user edits don't collide when save-as.
    // Ensure `enabled` has a value — older saved workflows may have steps
    // without this field (JSON.stringify drops undefined), which would cause
    // enabledCount===0 (button disabled) and backend 400 "no enabled steps".
    setDraftSteps(wf.steps.map((s) => ({ ...s, id: newStepId(), enabled: s.enabled ?? true })));
    setSelectedStepId(null);
    setError(null);
    draftInitializedRef.current = true;
  }

  function resetDraftToBuiltin(target: WorkflowTarget) {
    const wf = buildDefaultWorkflow(target, `builtin/${target}`, undefined, undefined);
    setSelectedWorkflowId(wf.id);
    setDraftId(""); // builtin is save-as until explicitly saved
    setDraftTarget(target);
    setDraftName(`${wf.name}（副本）`);
    setDraftDesc(wf.description ?? "");
    setDraftSteps(wf.steps.map((s) => ({ ...s, id: newStepId(), enabled: s.enabled ?? true })));
    setSelectedStepId(null);
    setError(null);
    draftInitializedRef.current = true;
  }

  // ===== Restore latest execution snapshot on book change =====
  useEffect(() => {
    if (!selectedBookId) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchJson<{ execution: {
          bookId: string; workflowId?: string; workflowName?: string; target?: WorkflowTarget;
          scope?: ReviewScope; totalUnits?: number; completedCount?: number; failures?: number;
          running?: boolean; paused?: boolean; currentUnitLabel?: string; currentChapterNumber?: number;
          stepProgress?: { stepIndex: number; totalSteps: number; agent: string; status: any; chapterNumber?: number };
          startedAt?: string; updatedAt?: string; latestError?: string;
        } | null }>(`/executions/current?bookId=${encodeURIComponent(selectedBookId)}`);
        if (cancelled) return;
        // If the backend has no execution snapshot for this book, clear any
        // stale progress persisted in localStorage. Otherwise a paused state
        // from a previous server session would lock the UI forever (the run
        // button stays disabled because isPaused never clears).
        if (!data?.execution) {
          setProgress(null);
          setStepProgress(null);
          return;
        }
        const ex = data.execution;
        setProgress({
          bookId: ex.bookId,
          totalChapters: ex.totalUnits ?? 0,
          completedCount: ex.completedCount ?? 0,
          currentChapter: ex.currentChapterNumber,
          failures: ex.failures ?? 0,
          running: Boolean(ex.running),
          paused: Boolean(ex.paused) && !ex.running,
          workflowId: ex.workflowId,
          workflowName: ex.workflowName,
          target: ex.target,
          scope: ex.scope,
        });
        if (ex.stepProgress) {
          setStepProgress({
            chapterNumber: ex.stepProgress.chapterNumber,
            stepIndex: ex.stepProgress.stepIndex,
            totalSteps: ex.stepProgress.totalSteps,
            agent: ex.stepProgress.agent,
            status: ex.stepProgress.status ?? "done",
          });
        }
        if (!ex.running && ex.latestError) setError(ex.latestError);
        useAutomationStore.getState().applySnapshot({
          bookId: ex.bookId,
          workflowId: ex.workflowId,
          workflowName: ex.workflowName,
          target: ex.target,
          scope: ex.scope,
          totalUnits: ex.totalUnits,
          completedCount: ex.completedCount,
          failures: ex.failures,
          running: ex.running,
          paused: ex.paused,
          currentChapterNumber: ex.currentChapterNumber,
          stepProgress: ex.stepProgress,
          startedAt: ex.startedAt,
          updatedAt: ex.updatedAt,
          latestError: ex.latestError,
        });
      } catch { /* if the Studio API is down / not yet running we fall back silently */ }
    })();
    return () => { cancelled = true; };
  }, [selectedBookId]);

  // ===== SSE =====
  useEffect(() => {
    const autoEvents = sse.messages.filter((m) => m.event.startsWith("auto:"));
    if (autoEvents.length === 0) return;

    // Append new logs (store handles dedup cap). Keep a lightweight in-event
    // order key so repeated SSE reconnects don't explode the log array.
    const existingKeys = new Set(logs.map((l) => l.key));
    const added: { event: string; data: Record<string, unknown>; time: string; key: string }[] = [];
    for (const msg of autoEvents) {
      const key = `${msg.event}:${msg.timestamp}:${msg.seq}`;
      if (!existingKeys.has(key)) {
        added.push({ event: msg.event, data: msg.data as Record<string, unknown>, time: new Date().toLocaleTimeString(), key });
      }
    }
    if (added.length > 0) appendLogs(added);

    const last = autoEvents.at(-1);
    if (!last) return;
    const d = last.data as Record<string, unknown>;

    switch (last.event) {
      case "auto:start":
        setProgress({
          bookId: d.bookId as string,
          totalChapters: d.totalChapters as number,
          completedCount: d.resuming ? (d.completedCount as number | undefined) ?? 0 : 0,
          failures: 0,
          running: true,
          workflowId: d.workflowId as string | undefined,
          workflowName: d.workflowName as string | undefined,
          target: d.target as string | undefined,
          scope: d.scope as ReviewScope | undefined,
        });
        setError(null);
        break;
      case "auto:step-start":
        setStepProgress({
          chapterNumber: d.chapterNumber as number,
          stepIndex: d.stepIndex as number,
          totalSteps: d.totalSteps as number,
          agent: d.agent as string,
          status: "running",
        });
        break;
      case "auto:step-complete":
        setStepProgress({
          chapterNumber: d.chapterNumber as number,
          stepIndex: d.stepIndex as number,
          totalSteps: d.totalSteps as number,
          agent: d.agent as string,
          status: d.status === "error" ? "error" : "done",
        });
        break;
      case "auto:chapter-complete":
        setProgress((prev) => {
          if (!prev) return prev;
          const status = d.status as string;
          // Success statuses differ by workflow target:
          //   write-chapter / fast-write: ready-for-review, drafted
          //   plan-only: planned
          //   review / review-chapters / review-foundation: reviewed
          //   revision-pass / post-write-pass: reviewed
          const successStatuses = new Set(["ready-for-review", "drafted", "planned", "reviewed"]);
          const isFailure = !successStatuses.has(status);
          return {
            ...prev,
            completedCount: d.completedCount as number,
            currentChapter: d.chapterNumber as number,
            failures: prev.failures + (isFailure ? 1 : 0),
          };
        });
        // Chapter completion changes the chapter index (new chapter written,
        // status updated to audit-passed/audit-failed after review, etc.).
        // Invalidate the book list + book detail cache so the UI refetches
        // and the chapter list / progress card stay in sync with disk.
        if (d.bookId) {
          invalidateApiPaths([
            "/api/v1/books",
            `/api/v1/books/${encodeURIComponent(String(d.bookId))}`,
          ]);
        }
        break;
      case "auto:complete":
        setProgress((prev) => prev ? { ...prev, running: false, failures: d.failures as number, completedCount: d.totalCompleted as number } : prev);
        setStepProgress(null);
        setLoading(false);
        setAborting(false);
        break;
      case "auto:error":
        setProgress((prev) => prev ? { ...prev, running: false } : prev);
        setStepProgress(null);
        setError(d.error as string);
        setLoading(false);
        setAborting(false);
        break;
      case "auto:paused":
        setProgress((prev) => prev ? {
          ...prev,
          running: false,
          paused: true,
          completedCount: (d.completedCount as number) ?? prev.completedCount,
          currentChapter: (d.currentChapterNumber as number) ?? prev.currentChapter,
        } : prev);
        setStepProgress(null);
        setLoading(false);
        setAborting(false);
        break;
      case "auto:resumed":
        setProgress((prev) => prev ? { ...prev, running: true, paused: false } : prev);
        setLoading(false);
        break;
      case "auto:snapshot": {
        const snap = d as any;
        if (!snap || !snap.bookId) break;
        setProgress({
          bookId: snap.bookId,
          totalChapters: snap.totalUnits ?? 0,
          completedCount: snap.completedCount ?? 0,
          currentChapter: snap.currentChapterNumber,
          failures: snap.failures ?? 0,
          running: Boolean(snap.running),
          paused: Boolean(snap.paused) && !snap.running,
          workflowId: snap.workflowId,
          workflowName: snap.workflowName,
          target: snap.target,
          scope: snap.scope,
        });
        if (snap.stepProgress) {
          setStepProgress({
            chapterNumber: snap.stepProgress.chapterNumber,
            stepIndex: snap.stepProgress.stepIndex,
            totalSteps: snap.stepProgress.totalSteps,
            agent: snap.stepProgress.agent,
            status: snap.stepProgress.status ?? "done",
          });
        }
        if (!snap.running && snap.latestError) setError(snap.latestError);
        useAutomationStore.getState().applySnapshot({
          bookId: snap.bookId,
          workflowId: snap.workflowId,
          workflowName: snap.workflowName,
          target: snap.target,
          scope: snap.scope,
          totalUnits: snap.totalUnits,
          completedCount: snap.completedCount,
          failures: snap.failures,
          running: snap.running,
          paused: snap.paused,
          currentUnitLabel: snap.currentUnitLabel,
          currentChapterNumber: snap.currentChapterNumber,
          stepProgress: snap.stepProgress,
          startedAt: snap.startedAt,
          updatedAt: snap.updatedAt,
          latestError: snap.latestError,
        });
        break;
      }
    }
  }, [sse.messages, logs, appendLogs, setProgress, setStepProgress]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  // ===== Actions =====
  const addTempLog = (event: string, data: Record<string, unknown>) => {
    appendLogs([{ event, data, time: new Date().toLocaleTimeString(), key: `${event}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }]);
  };

  const isRunning = progress?.running ?? false;
  const isPaused = progress?.paused === true && !isRunning;

  const flashNotice = (m: string, ms = 2500) => { setNotice(m); setTimeout(() => setNotice(null), ms); };

  async function handleSaveWorkflow(): Promise<void> {
    const invalid = validateWorkflowSteps(draftSteps);
    if (invalid) { setError(invalid); return; }
    if (!draftName.trim()) { setError("请填写工作流名称"); return; }
    setSaving(true);
    setError(null);
    try {
      let def: WorkflowDefinition;
      if (draftId && !draftId.startsWith("builtin/")) {
        def = await putApi(`/workflows/${encodeURIComponent(draftId)}`, {
          name: draftName, description: draftDesc, target: draftTarget, steps: draftSteps,
        }) as WorkflowDefinition;
      } else {
        // Create new (or save-as from builtin)
        def = await postApi("/workflows", {
          id: draftId && !draftId.startsWith("builtin/") ? draftId : undefined,
          name: draftName, description: draftDesc, target: draftTarget, steps: draftSteps,
        }) as WorkflowDefinition;
      }
      setDraftId(def.id);
      setSelectedWorkflowId(def.id);
      await refetchWorkflows();
      flashNotice("工作流已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteWorkflow(): Promise<void> {
    if (!draftId || draftId.startsWith("builtin/")) { setError("内置工作流不能删除"); return; }
    setDeleting(draftId);
    try {
      await fetchJson(`/workflows/${encodeURIComponent(draftId)}`, { method: "DELETE" });
      setDraftId("");
      setSelectedWorkflowId("builtin/write-chapter");
      const wf = buildDefaultWorkflow("write-chapter", "builtin/write-chapter");
      loadWorkflowIntoDraft(wf);
      await refetchWorkflows();
      flashNotice("已删除");
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleting(null);
    }
  }

  function handleDuplicateStep(stepId: string) {
    const idx = draftSteps.findIndex((s) => s.id === stepId);
    if (idx < 0) return;
    const clone: WorkflowStep = { ...draftSteps[idx], id: newStepId(), options: { ...draftSteps[idx].options } };
    const next = [...draftSteps];
    next.splice(idx + 1, 0, clone);
    setDraftSteps(next);
  }

  function handleMoveStep(stepId: string, delta: -1 | 1) {
    const idx = draftSteps.findIndex((s) => s.id === stepId);
    const newIdx = idx + delta;
    if (idx < 0 || newIdx < 0 || newIdx >= draftSteps.length) return;
    const next = [...draftSteps];
    [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
    setDraftSteps(next);
  }

  function handleRemoveStep(stepId: string) {
    setDraftSteps((prev) => prev.filter((s) => s.id !== stepId));
    if (selectedStepId === stepId) setSelectedStepId(null);
  }

  function handleToggleStep(stepId: string) {
    setDraftSteps((prev) => prev.map((s) => s.id === stepId ? { ...s, enabled: !s.enabled } : s));
  }

  function handleSetStepAgent(stepId: string, agent: BuiltinAgentName) {
    setDraftSteps((prev) => prev.map((s) => s.id === stepId ? { ...s, agent, options: {} } : s));
  }

  function handleSetStepOption(stepId: string, key: string, value: string) {
    setDraftSteps((prev) => prev.map((s) => s.id === stepId ? { ...s, options: { ...s.options, [key]: value } } : s));
  }

  function handleAddStep() {
    // Default to the first optional agent not yet in the draft, else "auditor"
    const used = new Set(draftSteps.map((s) => s.agent));
    const candidate = AGENT_ORDER.find((a) => !used.has(a) && AGENT_CAPABILITIES[a].optional) ?? AGENT_ORDER[0];
    setDraftSteps((prev) => [...prev, makeDefaultStep(candidate as BuiltinAgentName, { enabled: true })]);
  }

  function handleWorkflowRunStart() {
    // For review targets we relax the chapterCount guard — chapters might be
    // selected via scope instead of the global chapterCount slider.
    const needsChapterCountGuard = draftTarget !== "review" && draftTarget !== "review-chapters" && draftTarget !== "review-foundation" && draftTarget !== "foundation";
    if (!selectedBookId) return;
    if (needsChapterCountGuard && (chapterCount < 1 || chapterCount > 20)) return;
    const invalid = validateWorkflowSteps(draftSteps);
    if (invalid) { setError(invalid); return; }
    setLoading(true);
    setError(null);
    clearLogs();
    setProgress(null);
    (async () => {
      try {
        // Resolve the workflow id to pass to the runner:
        //  - Custom saved workflow: use draftId, push latest edits first.
        //  - Builtin workflow: run directly by its builtin/* id; do NOT save a
        //    copy, otherwise every click creates a new custom workflow.
        //  - New unsaved draft (selectedWorkflowId empty): auto-save once.
        let workflowId: string = draftId && !draftId.startsWith("builtin/") ? draftId : "";
        if (!workflowId && selectedWorkflowId.startsWith("builtin/")) {
          workflowId = selectedWorkflowId;
        }
        if (!workflowId) {
          const def = await postApi("/workflows", {
            name: draftName || "未命名工作流",
            description: draftDesc,
            target: draftTarget,
            steps: draftSteps,
            ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
          }) as WorkflowDefinition;
          workflowId = def.id;
          setDraftId(def.id);
          setSelectedWorkflowId(def.id);
          await refetchWorkflows();
        } else if (!workflowId.startsWith("builtin/")) {
          // Save latest edits before run (builtins are virtual, no save needed)
          await putApi(`/workflows/${encodeURIComponent(workflowId)}`, {
            name: draftName, description: draftDesc, target: draftTarget, steps: draftSteps,
            ...(selectedSkills.length > 0 ? { skills: selectedSkills } : {}),
          });
          await refetchWorkflows();
        }
        const body: Record<string, unknown> = {};
        if (!needsChapterCountGuard) {
          const scope = buildReviewScopeForSubmit();
          persistReviewScope(scope);
          body.scope = scope;
        } else {
          body.chapterCount = chapterCount;
        }
        if (selectedSkills.length > 0) body.skills = selectedSkills;
        // If a previous execution is paused, starting a new run means the user
        // chose "重新开始" — tell the backend to discard the paused snapshot
        // instead of treating this as a resume.
        if (isPaused) body.forceRestart = true;
        await postApi(`/books/${encodeURIComponent(selectedBookId)}/workflow/${encodeURIComponent(workflowId)}/run`, body);
        addTempLog("auto:run-start", { workflowId, bookId: selectedBookId, ...body });
      } catch (e) {
        setError(e instanceof Error ? e.message : "启动失败");
      } finally {
        setLoading(false);
      }
    })().catch(() => { setLoading(false); });
  }

  const handleBatchWriteStart = async () => {
    if (!selectedBookId || chapterCount < 1 || chapterCount > 20) return;
    setLoading(true);
    setError(null);
    clearLogs();
    setProgress(null);
    try {
      await postApi(`/books/${selectedBookId}/write-batch`, { chapterCount, reviewMode: "strict" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
      setLoading(false);
    }
  };

  const handleUnlock = async () => {
    if (!selectedBookId) return;
    setUnlocking(true);
    try {
      const result = await postApi(`/books/${selectedBookId}/unlock`, {}) as { cleared: boolean; reason?: string };
      if (result.cleared) { setError(null); addTempLog("auto:unlock", { cleared: true }); }
      else addTempLog("auto:unlock", { cleared: false, reason: result.reason ?? "Unknown" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally { setUnlocking(false); }
  };

  const handleAbort = async () => {
    if (!selectedBookId) return;
    setAborting(true);
    try {
      await postApi(`/books/${encodeURIComponent(selectedBookId)}/automation/abort`, {});
      // Don't add a local auto:paused log — the backend SSE will broadcast
      // the real auto:paused event with completedCount/totalUnits once the
      // abort signal is processed at the next unit boundary.
    } catch (e) {
      setError(e instanceof Error ? e.message : "终止失败");
      setAborting(false);
    }
  };

  const handleResume = async () => {
    if (!selectedBookId) return;
    setLoading(true);
    setError(null);
    try {
      await postApi(`/books/${encodeURIComponent(selectedBookId)}/automation/resume`, {});
      addTempLog("auto:resumed", { bookId: selectedBookId });
    } catch (e) {
      setError(e instanceof Error ? e.message : "继续失败");
    } finally { setLoading(false); }
  };

  const isCompleted = progress && !progress.running && !progress.paused && progress.completedCount > 0;
  const phaseGroups = useMemo(() => stepsByPhase(draftSteps), [draftSteps]);
  const enabledCount = draftSteps.filter((s) => s.enabled).length;

  return (
    <div className="space-y-6">
      {/* Breadcrumb + title */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <button onClick={nav.toDashboard} className={c.link}>{t("bread.home")}</button>
          <span className="text-border">/</span>
          <span className="text-foreground">自动化工作台</span>
        </div>
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <h1 className="font-serif text-3xl flex items-center gap-2">
              <Settings2 className="text-primary" size={28} />
              自动化工作台
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              自定义写作工作流：选择目标类型，组合 Agent、调整顺序、配置参数，保存并在某本书上批量执行。
            </p>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-full bg-secondary px-2 py-1">启用步骤 {enabledCount}/{draftSteps.length}</span>
            <span className="rounded-full bg-secondary px-2 py-1">目标：{wfData?.targets?.[draftTarget]?.[isZh ? "zh" : "en"] ?? draftTarget}</span>
          </div>
        </div>
      </div>

      {notice && (
        <div className="rounded-xl bg-emerald-500/10 px-4 py-2 text-sm text-emerald-700 dark:text-emerald-300">{notice}</div>
      )}
      {error && (
        <div className="rounded-xl bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 min-w-0">
        {/* ===== Left column: workflow list / target ===== */}
        <aside className="xl:col-span-3 space-y-4 min-w-0">
          <section className={`border ${c.cardStatic} rounded-xl p-4 space-y-3`}>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">工作流模式</h2>
              <button
                onClick={() => setMode(mode === "list" ? "editor" : "list")}
                className={`text-xs px-2 py-1 rounded-md border border-border/60 text-muted-foreground hover:border-primary/40 hover:text-primary`}
              >
                {mode === "list" ? "切到编辑器" : "切到列表"}
              </button>
            </div>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">目标类型</label>
              <select
                value={draftTarget}
                disabled={isRunning || !wfData}
                onChange={(e) => resetDraftToBuiltin(e.target.value as WorkflowTarget)}
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none disabled:opacity-50"
              >
                {wfData?.targets && Object.entries(wfData.targets).map(([k, v]) => (
                  <option key={k} value={k}>{isZh ? v.zh : v.en}</option>
                ))}
              </select>
              {wfError && (
                <div className="text-xs text-destructive">加载工作流失败：{wfError}</div>
              )}
            </div>
            <button
              onClick={() => resetDraftToBuiltin(draftTarget)}
              disabled={isRunning}
              className={`w-full inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm ${c.btnSecondary} disabled:opacity-40`}
            >
              <RotateCcw size={14} /> 恢复目标默认步骤
            </button>
          </section>

          {/* ===== Skills selection ===== */}
          {(skillPackages.length > 0 || standaloneSkills.length > 0) && (
            <section className={`border ${c.cardStatic} rounded-xl p-4 space-y-2`}>
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {isZh ? "Skill 挂载" : "Skills"}
              </h2>
              <p className="text-xs text-muted-foreground">
                {isZh ? "选择整个 Skill 包或单个 Skill，运行时自动注入到写作 Agent" : "Select skill packages or individual skills"}
              </p>
              <div className="space-y-1.5 max-h-[260px] overflow-y-auto pr-1">
                {/* Skill packages — 选择整个包 */}
                {skillPackages.map((pkg) => {
                  const checked = selectedSkills.includes(pkg.id);
                  const childCount = pkg.skillIds.length;
                  return (
                    <label key={pkg.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer border ${checked ? "border-primary/40 bg-primary/5" : "border-transparent hover:border-border/40"}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isRunning}
                        onChange={() => {
                          setSelectedSkills(
                            checked
                              ? selectedSkills.filter((s) => s !== pkg.id)
                              : [...selectedSkills, pkg.id],
                          );
                        }}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium truncate">{pkg.name}</span>
                          <span className="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">
                            {isZh ? `包·${childCount} 项` : `pkg·${childCount}`}
                          </span>
                        </div>
                        <div className="text-muted-foreground truncate">{pkg.description}</div>
                      </div>
                    </label>
                  );
                })}
                {/* Standalone skills — 不属于任何 package 的单个 skill */}
                {standaloneSkills.map((skill) => {
                  const checked = selectedSkills.includes(skill.id);
                  return (
                    <label key={skill.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 text-xs cursor-pointer border ${checked ? "border-primary/40 bg-primary/5" : "border-transparent hover:border-border/40"}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isRunning}
                        onChange={() => {
                          setSelectedSkills(
                            checked
                              ? selectedSkills.filter((s) => s !== skill.id)
                              : [...selectedSkills, skill.id],
                          );
                        }}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{skill.name}</div>
                        <div className="text-muted-foreground truncate">{skill.description}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
              {selectedSkills.length > 0 && (
                <button
                  onClick={() => setSelectedSkills([])}
                  disabled={isRunning}
                  className="text-xs text-muted-foreground hover:text-primary disabled:opacity-40"
                >
                  {isZh ? `已选 ${selectedSkills.length} 项，点击清空` : `${selectedSkills.length} selected, clear`}
                </button>
              )}
            </section>
          )}

          {mode === "list" && (
            <section className={`border ${c.cardStatic} rounded-xl p-4 space-y-2`}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">工作流库</h2>
                <button
                  onClick={() => { setDraftId(""); setSelectedWorkflowId(""); setDraftName("未命名工作流"); setDraftDesc(""); setDraftSteps([]); }}
                  className="text-xs rounded-md border border-border/60 px-2 py-1 text-muted-foreground hover:border-primary/40 hover:text-primary"
                >
                  <span className="inline-flex items-center gap-1"><Plus size={12} />新建</span>
                </button>
              </div>
              <div className="space-y-1.5 max-h-[480px] overflow-y-auto pr-1">
                {(wfData?.workflows ?? []).map((w) => {
                  const active = selectedWorkflowId === w.id;
                  return (
                    <button
                      key={w.id}
                      onClick={() => loadWorkflowIntoDraft(w)}
                      className={`w-full text-left rounded-lg border p-2.5 transition-colors ${
                        active ? "border-primary/50 bg-primary/10 text-primary" : "border-border/50 bg-background/40 hover:border-primary/30 hover:bg-primary/5"
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-sm font-semibold">{w.name}</div>
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${w.builtin ? "bg-secondary text-muted-foreground" : "bg-primary/10 text-primary"}`}>
                          {w.builtin ? "内置" : "自定"}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground/80">
                        {wfData?.targets?.[w.target]?.[isZh ? "zh" : "en"] ?? w.target} · {w.steps.length} 步
                      </div>
                      {w.description && (
                        <div className="mt-1 text-[11px] line-clamp-2 text-muted-foreground">{w.description}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          )}

          {/* Save / Delete meta editor */}
          <section className={`border ${c.cardStatic} rounded-xl p-4 space-y-3`}>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">当前草稿</h2>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">名称</label>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                disabled={isRunning}
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none disabled:opacity-50"
                placeholder="例：我的标准写章流水线"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">说明（可选）</label>
              <textarea
                value={draftDesc}
                onChange={(e) => setDraftDesc(e.target.value)}
                disabled={isRunning}
                rows={3}
                className="w-full rounded-lg border border-border bg-secondary/30 px-3 py-2 text-sm outline-none disabled:opacity-50 resize-y"
                placeholder="这个工作流什么时候用、注意事项……"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={handleSaveWorkflow}
                disabled={isRunning || saving}
                className={`flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold ${c.btnPrimary} disabled:opacity-40`}
              >
                <Save size={14} /> {saving ? "保存中..." : draftId ? "保存更新" : "另存为新工作流"}
              </button>
              <button
                onClick={handleDeleteWorkflow}
                disabled={isRunning || !draftId || draftId.startsWith("builtin/") || deleting === draftId}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm border border-border text-muted-foreground hover:border-destructive hover:text-destructive transition-colors disabled:opacity-40"
              >
                <Trash2 size={14} /> {deleting === draftId ? "删除中..." : "删除"}
              </button>
            </div>
          </section>
        </aside>

        {/* ===== Middle column: step editor ===== */}
        <section className={`xl:col-span-6 border ${c.cardStatic} rounded-xl p-5 space-y-5 min-w-0`}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <h2 className="font-serif text-xl">工作流编辑器</h2>
              <p className="mt-1 text-xs text-muted-foreground">
                勾选启用、上/下拖拽排序、点击步骤卡片配置参数。灰色阶段=该步骤运行时仅占位，会在后续版本完善。
              </p>
            </div>
            <button
              onClick={handleAddStep}
              disabled={isRunning}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm ${c.btnSecondary} disabled:opacity-40`}
            >
              <Plus size={14} /> 追加步骤
            </button>
          </div>

          {draftSteps.length === 0 && (
            <div className="rounded-xl border border-dashed border-border/60 p-10 text-center">
              <p className="text-muted-foreground text-sm">还没有步骤。</p>
              <p className="mt-1 text-xs text-muted-foreground/70">点「追加步骤」或切换目标类型恢复默认。</p>
            </div>
          )}

          <div className="space-y-5">
            {phaseGroups.map(({ phase, steps }) => (
              <div key={phase} className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-semibold text-primary">
                    {isZh ? AGENT_PHASE_LABELS[phase][0] : AGENT_PHASE_LABELS[phase][1]}
                  </span>
                  <span className="h-px flex-1 bg-border/50" />
                  <span className="text-[11px] text-muted-foreground">{steps.length} 步</span>
                </div>
                <ul className="space-y-2">
                  {steps.map((s, idxInPhase) => {
                    const cap = AGENT_CAPABILITIES[s.agent];
                    const globalIdx = draftSteps.findIndex((d) => d.id === s.id);
                    const selected = selectedStepId === s.id;
                    return (
                      <li
                        key={s.id}
                        draggable={!isRunning}
                        onDragStart={() => { dragIdRef.current = s.id; }}
                        onDragOver={(e) => { e.preventDefault(); }}
                        onDrop={() => {
                          const from = dragIdRef.current;
                          dragIdRef.current = null;
                          if (!from || from === s.id) return;
                          const fromIdx = draftSteps.findIndex((x) => x.id === from);
                          if (fromIdx < 0) return;
                          const toIdx = draftSteps.findIndex((x) => x.id === s.id);
                          const next = [...draftSteps];
                          const [moved] = next.splice(fromIdx, 1);
                          next.splice(toIdx, 0, moved);
                          setDraftSteps(next);
                        }}
                        className={`group relative rounded-xl border p-3 transition-all min-w-0 ${
                          selected ? "border-primary/60 ring-1 ring-primary/20 bg-primary/5" : "border-border/60 bg-background/40"
                        } ${s.enabled ? "" : "opacity-60"}`}
                      >
                        <div className="flex items-center gap-2 min-w-0 flex-wrap md:flex-nowrap">
                          <div
                            className="cursor-grab active:cursor-grabbing rounded-md text-muted-foreground/70 hover:text-foreground px-1 py-0.5"
                            title="拖拽排序"
                          >
                            <GripVertical size={16} />
                          </div>
                          <label className="inline-flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={s.enabled}
                              onChange={() => handleToggleStep(s.id)}
                              disabled={isRunning}
                            />
                            <span className="text-[10px] font-mono text-muted-foreground/70 w-6">{globalIdx + 1}</span>
                          </label>
                          <select
                            value={s.agent}
                            onChange={(e) => handleSetStepAgent(s.id, e.target.value as BuiltinAgentName)}
                            disabled={isRunning}
                            className="rounded-md border border-border bg-secondary/20 px-2 py-1 text-sm outline-none focus:border-primary/40 disabled:opacity-50 min-w-0 max-w-[50%] md:max-w-[60%]"
                          >
                            {BUILTIN_AGENT_NAMES.map((n) => {
                              const cc = AGENT_CAPABILITIES[n];
                              return (
                                <option key={n} value={n}>
                                  {isZh ? cc.labelZh : cc.labelEn} · {n}
                                </option>
                              );
                            })}
                          </select>
                          <div className="text-xs text-muted-foreground/80 hidden md:block truncate max-w-[18ch]">
                            {cap.inputHintZh ?? ""}
                          </div>
                          <div className="ml-auto flex items-center gap-1 shrink-0">
                            <TooltipProvider delay={150}>
                              <Tooltip>
                                <TooltipTrigger
                                  type="button"
                                  onClick={() => setSelectedStepId(selected ? null : s.id)}
                                  className={`rounded-md p-1.5 border transition-colors ${
                                    selected
                                      ? "border-primary/40 text-primary bg-primary/10"
                                      : "border-border/40 text-muted-foreground hover:border-primary/40 hover:text-primary hover:bg-primary/5"
                                  }`}
                                  aria-label={isZh ? "查看/配置步骤详情" : "View/configure step details"}
                                >
                                  <CircleHelp size={15} />
                                </TooltipTrigger>
                                <TooltipContent side="top" className="max-w-sm text-xs leading-relaxed">
                                  <div className="space-y-2">
                                    <div className="flex items-center gap-2">
                                      <span className="font-semibold">{isZh ? cap.labelZh : cap.labelEn}</span>
                                      <span className="font-mono text-[10px] text-background/60">{s.agent}</span>
                                      <span className="rounded-full bg-background/15 px-2 py-0.5 text-[10px]">
                                        {isZh ? AGENT_PHASE_LABELS[cap.phase][0] : AGENT_PHASE_LABELS[cap.phase][1]}
                                      </span>
                                      {cap.optional && <span className="rounded-full bg-background/15 px-2 py-0.5 text-[10px]">可选</span>}
                                    </div>
                                    <p className="text-background/85">{isZh ? cap.descriptionZh : cap.descriptionEn}</p>
                                    {(cap.inputHintZh || cap.outputHintZh) && (
                                      <div className="space-y-1 border-t border-background/20 pt-2 text-background/80">
                                        {cap.inputHintZh && <div><span className="font-semibold">输入：</span>{cap.inputHintZh}</div>}
                                        {cap.outputHintZh && <div><span className="font-semibold">输出：</span>{cap.outputHintZh}</div>}
                                      </div>
                                    )}
                                  </div>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                            <button
                              onClick={() => handleDuplicateStep(s.id)}
                              disabled={isRunning}
                              className={`rounded-md p-1.5 border transition-colors ${
                                selected
                                  ? "border-primary/30 text-foreground hover:border-primary/50 hover:bg-primary/5"
                                  : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
                              } disabled:opacity-40`}
                              aria-label={isZh ? "复制步骤" : "Duplicate step"}
                              title={isZh ? "复制步骤" : "Duplicate"}
                            >
                              <CopyPlus size={15} />
                            </button>
                            <button
                              onClick={() => handleMoveStep(s.id, -1)}
                              disabled={isRunning || globalIdx === 0}
                              className={`rounded-md p-1.5 border transition-colors ${
                                selected
                                  ? "border-primary/30 text-foreground hover:border-primary/50 hover:bg-primary/5"
                                  : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
                              } disabled:opacity-30`}
                              aria-label={isZh ? "上移" : "Move up"}
                              title={isZh ? "上移" : "Move up"}
                            >
                              <ArrowUp size={15} />
                            </button>
                            <button
                              onClick={() => handleMoveStep(s.id, 1)}
                              disabled={isRunning || globalIdx === draftSteps.length - 1}
                              className={`rounded-md p-1.5 border transition-colors ${
                                selected
                                  ? "border-primary/30 text-foreground hover:border-primary/50 hover:bg-primary/5"
                                  : "border-border/40 text-muted-foreground hover:border-border hover:text-foreground"
                              } disabled:opacity-30`}
                              aria-label={isZh ? "下移" : "Move down"}
                              title={isZh ? "下移" : "Move down"}
                            >
                              <ArrowDown size={15} />
                            </button>
                            <button
                              onClick={() => handleRemoveStep(s.id)}
                              disabled={isRunning}
                              className={`rounded-md p-1.5 border transition-colors ${
                                selected
                                  ? "border-primary/30 text-muted-foreground hover:border-destructive/40 hover:text-destructive hover:bg-destructive/5"
                                  : "border-border/40 text-muted-foreground hover:border-destructive/40 hover:text-destructive hover:bg-destructive/5"
                              } disabled:opacity-40`}
                              aria-label={isZh ? "删除步骤" : "Delete step"}
                              title={isZh ? "删除步骤" : "Delete"}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                        </div>

                        {/* Step options: shown when selected */}
                        {selected && (
                          <div className="mt-3 rounded-lg bg-secondary/20 p-3 border border-border/40 space-y-3">
                            <div>
                              <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">步骤参数</div>
                              {(Object.keys(cap.options ?? {}).length === 0) && (
                                <p className="mt-1 text-xs text-muted-foreground italic">该 Agent 无额外参数，保持默认行为即可。</p>
                              )}
                              {Object.entries(cap.options ?? {}).map(([k, v]) => (
                                <label key={k} className="mt-2 block space-y-1">
                                  <div className="flex items-baseline justify-between gap-3">
                                    <span className="text-xs font-semibold">{v[0]} <span className="font-mono text-muted-foreground/70 font-normal">· {k}</span></span>
                                  </div>
                                  <p className="text-[11px] text-muted-foreground/80">{v[1]}</p>
                                  <input
                                    value={String(s.options?.[k] ?? "")}
                                    onChange={(e) => handleSetStepOption(s.id, k, e.target.value)}
                                    disabled={isRunning}
                                    placeholder="（留空=默认）"
                                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary/40 disabled:opacity-50 font-mono"
                                  />
                                </label>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Step in-chapter progress bar */}
                        {stepProgress && stepProgress.agent === s.agent && stepProgress.status === "running" && (
                          <div className="mt-2">
                            <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
                              <div className="h-full bg-primary animate-pulse" style={{ width: "35%" }} />
                            </div>
                          </div>
                        )}
                        {idxInPhase === steps.length - 1 && (() => {
                          // Show phase-level completed checkmark in future; skip for now.
                          void phase;
                          return null;
                        })()}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {/* ===== Right column: run config + progress + logs ===== */}
        <aside className="xl:col-span-3 space-y-4 min-w-0" style={{ minWidth: "clamp(260px, 24vw, 380px)" }}>
          <section className={`border ${c.cardStatic} rounded-xl p-5 space-y-4`} style={{ minWidth: "100%" }}>
            <h2 className="text-sm uppercase tracking-wide text-muted-foreground font-medium">执行</h2>
            <div>
              <label className="text-xs text-muted-foreground block mb-1">目标书籍</label>
              <select
                value={selectedBookId}
                onChange={(e) => setSelectedBookId(e.target.value)}
                disabled={isRunning}
                className="w-full rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm outline-none disabled:opacity-50"
              >
                <option value="">-- 选择一本书 --</option>
                {activeBooks.map((b) => (
                  <option key={b.id} value={b.id}>{b.title}（已写 {b.chaptersWritten ?? 0} / {b.targetChapters ?? "?"} 章 · {b.status}）</option>
                ))}
              </select>
            </div>

            {/* 书籍概览 */}
            {selectedBookId && bookDetail && (() => {
              const b = bookDetail.book;
              const written = bookDetail.chapters.length;
              const target = b.targetChapters ?? 0;
              const pct = target > 0 ? Math.min(100, Math.round((written / target) * 100)) : 0;
              const next = bookDetail.nextChapter;
              // These are the *book-derived* bounds for write/plan targets.
              // Rename so they don't shadow the review-scope startChapter/endChapter
              // used by the review summary above.
              const runStartChapter = next;
              const runEndChapter = next + chapterCount - 1;
              const recentChapters = [...bookDetail.chapters].sort((a, c) => c.number - a.number).slice(0, 8);
              const totalWords = bookDetail.chapters.reduce((s, c) => s + (c.wordCount || 0), 0);
              const statusLabels: Record<string, string> = {
                "drafted": "已草稿", "drafting": "写作中", "ready-for-review": "待审",
                "approved": "已通过", "published": "已发布", "audit-failed": "审计失败", "planned": "已规划",
              };
              return (
                <div className="rounded-lg border border-border/60 bg-secondary/20 p-4 space-y-3 text-xs">
                  {/* 基本信息 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-sm text-foreground">{b.title}</span>
                      <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5 text-[10px]">{b.status}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
                      <div>题材：<span className="text-foreground/80">{b.genre ?? "—"}</span></div>
                      <div>平台：<span className="text-foreground/80">{b.platform ?? "—"}</span></div>
                      <div>语言：<span className="text-foreground/80">{b.language ?? "zh"}</span></div>
                      <div>目标字数/章：<span className="text-foreground/80">{b.chapterWordCount ?? "—"}</span></div>
                    </div>
                  </div>

                  {/* 进度条 */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-muted-foreground">写作进度</span>
                      <span className="text-foreground/80">{written} / {target || "?"} 章（{pct}%）</span>
                    </div>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    <div className="text-[10px] text-muted-foreground">累计 {totalWords.toLocaleString()} 字 · 下一章为第 {next} 章</div>
                  </div>

                  {/* 已写章节列表 */}
                  {recentChapters.length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[11px] text-muted-foreground">最近章节（最多 8 章）</div>
                      <ul className="space-y-0.5 max-h-40 overflow-y-auto">
                        {recentChapters.map((ch) => (
                          <li key={ch.number} className="flex items-center gap-2 py-0.5">
                            <span className="font-mono text-[10px] text-muted-foreground w-8 shrink-0">#{ch.number}</span>
                            <span className="flex-1 truncate text-foreground/80">{ch.title || "（无标题）"}</span>
                            <span className="text-[10px] text-muted-foreground shrink-0">{(ch.wordCount / 1000).toFixed(1)}k</span>
                            <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] ${ch.status === "ready-for-review" ? "bg-amber-500/10 text-amber-600" : ch.status === "approved" || ch.status === "published" ? "bg-emerald-500/10 text-emerald-600" : ch.status === "audit-failed" ? "bg-destructive/10 text-destructive" : "bg-secondary text-muted-foreground"}`}>
                              {statusLabels[ch.status] ?? ch.status}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 本次自动化范围摘要 */}
                  <div className="rounded-md bg-primary/5 border border-primary/20 px-3 py-2 space-y-1">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-primary">
                      <BookOpen size={12} /> 本次自动化
                    </div>
                    <div className="text-xs text-foreground/90">
                      {isReviewTarget ? (
                        <>
                          将 <span className="font-semibold text-primary">审查</span>
                          {(() => {
                            // For review targets the summary must reflect the
                            // configured review scope, not the book's nextChapter.
                            const scopeDesc = describeReviewScopeForUI(reviewKind, startChapter, endChapter, chapterListText, foundationTargets, draftTarget);
                            return <span className="font-semibold">{scopeDesc}</span>;
                          })()}
                        </>
                      ) : draftTarget === "revision-pass" ? (
                        <>将 <span className="font-semibold text-primary">修订</span> 最近 <span className="font-semibold">{chapterCount}</span> 章</>
                      ) : draftTarget === "post-write-pass" ? (
                        <>将 <span className="font-semibold text-primary">做写后处理</span>（长度校准/润色/汇总）最近 <span className="font-semibold">{chapterCount}</span> 章</>
                      ) : draftTarget === "market-radar" ? (
                        <>将进行 <span className="font-semibold text-primary">市场雷达扫描</span>，输出趋势简报</>
                      ) : draftTarget === "foundation" ? (
                        <>将 <span className="font-semibold text-primary">构建基础设定</span>（世界观/角色/大纲/书规等）</>
                      ) : draftTarget === "plan-only" ? (
                        <>将 <span className="font-semibold text-primary">规划</span> 第 <span className="font-semibold text-primary">{runStartChapter}</span> ~ <span className="font-semibold">{runEndChapter}</span> 章的章意图</>
                      ) : (
                        <>从 <span className="font-semibold text-primary">第 {runStartChapter} 章</span> 开始，连续写 <span className="font-semibold">{chapterCount}</span> 章
                          {chapterCount > 1 ? <>（第 {runStartChapter} ~ {runEndChapter} 章）</> : null}</>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* 审查范围选择器 */}
            {isReviewTarget && (
              <div className="space-y-2.5 border border-border/60 rounded-xl p-4 bg-secondary/10">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">审查范围</h3>
                  <span className="text-[10px] text-muted-foreground">选择要审查的内容</span>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {(
                    draftTarget === "review-foundation"
                      ? ([
                        { k: "foundation", label: "基础设定文件" },
                        { k: "project", label: "全项目" },
                      ] as const)
                      : draftTarget === "review-chapters"
                        ? ([
                          { k: "chapters", label: "按章节选择" },
                          { k: "project", label: "全项目（慢）" },
                        ] as const)
                        : ([
                          { k: "chapters", label: "按章节" },
                          { k: "foundation", label: "基础设定" },
                          { k: "project", label: "全项目" },
                          { k: "custom", label: "自定义路径" },
                        ] as const)
                  ).map((opt) => (
                    <button
                      key={opt.k}
                      type="button"
                      onClick={() => {
                        // When switching kind, carry over chapter bounds when
                        // sensible; otherwise reset to a sensible default for
                        // the new kind so the user isn't left with invalid state.
                        const next: ReviewScope = { kind: opt.k };
                        if (opt.k === "chapters" || opt.k === "project") {
                          (next as any).startChapter = startChapter;
                          if (endChapter > 0) (next as any).endChapter = endChapter;
                        }
                        if (opt.k === "foundation" || opt.k === "project" || draftTarget === "review-foundation") {
                          (next as any).foundationTargets = foundationTargets;
                        }
                        persistReviewScope(next);
                      }}
                      className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        reviewKind === opt.k
                          ? "border-primary bg-primary/10 text-primary font-medium"
                          : "border-border/70 hover:border-primary/30 text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {(reviewKind === "chapters" || reviewKind === "project") && (draftTarget === "review-chapters" || draftTarget === "review") && (
                  <div className="space-y-2 pt-1">
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">起始章</label>
                        <input
                          type="number" min={1} value={startChapter}
                          onChange={(e) => mergeReviewScope({ startChapter: Math.max(1, parseInt(e.target.value) || 1) })}
                          className="w-full rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[11px] text-muted-foreground">结束章（0=仅起始章）</label>
                        <input
                          type="number" min={0} value={endChapter}
                          onChange={(e) => mergeReviewScope({ endChapter: Math.max(0, parseInt(e.target.value) || 0) })}
                          className="w-full rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-sm"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted-foreground">或指定章节列表（逗号/空格分隔，如 1,3,5-7）</label>
                      <input
                        type="text" placeholder="例: 1,3,5-7"
                        value={chapterListText}
                        onChange={(e) => {
                          const text = e.target.value;
                          const explicitList = text
                            .split(/[,，\s]+/)
                            .map((s) => s.trim())
                            .filter(Boolean)
                            .map((s) => Number(s))
                            .filter((n) => Number.isFinite(n) && n > 0);
                          mergeReviewScope(explicitList.length > 0 ? { chapterList: explicitList, startChapter: undefined, endChapter: undefined } : { chapterList: undefined });
                        }}
                        className="w-full rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-sm font-mono"
                      />
                    </div>
                  </div>
                )}

                {reviewKind === "custom" && (
                  <div className="space-y-1 pt-1">
                    <label className="text-[11px] text-muted-foreground">自定义路径（每行一条，相对于书籍根目录）</label>
                    <textarea
                      rows={3}
                      placeholder={"story/outline/story_frame.md\nchapters/ch0001.md"}
                      value={customPathsText}
                      onChange={(e) => {
                        const paths = e.target.value
                          .split(/\n+/)
                          .map((s) => s.trim())
                          .filter(Boolean);
                        mergeReviewScope({ paths: paths.length > 0 ? paths : undefined });
                      }}
                      className="w-full rounded-md border border-border bg-secondary/30 px-2.5 py-1.5 text-sm font-mono"
                    />
                  </div>
                )}

                {(reviewKind === "foundation" || reviewKind === "project" || draftTarget === "review-foundation") && (
                  <div className="space-y-2 pt-1">
                    <div className="text-[11px] text-muted-foreground">基础设定目标</div>
                    <div className="grid grid-cols-2 gap-1.5 text-xs">
                      {([
                        ["storyFrame", "故事大纲"],
                        ["volumeMap", "分卷导图"],
                        ["characterBible", "人物图鉴"],
                        ["worldBible", "世界观词典"],
                        ["timelineCausal", "因果时序"],
                        ["powerSystem", "力量体系"],
                        ["locationScenes", "场景图鉴"],
                        ["plotSeeds", "剧情种子"],
                      ] as const).map(([k, label]) => (
                        <label key={k} className="flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-1 hover:border-primary/30 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={foundationTargets[k] ?? false}
                            onChange={(e) => {
                              mergeReviewScope({
                                foundationTargets: { ...foundationTargets, [k]: e.target.checked },
                              });
                            }}
                            className="accent-primary"
                          />
                          <span className={foundationTargets[k] ? "text-foreground" : "text-muted-foreground"}>{label}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                <button
                  type="button"
                  onClick={() => persistReviewScope(buildReviewScopeForSubmit())}
                  className="w-full text-xs rounded-md border border-border/70 hover:border-primary/30 hover:bg-primary/5 px-2 py-1.5 text-muted-foreground hover:text-foreground transition-colors"
                >
                  保存审查范围
                </button>
              </div>
            )}

            {/* 章节数量输入（仅非审查目标生效） */}
            {!isReviewTarget && (
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground block">
                  {draftTarget === "write-chapter" || draftTarget === "plan-only"
                    ? "本次写作章节数"
                    : draftTarget === "revision-pass"
                      ? "本次修订章节数"
                      : "章节参数"}
                </label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={chapterCount}
                  onChange={(e) => setChapterCount(Math.max(1, Math.min(20, parseInt(e.target.value) || 1)))}
                  disabled={isRunning}
                  className="w-full rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm outline-none disabled:opacity-50"
                />
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {draftTarget === "write-chapter" && "控制本次工作流连续写多少章。每章会按上方步骤依次执行 planner → writer → 审计链。"}
                  {draftTarget === "plan-only" && "控制本次连续规划多少章的大纲。每章会执行 planner（及配置的其他规划类 Agent）。"}
                  {draftTarget === "revision-pass" && "控制本次对最近多少章做修订/润色回炉。"}
                  {draftTarget === "foundation" && "基础设定工作流为一次性执行，章节参数不生效。"}
                  {draftTarget === "post-write-pass" && "写后处理工作流（如真相合并、记忆索引重建）为一次性执行，章节参数不生效。"}
                  {draftTarget === "market-radar" && "市场雷达工作流为一次性执行，章节参数不生效。"}
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1 items-stretch w-full">
              <button
                onClick={handleWorkflowRunStart}
                disabled={isRunning || !selectedBookId || loading || enabledCount === 0}
                className={`flex-1 min-w-40 whitespace-nowrap px-4 py-2.5 text-sm rounded-md inline-flex items-center justify-center gap-1.5 ${c.btnPrimary} disabled:opacity-40`}
                style={{ minWidth: "11rem" }}
              >
                <Play size={14} /> {loading ? "启动中..." : isRunning ? "运行中..." : isPaused ? "重新开始" : "按工作流执行"}
              </button>
              {isRunning && (
                <button
                  onClick={handleAbort}
                  disabled={aborting}
                  className="shrink-0 whitespace-nowrap px-4 py-2.5 text-sm rounded-md inline-flex items-center justify-center gap-1.5 border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                  style={{ minWidth: "7rem" }}
                >
                  <Square size={14} /> {aborting ? "终止中..." : "终止"}
                </button>
              )}
              {isPaused && (
                <button
                  onClick={handleResume}
                  disabled={loading}
                  className="shrink-0 whitespace-nowrap px-4 py-2.5 text-sm rounded-md inline-flex items-center justify-center gap-1.5 border border-primary/40 text-primary hover:bg-primary/10 transition-colors disabled:opacity-40"
                  style={{ minWidth: "7rem" }}
                >
                  {loading ? "继续中..." : "继续执行"}
                </button>
              )}
              <button
                onClick={handleBatchWriteStart}
                disabled={isRunning || !selectedBookId || loading}
                title="走旧的 write-batch（无自定义步骤）"
                className="shrink-0 whitespace-nowrap px-3 py-2.5 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors disabled:opacity-40"
                style={{ minWidth: "7rem" }}
              >
                旧批量写章
              </button>
            </div>
            <button
              onClick={handleUnlock}
              disabled={!selectedBookId || isRunning || unlocking}
              className="w-full px-3 py-2 text-sm rounded-md border border-border text-muted-foreground hover:border-destructive hover:text-destructive transition-colors disabled:opacity-40"
            >
              {unlocking ? "解锁中..." : "强制解锁书籍锁"}
            </button>
            {error && (
              <div className="text-sm text-destructive bg-destructive/5 rounded-md px-3 py-2 break-all">{error}</div>
            )}
          </section>

          {progress && (
            <section className={`border ${c.cardStatic} rounded-xl p-5 space-y-3`}>
              <div className="flex items-center justify-between">
                <h2 className="text-sm uppercase tracking-wide text-muted-foreground font-medium">进度</h2>
                {progress.workflowName && (
                  <span className="text-[11px] rounded-full bg-primary/10 text-primary px-2 py-0.5 truncate max-w-[60%]" title={progress.workflowName}>
                    {progress.workflowName}
                  </span>
                )}
              </div>
              <div className={`text-lg font-semibold ${isCompleted ? "text-emerald-500" : isPaused ? "text-amber-500" : isRunning ? "text-primary" : "text-muted-foreground"}`}>
                {progress.completedCount} / {progress.totalChapters} {isReviewTarget ? "单元" : "章"}
                {isPaused && <span className="text-sm text-amber-500 ml-2">（已暂停）</span>}
              </div>
              {progress.currentChapter !== undefined && !isReviewTarget && (
                <div className="text-sm text-muted-foreground">当前：第 {progress.currentChapter} 章</div>
              )}
              {progress.currentChapter !== undefined && isReviewTarget && (
                <div className="text-sm text-muted-foreground">当前：单元 {progress.currentChapter}</div>
              )}
              {stepProgress && (
                <div className="text-xs text-muted-foreground">
                  步骤进度 {stepProgress.stepIndex + 1} / {stepProgress.totalSteps}
                  {" "}<span className="font-mono text-primary">{stepProgress.agent}</span>
                  <span className={`ml-2 ${stepProgress.status === "error" ? "text-destructive" : "text-emerald-500"}`}>
                    {stepProgress.status === "running" ? "运行中" : stepProgress.status === "error" ? "出错" : "完成"}
                  </span>
                </div>
              )}
              {progress.failures > 0 && (
                <div className="text-sm text-destructive">失败：{progress.failures} 章</div>
              )}
              {isCompleted && (
                <div className="text-sm text-emerald-500 font-medium">
                  {progress.failures > 0 ? `完成（${progress.failures} 章失败）` : "全部完成！"}
                </div>
              )}
              <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${isCompleted ? "bg-emerald-500" : "bg-primary"}`}
                  style={{ width: `${progress.totalChapters > 0 ? (progress.completedCount / progress.totalChapters) * 100 : 0}%` }}
                />
              </div>
            </section>
          )}
        </aside>
      </div>

      {/* ===== Logs across bottom ===== */}
      <section className={`border ${c.cardStatic} rounded-xl`}>
        <div className="px-5 py-3.5 border-b border-border flex items-center justify-between flex-wrap gap-2">
          <span className="text-sm uppercase tracking-wide text-muted-foreground font-medium">事件日志</span>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{logs.length} 条</span>
            {stepProgress && (
              <span className="rounded-full bg-primary/10 text-primary px-2 py-0.5">
                当前步骤 {stepProgress.agent} {stepProgress.status === "running" ? "运行中" : stepProgress.status}
              </span>
            )}
            <button
              onClick={() => clearLogs()}
              className="rounded-md border border-border/60 px-2 py-0.5 hover:border-destructive/50 hover:text-destructive text-muted-foreground inline-flex items-center gap-1"
            >
              <X size={12} /> 清空
            </button>
          </div>
        </div>
        <div ref={logRef} className="p-4 max-h-[420px] overflow-y-auto">
          {logs.length > 0 ? (
            <div className="space-y-1.5 font-mono text-sm">
              {logs.map((log) => {
                const label = logLabels[log.event] ?? log.event;
                const isError = log.event === "auto:error";
                return (
                  <div key={log.key} className={`leading-relaxed ${isError ? "text-destructive" : "text-muted-foreground"}`}>
                    <span className="text-border text-xs mr-2">{log.time}</span>
                    <span className={isError ? "text-destructive/70" : "text-primary/50"}>{log.event}</span>
                    <span className="text-border mx-1.5">›</span>
                    <span>{formatLogData(log.event, log.data, label)}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-muted-foreground text-sm italic py-8 text-center">
              {isRunning ? "等待事件..." : "选择一本书、配置工作流并点击「按工作流执行」"}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function describeReviewScopeForUI(
  kind: string,
  startChapter: number,
  endChapter: number,
  chapterListText: string,
  foundationTargets: Record<string, boolean | undefined>,
  target: string,
): string {
  if (kind === "chapters") {
    const explicitList = chapterListText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (explicitList.length > 0) return `章节列表 ${explicitList.join(",")}`;
    const start = startChapter || 1;
    const end = endChapter > 0 ? endChapter : start;
    return `章节 ${start}${end > start ? `-${end}` : ""}`;
  }
  if (kind === "project") {
    const explicitList = chapterListText
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (explicitList.length > 0) return `全项目（含章节列表 ${explicitList.join(",")}）`;
    return "全项目（章节 + 基础设定）";
  }
  if (kind === "foundation") {
    const labels: string[] = [];
    if (foundationTargets.storyFrame) labels.push("故事大纲");
    if (foundationTargets.volumeMap) labels.push("分卷导图");
    if (foundationTargets.characterBible) labels.push("人物图鉴");
    if (foundationTargets.worldBible) labels.push("世界观词典");
    if (foundationTargets.plotSeeds) labels.push("剧情种子");
    if (foundationTargets.powerSystem) labels.push("力量体系");
    if (foundationTargets.timelineCausal) labels.push("因果时序");
    if (foundationTargets.locationScenes) labels.push("场景图鉴");
    if (foundationTargets.storyFrame === undefined && labels.length === 0) return "基础设定文件";
    return labels.length > 0 ? `基础设定（${labels.join("/")}）` : "基础设定文件";
  }
  if (kind === "custom") return "自定义路径";
  if (target === "review-foundation") return "基础设定文件";
  return "全部项目";
}

function describeReviewScopeForLog(scope: { kind?: string; chapterList?: number[]; startChapter?: number; endChapter?: number; foundationTargets?: Record<string, boolean | undefined>; paths?: string[] }): string {
  const kind = scope.kind ?? "chapters";
  if (kind === "chapters") {
    if (scope.chapterList && scope.chapterList.length > 0) return `章节列表 ${scope.chapterList.join(",")}`;
    const start = scope.startChapter ?? 1;
    const end = scope.endChapter && scope.endChapter > 0 ? scope.endChapter : start;
    return `章节 ${start}${end > start ? `-${end}` : ""}`;
  }
  if (kind === "project") {
    if (scope.chapterList && scope.chapterList.length > 0) return `全项目（章节列表 ${scope.chapterList.join(",")}）`;
    return "全项目";
  }
  if (kind === "foundation") {
    const ft = scope.foundationTargets;
    if (!ft) return "基础设定";
    const labels: string[] = [];
    if (ft.storyFrame) labels.push("大纲");
    if (ft.volumeMap) labels.push("分卷");
    if (ft.bookRules) labels.push("书规");
    if (ft.roles || ft.characterBible) labels.push("人物");
    if (ft.worldBible) labels.push("世界观");
    if (ft.powerSystem) labels.push("力量");
    if (ft.locationScenes) labels.push("场景");
    if (ft.timelineCausal) labels.push("时序");
    if (ft.plotSeeds) labels.push("种子");
    if (ft.authorIntent) labels.push("意图");
    if (ft.currentFocus) labels.push("焦点");
    if (ft.styleGuide) labels.push("文风");
    if (ft.pendingHooks) labels.push("钩子");
    return labels.length > 0 ? `基础设定(${labels.join(",")})` : "基础设定";
  }
  if (kind === "custom" && scope.paths) return `自定义 ${scope.paths.length} 条路径`;
  return "全项目";
}

const logLabels: Record<string, string> = {
  "auto:start": "开始",
  "auto:step-start": "步骤开始",
  "auto:step-complete": "步骤完成",
  "auto:chapter-complete": "章节完成",
  "auto:complete": "全部完成",
  "auto:error": "错误",
  "auto:unlock": "解锁",
  "auto:run-start": "发起运行",
  "auto:log": "进度",
  "auto:paused": "已暂停",
  "auto:resumed": "已继续",
};

function formatLogData(event: string, data: Record<string, unknown>, _label: string): string {
  switch (event) {
    case "auto:start": {
      const parts = [`开始，共 ${data.totalChapters} 个单元`];
      if (data.workflowName) parts.push(`工作流：${String(data.workflowName)}`);
      if (data.target) parts.push(`目标：${String(data.target)}`);
      if (data.scope) parts.push(`范围：${describeReviewScopeForLog(data.scope as any)}`);
      return parts.join(" · ");
    }
    case "auto:step-start":
      return `第 ${data.chapterNumber} 章 步骤 ${Number(data.stepIndex) + 1}/${data.totalSteps} 开始：${data.agent}`;
    case "auto:step-complete":
      return `第 ${data.chapterNumber} 章 步骤 ${Number(data.stepIndex) + 1}/${data.totalSteps} 完成：${data.agent}${data.status ? ` (${String(data.status)})` : ""}`;
    case "auto:chapter-complete": {
      const successStatuses = new Set(["ready-for-review", "drafted", "planned", "reviewed", "approved", "published"]);
      if (successStatuses.has(String(data.status))) {
        if (data.title) {
          return `第 ${data.chapterNumber} 章「${String(data.title)}」完成${data.wordCount ? `（${data.wordCount} 字）` : ""} - ${data.completedCount}/${data.requestedCount}`;
        }
        return `第 ${data.chapterNumber} 章完成 - ${data.completedCount}/${data.requestedCount}`;
      }
      return `第 ${data.chapterNumber} 章失败（${String(data.status)}）- ${data.completedCount}/${data.requestedCount}`;
    }
    case "auto:complete":
      if (Number(data.failures) === 0) return `全部 ${data.totalCompleted} 章完成`;
      return `完成 ${data.totalCompleted} 章（${data.failures} 失败）`;
    case "auto:error":
      return String(data.error ?? "未知错误");
    case "auto:unlock":
      return data.cleared ? "锁已清除" : `解锁失败：${String(data.reason ?? "")}`;
    case "auto:run-start": {
      const parts = [`发起运行 ${String(data.workflowId)} 书=${String(data.bookId)}`];
      if (data.chapterCount !== undefined) parts.push(`章数=${String(data.chapterCount)}`);
      if (data.scope) parts.push(`范围=${describeReviewScopeForLog(data.scope as any)}`);
      if (data.target) parts.push(`目标=${String(data.target)}`);
      return parts.join(" ");
    }
    case "auto:log": {
      const msg = data.message ? String(data.message) : "";
      const stage = data.stage ? `[${String(data.stage)}] ` : "";
      return `${stage}${msg}`;
    }
    case "auto:paused":
      return `用户终止 — 已完成 ${String(data.completedCount)}/${String(data.totalUnits)}`;
    case "auto:resumed":
      return `继续执行工作流 ${String(data.workflowId)}`;
    default:
      try { return JSON.stringify(data); } catch { return String(data); }
  }
}
