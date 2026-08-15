// Browser-safe pure constant module — no Node.js imports.
// Kept separate from pipeline/runner.ts so the Studio frontend can import it
// via the "@inkrhyme/core/agents/builtin-names" subpath without pulling
// Node-only modules (node:fs, node:async_hooks, undici, ...) through the barrel.
export const BUILTIN_AGENT_NAMES = Object.freeze([
  "architect",
  "writer",
  "auditor",
  "reviser",
  "planner",
  "composer",
  "continuity-auditor",
  "state-validator",
  "foundation-reviewer",
  "length-normalizer",
  "polisher",
  "consolidator",
  "radar",
] as const);

export type BuiltinAgentName = (typeof BUILTIN_AGENT_NAMES)[number];

export type AgentPhase =
  | "foundation"
  | "planning"
  | "writing"
  | "governance"
  | "revision"
  | "post-write"
  | "market";

export interface AgentCapability {
  /** Agent 中文显示名 */
  readonly labelZh: string;
  /** Agent 英文显示名 */
  readonly labelEn: string;
  /** 能力说明 — 中文（悬停展示） */
  readonly descriptionZh: string;
  /** 能力说明 — 英文（悬停展示） */
  readonly descriptionEn: string;
  /** 工作流阶段分类（用于自动化工作流的分组与推荐顺序） */
  readonly phase: AgentPhase;
  /** 推荐执行顺序（同阶段内的顺序），数字越小越靠前 */
  readonly order: number;
  /** 是否可单独执行（用于默认启用/禁用） */
  readonly optional: boolean;
  /** 典型输入（用于 UI 提示工作流衔接），中文短描述 */
  readonly inputHintZh?: string;
  /** 典型输出（用于 UI 提示工作流衔接），中文短描述 */
  readonly outputHintZh?: string;
  /** 可配置参数 key → 说明；执行时会作为 runner 选项传入 */
  readonly options?: Readonly<Record<string, readonly [string, string]>>;
}

