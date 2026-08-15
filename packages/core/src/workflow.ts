// Workflow schema for Automation Workbench.
// Browser-safe (no Node imports) so both Studio frontend and core can import it.
import { AGENT_CAPABILITIES, AGENT_ORDER, BUILTIN_AGENT_NAMES, type AgentPhase, type BuiltinAgentName } from "./agents/builtin-names.js";

export interface WorkflowStep {
  /** Stable id for frontend drag/drop (UUID / short random) */
  readonly id: string;
  /** Agent name */
  readonly agent: BuiltinAgentName;
  /** Whether the step is enabled (disabled steps are skipped at runtime) */
  readonly enabled: boolean;
  /** Free-form per-step options (merged with agent defaults) */
  readonly options: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkflowDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Which task kind the workflow targets (drives runner routing) */
  readonly target: WorkflowTarget;
  /** Ordered step list */
  readonly steps: ReadonlyArray<WorkflowStep>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly builtin?: boolean;
  /** 手动挂载的 Skill ID 列表，运行时注入到所有子 Agent 的 system prompt */
  readonly skills?: ReadonlyArray<string>;
}

export type WorkflowTarget =
  | "write-chapter"       // write one chapter (most common)
  | "fast-write"          // plan + compose + writer only — skip audit/revise/post-write
  | "foundation"          // build foundation only (start a new book)
  | "plan-only"           // plan chapter only, no write
  | "revision-pass"       // take an already-written chapter and re-run audit/revise/polish
  | "post-write-pass"     // take a chapter and run length-normalizer/polisher/consolidator
  | "market-radar"        // radar scan
  // ---------- review targets ----------
  // Review a specific scope (chapters / foundation files) WITHOUT writing new
  // prose. Produces a report + (when the workflow includes reviser) safe
  // fixes. Intended to be used against books that already have chapters.
  | "review"              // broad review: user picks scope (chapters + foundation + settlement)
  | "review-foundation"   // scope restricted to story_frame / volume_map / roles / book_rules
  | "review-chapters";    // scope restricted to chapters (optionally range / list)

export const WORKFLOW_TARGET_LABELS: Readonly<Record<WorkflowTarget, readonly [string, string]>> = {
  "write-chapter": ["写一章（含规划+撰写+审计+修订+后处理）", "Write one chapter (plan + write + audit + revise + post)"],
  "fast-write": ["快速写章（仅规划+撰写，跳过审计/修订/后处理）", "Fast write (plan + write only, skip audit/revise/post)"],
  foundation: ["构建基础设定（开书）", "Build foundation (new book)"],
  "plan-only": ["仅章意图规划", "Plan chapter intent only"],
  "revision-pass": ["对已有章节重跑审计/修订", "Re-run audit/revise on an existing chapter"],
  "post-write-pass": ["写后处理（长度/润色/汇总）", "Post-write (length/polish/consolidate)"],
  "market-radar": ["市场雷达扫描", "Market radar scan"],
  // Review targets
  review: ["审查（通用，可选范围）", "Review — custom scope (chapters + foundation)"],
  "review-foundation": ["审查基础设定（世界观/卷纲/角色/书规）", "Review foundation files only"],
  "review-chapters": ["审查章节正文（可按区间/选章）", "Review chapters (range or pick list)"],
};

// ---------- Helpers ----------
export function newStepId(): string {
  // Tiny uuid-lite — enough for drag reorder keys.
  // Math.random → base36, 10 chars × 2 plus timestamp.
  const rand = () => Math.random().toString(36).slice(2, 12);
  return `${Date.now().toString(36)}-${rand()}${rand()}`;
}

export function makeDefaultStep(agent: BuiltinAgentName, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: newStepId(),
    agent,
    enabled: !AGENT_CAPABILITIES[agent].optional,
    options: {},
    ...overrides,
  };
}