export const AGENT_CAPABILITIES: Readonly<Record<BuiltinAgentName, AgentCapability>> = {
  architect: {
    labelZh: "架构师",
    labelEn: "Architect",
    descriptionZh: "基于题材、参考文本或大纲，生成世界观、角色、剧情弧、规则体系等基础设定；支持正篇、番外、仿写、续写、同人、互动影游、分支互动、开放世界、短篇、剧本、分镜等模式。",
    descriptionEn: "Builds the foundation: world, characters, plot arc, rules, numerical system. Supports novel, short story, fanfic, spinoff, imitation, continuation, branching, interactive, open world, screenplay and storyboard modes.",
    phase: "foundation",
    order: 10,
    optional: false,
    outputHintZh: "foundation/ 目录：world.md、characters.md、plot.md、rules.md、numerical.md",
  },
  planner: {
    labelZh: "章节规划师",
    labelEn: "Planner",
    descriptionZh: "按世界观和已有故事线生成下一章的章意图：章节目标、关键事件、出场角色、矛盾/转折、情绪节奏、与前文冲突点预判。",
    descriptionEn: "Plans the next chapter: goal, key events, cast, conflicts, emotional beat, foreshadowing, flags, and potential continuity risks against current state.",
    phase: "planning",
    order: 10,
    optional: false,
    inputHintZh: "基础设定 + 已有章节（truth 索引 + 叙事记忆）",
    outputHintZh: "intent.yaml（章意图、事件清单、规则检查清单）",
  },
  composer: {
    labelZh: "上下文装配师",
    labelEn: "Composer",
    descriptionZh: "将章意图、基础设定、真相文件、叙事记忆、规则栈、输入治理跟踪组装为下一章的运行时上下文包，是治理层 v2 的核心。",
    descriptionEn: "Assembles the chapter runtime context from intent, foundation, truth files, narrative memory, rule stack and governance trace. The backbone of input governance v2.",
    phase: "planning",
    order: 20,
    optional: false,
    inputHintZh: "intent.yaml + foundation + truth files + memory index",
    outputHintZh: "context.md, rule-stack.yaml, governance trace",
  },
  writer: {
    labelZh: "写手",
    labelEn: "Writer",
    descriptionZh: "按上下文包和章意图写出章节正文草稿，同步生成真相文件（人物、地点、物品、事件），并更新结构化状态与叙事记忆索引。",
    descriptionEn: "Writes the chapter body draft from runtime context. Also produces per-chapter truth files (persons/locations/objects/events) and keeps structured state + narrative memory in sync.",
    phase: "writing",
    order: 10,
    optional: false,
    inputHintZh: "composer 输出的上下文包 + 章意图",
    outputHintZh: "章节 .md + truths/ 新增 + chapter index 条目",
    options: {
      lengthTarget: ["字数目标/章节长度", "例：3500。超过或不足由 length-normalizer 后续修正"],
      styleGuideEnabled: ["参考文风", "若项目启用文风包，写作时会结合 style guide"],
    },
  },
  "state-validator": {
    labelZh: "状态校验",
    labelEn: "State Validator",
    descriptionZh: "读取刚写完的章节与真相文件，校验结构化状态（人物属性、物品归属、地图可达）与叙事记忆索引是否一致，发现不匹配会列出差异。",
    descriptionEn: "Cross-checks freshly written chapters + truth files against structured state & narrative memory. Lists discrepancies (person/place/item/event mismatch) before downstream audits.",
    phase: "governance",
    order: 10,
    optional: true,
    inputHintZh: "writer 输出的章节 + truths + structured state",
  },
  "continuity-auditor": {
    labelZh: "前后一致性审计",
    labelEn: "Continuity Auditor",
    descriptionZh: "对章节正文做前后一致性审查：时间线、角色行为/情绪、人物/地点/道具的命名与属性、伏笔回收/未回收、逻辑链条断裂、设定自相矛盾。生成修复清单。",
    descriptionEn: "Audits the chapter for continuity: timeline, character behavior & mood, named entities consistency, planted/harvested Chekhov's guns, broken logical chains, contradicting world rules. Produces a fix list.",
    phase: "governance",
    order: 20,
    optional: false,
    options: {
      strictness: ["严格度", "strict：每条问题都要求修订；lenient：只修关键问题；always：直接交付 reviser 重写"],
    },
  },
  auditor: {
    labelZh: "综合评审",
    labelEn: "Auditor",
    descriptionZh: "在 continuity-auditor 之后做主观质量评审：文风统一度、节奏、张力、角色弧光、对话自然度、章结尾钩子、主题契合度。可与 reviewer 配合。",
    descriptionEn: "Subjective quality pass after continuity audit: voice consistency, pacing, tension, character arc, dialogue naturalness, ending hook, theme alignment. Used as input to reviser.",
    phase: "governance",
    order: 30,
    optional: true,
  },
  reviser: {
    labelZh: "修订师",
    labelEn: "Reviser",
    descriptionZh: "基于 auditor / continuity-auditor / state-validator 的问题清单回写章节；支持 strict/lenient/always 三种模式，并保留修订前快照。",
    descriptionEn: "Applies fixes from auditor, continuity-auditor and state-validator back into the chapter. Supports strict / lenient / always modes and preserves pre-revision snapshots.",
    phase: "revision",
    order: 10,
    optional: false,
    inputHintZh: "章节草稿 + auditor/continuity/state 问题清单",
    outputHintZh: "修订后的章节 .md + .snapshot 存档",
    options: {
      reviseMode: ["修订模式", "strict：逐项修复；lenient：仅关键问题；always：整体重写"],
      maxPasses: ["最大修订轮次", "1-5，超过后停止并交付当前结果"],
    },
  },
  "foundation-reviewer": {
    labelZh: "基础设定复核",
    labelEn: "Foundation Reviewer",
    descriptionZh: "在修订或写章时，检查对基础设定的新增/修改是否破坏世界观一致性；需要时反向回写 world/characters/plot 等文档。",
    descriptionEn: "Validates whether writing/revision introduced changes that break foundation consistency, and writes back updates to world/characters/plot docs when safe to do so.",
    phase: "revision",
    order: 20,
    optional: true,
  },
  "length-normalizer": {
    labelZh: "长度校准",
    labelEn: "Length Normalizer",
    descriptionZh: "把章节正文字数校准到目标区间：偏短时扩展场景细节、对话、感官描写；偏长时压缩重复描述、合并次级场景。保持剧情意图不变。",
    descriptionEn: "Tunes chapter word count to the target range: shortens verbosity or expands scenes with sensory / dialogue detail, without altering the chapter intent.",
    phase: "post-write",
    order: 10,
    optional: true,
    options: {
      minRatio: ["最短比例", "低于目标多少比例触发扩展，例：0.9"],
      maxRatio: ["最长比例", "超过目标多少比例触发压缩，例：1.1"],
    },
  },
  polisher: {
    labelZh: "润色",
    labelEn: "Polisher",
    descriptionZh: "最后一道纯文本润色：同义替换、句式变化、标点规范、冗余用词删除、节奏微调。不改变剧情与事实，只提升阅读流畅度与文字质感。",
    descriptionEn: "Final pure-text polish pass: synonym replacement, sentence rhythm, punctuation, trimming word redundancy. Never changes plot or facts, only readability and texture.",
    phase: "post-write",
    order: 20,
    optional: true,
    options: {
      style: ["风格偏好", "literary：文学性；concise：精炼；default：均衡"],
    },
  },
  consolidator: {
    labelZh: "真相汇总",
    labelEn: "Consolidator",
    descriptionZh: "合并本章产生的真相文件与项目级全局真相索引，去重，解决冲突（以最后写入为准或按策略），并生成/刷新供下游使用的实体引用清单。",
    descriptionEn: "Consolidates per-chapter truth files into project-level global truth indexes: dedupe, conflict resolution, refreshed entity reference lists for downstream agents.",
    phase: "post-write",
    order: 30,
    optional: true,
  },
  radar: {
    labelZh: "市场雷达",
    labelEn: "Radar",
    descriptionZh: "按定时任务或手动触发，爬取外部榜单/话题/同类作品表现，生成趋势简报，帮助 project architect 在开书或重构方向时做参考。",
    descriptionEn: "Crawls external rankings, trending topics and comparable works on schedule or manually; produces trend briefs for the architect to reference when opening or refactoring a book.",
    phase: "market",
    order: 10,
    optional: true,
    options: {
      regions: ["地区", "例：zh, en, jp，逗号分隔"],
      keywords: ["关键词", "例：玄幻,无限流,快穿"],
    },
  },
};

export const AGENT_PHASE_LABELS: Readonly<Record<AgentPhase, readonly [string, string]>> = {
  foundation: ["基础设定", "Foundation"],
  planning: ["章节规划", "Planning"],
  writing: ["写章", "Writing"],
  governance: ["治理/审计", "Governance"],
  revision: ["修订", "Revision"],
  "post-write": ["写后处理", "Post-write"],
  market: ["市场", "Market"],
};

const PHASE_RANK: Record<AgentPhase, number> = {
  foundation: 1,
  planning: 2,
  writing: 3,
  governance: 4,
  revision: 5,
  "post-write": 6,
  market: 7,
};
function phaseOrder(p: AgentPhase): number { return PHASE_RANK[p]; }

export const AGENT_ORDER: ReadonlyArray<BuiltinAgentName> = [...BUILTIN_AGENT_NAMES].sort(
  (a, b) =>
    phaseOrder(AGENT_CAPABILITIES[a].phase) * 1000 + AGENT_CAPABILITIES[a].order
    - (phaseOrder(AGENT_CAPABILITIES[b].phase) * 1000 + AGENT_CAPABILITIES[b].order),
);