export function buildDefaultWorkflow(target: WorkflowTarget, id = "default", name?: string, description?: string): WorkflowDefinition {
  const phaseRank: Record<AgentPhase, number> = {
    foundation: 1, planning: 2, writing: 3, governance: 4, revision: 5, "post-write": 6, market: 7,
  };

  const steps: WorkflowStep[] = AGENT_ORDER
    .filter((a) => {
      switch (target) {
        case "foundation":
          return AGENT_CAPABILITIES[a].phase === "foundation";
        case "plan-only":
          return AGENT_CAPABILITIES[a].phase === "planning";
        case "write-chapter":
          return (
            AGENT_CAPABILITIES[a].phase === "planning" ||
            AGENT_CAPABILITIES[a].phase === "writing" ||
            AGENT_CAPABILITIES[a].phase === "governance" ||
            AGENT_CAPABILITIES[a].phase === "revision" ||
            AGENT_CAPABILITIES[a].phase === "post-write"
          );
        case "fast-write":
          // Only planning + writing — audit/revise/post-write are skipped
          // entirely (controlled by chapterReviewMode=manual + disabled steps).
          return AGENT_CAPABILITIES[a].phase === "planning" || AGENT_CAPABILITIES[a].phase === "writing";
        case "revision-pass":
          return AGENT_CAPABILITIES[a].phase === "governance" || AGENT_CAPABILITIES[a].phase === "revision";
        case "post-write-pass":
          return AGENT_CAPABILITIES[a].phase === "post-write";
        case "market-radar":
          return a === "radar";
        // ---------- review targets ----------
        // Review chains run governance first (validating state + consistency +
        // quality), then revision (safe fixes when reviser is in the chain),
        // then an optional foundation-reviewer consistency check so the user
        // can see changes that would break the book's ground rules.
        case "review":
          return (
            AGENT_CAPABILITIES[a].phase === "governance" ||
            AGENT_CAPABILITIES[a].phase === "revision" ||
            AGENT_CAPABILITIES[a].phase === "post-write"
          );
        case "review-chapters":
          return (
            AGENT_CAPABILITIES[a].phase === "governance" ||
            AGENT_CAPABILITIES[a].phase === "revision"
          );
        case "review-foundation":
          // Foundation review only: foundation-reviewer is the primary actor;
          // state-validator + continuity-auditor give cheap cross-views if the
          // user enables them (optional). No chapter agents needed.
          return a === "foundation-reviewer" || a === "state-validator" || a === "continuity-auditor" || a === "auditor";
      }
    })
    // Ensure the default step order follows phase pipeline order and the
    // declared intra-phase ranking. AGENT_ORDER alone is grouped by insertion,
    // so without this sort a write-chapter workflow could list writer before
    // planner, or a review workflow could list auditor before state-validator.
    .sort((a, b) => {
      const ca = AGENT_CAPABILITIES[a];
      const cb = AGENT_CAPABILITIES[b];
      const phaseDelta = phaseRank[ca.phase] - phaseRank[cb.phase];
      if (phaseDelta !== 0) return phaseDelta;
      return ca.order - cb.order;
    })
    .map((a) => makeDefaultStep(a, (() => {
      // Review default enables: keep the chain lean. For chapter-level
      // reviews we force continuity-auditor ON because that's the signal that
      // distinguishes "review" from "just re-read". For foundation review we
      // force foundation-reviewer ON; others are informational toggles.
      switch (target) {
        case "review-chapters":
          if (a === "continuity-auditor" || a === "auditor" || a === "reviser") return { enabled: true };
          break;
        case "review-foundation":
          if (a === "foundation-reviewer") return { enabled: true };
          if (a === "auditor") return { enabled: true };
          if (a === "continuity-auditor") return { enabled: false };
          if (a === "state-validator") return { enabled: false };
          break;
        case "review":
          if (a === "continuity-auditor" || a === "auditor" || a === "foundation-reviewer") return { enabled: true };
          if (a === "reviser") return { enabled: false }; // opt-in destructive write
          break;
        default:
          break;
      }
      return {};
    })()));

  // For write-chapter, ensure the governance+revision chain has defaults that
  // match what pipeline runner historically does (continuity-auditor + reviser).
  if (target === "write-chapter") {
    for (const s of steps) {
      if (s.agent === "continuity-auditor" || s.agent === "writer" || s.agent === "planner" || s.agent === "composer" || s.agent === "reviser") {
        (s as WorkflowStep & { enabled: boolean }).enabled = true;
      }
    }
  }

  const now = new Date().toISOString();
  const defaultName: string = (() => {
    switch (target) {
      case "write-chapter": return "标准写章流水线";
      case "fast-write": return "快速写章流水线";
      case "foundation": return "基础设定流水线";
      case "plan-only": return "章节规划";
      case "revision-pass": return "修订回锅";
      case "post-write-pass": return "写后处理";
      case "market-radar": return "市场雷达";
      case "review": return "综合审查（可选范围）";
      case "review-chapters": return "章节审查";
      case "review-foundation": return "基础设定审查";
    }
  })();
  return {
    id,
    name: name ?? defaultName,
    description,
    target,
    steps,
    createdAt: now,
    updatedAt: now,
    builtin: true,
  };
}

export function stepsByPhase(steps: ReadonlyArray<WorkflowStep>): ReadonlyArray<{ phase: AgentPhase; steps: WorkflowStep[] }> {
  const groups = new Map<AgentPhase, WorkflowStep[]>();
  for (const s of steps) {
    const phase = AGENT_CAPABILITIES[s.agent].phase;
    const arr = groups.get(phase) ?? [];
    arr.push(s);
    groups.set(phase, arr);
  }
  // Phase order consistent with AGENT_ORDER ranking.
  const phaseRank: Record<AgentPhase, number> = {
    foundation: 1, planning: 2, writing: 3, governance: 4, revision: 5, "post-write": 6, market: 7,
  };
  return [...groups.entries()]
    .sort((a, b) => phaseRank[a[0]] - phaseRank[b[0]])
    .map(([phase, steps]) => ({ phase, steps }));
}

export const BUILTIN_WORKFLOW_PRESETS: ReadonlyArray<{ id: WorkflowTarget; name: string; target: WorkflowTarget; description: string }> = [
  {
    id: "fast-write",
    name: "快速写章",
    target: "fast-write",
    description: "planner → composer → writer（跳过审计/修订/后处理，配合 manual 审查模式，单章最快路径）",
  },
  {
    id: "write-chapter",
    name: "标准写章",
    target: "write-chapter",
    description: "planner → composer → writer → state-validator(可选) → continuity-auditor → auditor(可选) → reviser → foundation-reviewer(可选) → length-normalizer(可选) → polisher(可选) → consolidator(可选)",
  },
  {
    id: "plan-only",
    name: "仅规划意图",
    target: "plan-only",
    description: "planner → composer，不写正文，适合想先审意图再动笔。",
  },
  {
    id: "foundation",
    name: "新建基础设定",
    target: "foundation",
    description: "architect 生成完整 foundation/ 目录（world、characters、plot、rules、numerical）。",
  },
  {
    id: "revision-pass",
    name: "快速修订回锅",
    target: "revision-pass",
    description: "对已写好的章节重跑审计+修订链（不改情节意图，只修问题）。",
  },
  {
    id: "post-write-pass",
    name: "写后美化",
    target: "post-write-pass",
    description: "长度校准 + 润色 + 真相汇总，交稿前最后一道。",
  },
  {
    id: "market-radar",
    name: "市场雷达",
    target: "market-radar",
    description: "跑一轮 radar，生成趋势简报。",
  },
  // Review presets
  {
    id: "review",
    name: "综合审查",
    target: "review",
    description: "选择范围后跑 state-validator/continuity-auditor/auditor → 可选 reviser → foundation-reviewer。既可改章也能核查设定。",
  },
  {
    id: "review-chapters",
    name: "章节审查",
    target: "review-chapters",
    description: "仅对章节正文做连续性+文风+情绪一致性审计，默认不回写。开启 reviser 会尝试就地修。",
  },
  {
    id: "review-foundation",
    name: "基础设定审查",
    target: "review-foundation",
    description: "对 story_frame、volume_map、book_rules、角色目录做设定一致性审查，定位自相矛盾和缺漏。",
  },
];

// ---------- Review scope ----------
// Browser-safe shape describing what the review workflow should cover. All
// fields are optional — the server fills in sensible defaults based on the
// workflow target (e.g. review-foundation implies foundationFiles).

export type ReviewScopeKind =
  /** Covers every file in the project plus all written chapters. Server-side
   *  default for the generic `review` target. */
  | "project"
  /** Foundation files only (outline/*, book_rules, roles/*). */
  | "foundation"
  /** Chapters only (chapters/*.md + settlement artifacts). */
  | "chapters"
  /** A user-picked list of files / paths. */
  | "custom";

export interface ReviewScope {
  readonly kind: ReviewScopeKind;
  /** When kind === "chapters" or "project": inclusive chapter-range bounds. */
  readonly startChapter?: number;
  readonly endChapter?: number;
  /** When non-empty: run review on these specific chapter numbers (takes
   *  precedence over startChapter/endChapter when both are provided). */
  readonly chapterList?: ReadonlyArray<number>;
  /** When kind === "custom": relative paths under the book directory to
   *  include in the review context. Accepts files or directories. */
  readonly paths?: ReadonlyArray<string>;
  /** Convenience preset toggles for foundation review (kept in a single
   *  struct so the frontend can expose checkboxes without building path lists). */
  readonly foundationTargets?: {
    readonly storyFrame?: boolean;
    readonly volumeMap?: boolean;
    // Classic structured-state artifacts (kept for backward compatibility;
    // maps to the corresponding canonical files under story/).
    readonly rhythm?: boolean;
    readonly bookRules?: boolean;
    readonly roles?: boolean;
    readonly authorIntent?: boolean;
    readonly currentFocus?: boolean;
    readonly styleGuide?: boolean;
    readonly pendingHooks?: boolean;
    // Reader-facing foundation components (exposed as checkboxes in the
    // Studio Automation "基础设定目标" UI). Each flag maps to one or more
    // files under story/ when the backend expands the review unit list.
    readonly characterBible?: boolean;
    readonly worldBible?: boolean;
    readonly powerSystem?: boolean;
    readonly timelineCausal?: boolean;
    readonly locationScenes?: boolean;
    readonly plotSeeds?: boolean;
  };
}

export function defaultReviewScope(target: WorkflowTarget): ReviewScope {
  switch (target) {
    case "review-foundation":
      return {
        kind: "foundation",
        foundationTargets: {
          // Structured-state artifacts (review-foundation's original set)
          storyFrame: true,
          volumeMap: true,
          rhythm: false,
          bookRules: true,
          roles: true,
          authorIntent: true,
          currentFocus: true,
          styleGuide: true,
          pendingHooks: true,
          // Reader-facing foundation components (added so Studio UI can
          // expose intuitive checkboxes without callers enumerating files).
          characterBible: true,
          worldBible: true,
          powerSystem: false,
          timelineCausal: false,
          locationScenes: false,
          plotSeeds: true,
        },
      };
    case "review-chapters":
      return { kind: "chapters" };
    case "review":
    default:
      return { kind: "project" };
  }
}

/**
 * Validate that a review scope is internally consistent. Returns null on
 * success, otherwise a user-facing Chinese error string (matches the UI
 * contract used by validateWorkflowSteps).
 */
export function validateReviewScope(scope: unknown, target: WorkflowTarget): string | null {
  if (target !== "review" && target !== "review-chapters" && target !== "review-foundation") return null;
  if (scope === undefined || scope === null) return `审查流程「${target}」需要选择审查范围`;
  const s = scope as Partial<ReviewScope>;
  if (!s.kind || !["project", "foundation", "chapters", "custom"].includes(s.kind)) {
    return "审查范围类型不合法";
  }
  if (s.kind === "chapters" || s.kind === "project") {
    if (s.chapterList && s.chapterList.length > 0) {
      if (!s.chapterList.every((n) => Number.isFinite(n) && (n as number) > 0)) return "chapterList 里必须是正整数章节号";
    } else if (s.startChapter !== undefined || s.endChapter !== undefined) {
      const start = s.startChapter ?? 1;
      const end = s.endChapter ?? Number.MAX_SAFE_INTEGER;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        return "章节区间不合法（startChapter ≤ endChapter，且都 ≥ 1）";
      }
    }
  }
  if (s.kind === "custom") {
    if (!s.paths || s.paths.length === 0) return "custom 范围需要至少提供一个路径";
  }
  return null;
}

export function validateWorkflowSteps(steps: ReadonlyArray<WorkflowStep>): string | null {
  if (steps.length === 0) return "工作流至少要有一个步骤";
  const seen = new Set<string>();
  for (const s of steps) {
    if (!s.agent || !BUILTIN_AGENT_NAMES.includes(s.agent)) return `步骤包含未知 Agent：${String(s.agent)}`;
    if (seen.has(s.id)) return `步骤 ID 重复：${s.id}`;
    seen.add(s.id);
  }
  return null;
}
