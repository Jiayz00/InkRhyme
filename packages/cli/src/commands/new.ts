import { Command } from "commander";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { initializeProjectDirectory } from "../project-bootstrap.js";
import { GLOBAL_ENV_PATH, log, logError } from "../utils.js";
import { seedProjectBuiltinMaterials } from "@inkrhyme/core";

const require = createRequire(import.meta.url);

const WRITER_PROMPT_CONTENT = `# Longform Writer — 写作质量内建规范（去AI味 + 网文创作约束）

> Project-level prompt pack override. Built-in default copy is already
> enforced by InkOS's longform.writer prompt-pack slot. Keep this file only
> for per-project tuning; edits here take precedence over the builtin copy.

你是长篇网文章节写手。在 InkOS 既有的创作规则与输入治理基础上，额外遵守以下硬规则。

## 一、去 AI 味硬规则（写作时禁止）

1. 禁用 AI 高频词：此外/至关重要/深入探讨/强调/持久的/增强/培养/突出/复杂/复杂性/关键性的/格局/展示/宝贵的/充满活力/无缝/织锦/证明/奠定基础/彰显/凸显。
2. 禁"不仅仅…而是…""不是…而是…"否定式排比；也禁"没有X，没有Y，只是Z"。
3. 禁三段式法则：同一句/同段落把想法强行排成三个并列项。
4. 禁破折号（—）滥用、禁粗体强调滥用。
5. 禁"-之所以/这…彰显/凸显/反映了…"式肤浅总结句。
6. 禁模糊归因："专家认为""有数据显示""行业报告显示"而无具体来源。
7. 禁填充短语："值得注意的是""在这个时间点""为了实现这一目标""由于…的事实"。
8. 禁过度限定："可能潜在或许大概"堆叠。
9. 禁通用积极结尾："未来看起来光明""激动人心的时代""迈向正确方向"。
10. 禁夸大的象征意义："作为…的证明/见证/里程碑/不可磨灭的印记""深深植根于"。
11. 禁向读者喊话的协作痕迹："希望这对您有帮助""当然！""请告诉我"。写作正文不出现聊天腔。
12. 禁知识截止/来源类免责声明残句："根据我的训练数据""基于现有信息"。

## 二、写作节奏与句式（要求）

13. 每段长短句交替，避免连续三句同长；避免段落都以简洁单行句收尾。
14. 对话必须推进剧情或揭示性格，杜绝信息型对话（"你知道…吧""是这样的…"的科普腔）。
15. 用具体细节代替抽象概括；用动作和物件状态代替心理独白凑字。
16. 展示而非讲述：让读者从场景推知，不做叙述者总结。

## 三、网文创作约束

17. 每章必须有明确的目标情绪，所有场景服务该情绪；说不清交付什么情绪的场景不写。
18. 章首 500 字必须有钩子，不从天气/风景平淡开场（除非反差极大）。
19. 章尾必须留悬念钩子：矛盾升级、新信息、威胁逼近、决定待下，让读者想翻下一页。
20. 每章必须有冲突或转折（冲突驱动剧情），纯过渡章也要有信息/关系/代价/选择/伏笔的推进。
21. 爽点/打脸/反转要铺垫充分、释放干脆：先有可指认的危机或期待段落，再给结果；读者等得越久释放越爽。
22. 高压/推进章每 3000-5000 字一个"爽"的情绪节点；低压/关系章不强求，但每章仍要有往下看的理由。
23. 禁信息型角色当科普嘴：高压/生死/悲痛节拍收紧对话声线，对话逐句承接对方情绪。
24. 装逼/打脸/揭露章必须写在场配角的差异化反应（集体震惊/各异），不只写主角动作。
25. 打斗不流水账：写策略、反转与代价，不写"你一拳我一脚"。
26. 正文不出现写作工程词（第X章/上一章/本章/前文/伏笔/细纲/读者等），需承接前文时用角色可感知的事件锚点或相对时间。
27. 细纲优先边界：正文只展开本章细纲已有事件、人物、冲突与结尾钩子；不得为凑字自造新主线/新角色/新反转。
28. 任务卡点只在角色本来有要办的事、且能卡出信息/关系/代价/选择/伏笔变化时使用；没有就不强补。

## 四、禁止违背上层约束

29. 不覆盖作者意图、当前焦点、硬事实与活跃钩子；不得因题材默认或风格偏好违反 protected context。
30. 状态与结构以 InkOS 管理为准（books/<id>/story/ 下的设定/大纲/正文由 InkOS 自身维护）；不得在项目根另建 oh-story 式平行目录。

优先级：protected context 与作者意图最高；本节规则其次；题材默认最后。
`;

const REVISER_PROMPT_CONTENT = `# Longform Reviser — 修订质量规范（去AI味 + 连续性）

> Project-level prompt pack override. Built-in default copy is already
> enforced by InkOS's longform.reviser prompt-pack slot. Keep this file only
> for per-project tuning.

你是长篇章节修订者。在修复审计发现的问题时，遵守：

1. 保留既有事实、章节目标与作者意图；不得为"改得更顺"而改写连续性事实或伏笔状态。
2. 按 writer 规则修复 AI 痕迹：AI 高频词、否定式排比、三段式、破折号滥用、肤浅总结句、模糊归因、填充短语、过度限定、通用积极结尾、夸大象征意义、聊天腔、知识截止类免责声明残句。
3. 修复后保持：长短句交替、对话推进剧情、具体细节、章尾钩子完整。
4. 若修复需要改变更高层状态（事实/大纲/伏笔），不要静默改写，显式提出该需要。
5. 不在 books/ 之外创建任何追踪/对标/拆文库/设定/大纲目录。
6. 未解决的审计问题要如实报告，不得把失败的章节标记为已修复。
`;

async function exists(path: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then((m) => m.access(path));
    return true;
  } catch {
    return false;
  }
}

async function writeIfChanged(
  target: string,
  content: string,
  overwrite: boolean,
): Promise<boolean> {
  if (!overwrite && existsSync(target)) return false;
  await mkdir(dirnameSafe(target), { recursive: true });
  await writeFile(target, content, "utf-8");
  return true;
}

function dirnameSafe(path: string): string {
  return dirname(path);
}

export const newCommand = new Command("new")
  .description(
    "Create a new InkOS project with prompt pack + methodology materials + reference database seeded (one-shot).",
  )
  .argument("[name]", "Project name (creates subdirectory). Omit to init current directory.")
  .option(
    "--lang <language>",
    "Default writing language: zh (Chinese) or en (English)",
    "zh",
  )
  .option(
    "--materials-dir <dir>",
    "Override source directory for builtin reference markdown (advanced).",
  )
  .option(
    "--skip-seed",
    "Skip step that seeds .inkos/materials with the bundled reference library.",
    false,
  )
  .option(
    "--skip-prompts",
    "Skip step that copies prompt/longform/(writer+reviser).md project overrides.",
    false,
  )
  .action(async (name: string | undefined, opts: {
    readonly lang?: string;
    readonly materialsDir?: string;
    readonly skipSeed?: boolean;
    readonly skipPrompts?: boolean;
  }) => {
    const projectDir = name ? resolve(process.cwd(), name) : process.cwd();
    const language: "zh" | "en" = opts.lang === "en" ? "en" : "zh";

    try {
      const inkosJsonPath = join(projectDir, "inkos.json");
      const projectAlreadyInited = existsSync(inkosJsonPath);

      // ---- Step 1: inkos init
      log("[1/5] Initialize project skeleton");
      if (projectAlreadyInited) {
        log(`       inkos.json already exists — skip init (overwrite support files disabled).`);
      } else {
        await mkdir(projectDir, { recursive: true });
        await initializeProjectDirectory(projectDir, {
          language,
          overwriteSupportFiles: true,
        });
        log(`       Project initialized at ${projectDir}`);
      }

      // ---- Step 2: inject prompt pack overrides
      let promptOk = false;
      if (opts.skipPrompts) {
        log("[2/5] Inject prompt-pack overrides — skipped (--skip-prompts)");
      } else {
        log("[2/5] Inject writing-quality prompt-pack overrides");
        const promptDir = join(projectDir, "prompt", "longform");
        await mkdir(promptDir, { recursive: true });
        const writerWrote = await writeIfChanged(
          join(promptDir, "writer.md"),
          WRITER_PROMPT_CONTENT,
          true,
        );
        const reviserWrote = await writeIfChanged(
          join(promptDir, "reviser.md"),
          REVISER_PROMPT_CONTENT,
          true,
        );
        promptOk = writerWrote || reviserWrote;
        log(`       prompt/longform/${writerWrote ? "(writer+reviser).md written" : "(writer+reviser).md re-synced"}`);
      }

      // ---- Step 3: sync methodology md to .novel/oh-story/ for transparency
      // (seed step does the real ingestion. This step exposes the raw md so the
      // user can open / diff / augment their methodology copies inside the
      // project. Also serves as the source for future re-runs of `ingest_seed`
      // by the agent.)
      log("[3/5] Copy builtin methodology library into project transparency folder");
      const ohDir = join(projectDir, ".novel", "oh-story");
      await mkdir(ohDir, { recursive: true });
      let methodologyCopied = 0;
      try {
        const mdSourceDir = opts.materialsDir ?? (() => {
          // Resolve the bundled seed-materials via the installed core package.
          try {
            const pkgPath = require.resolve("@inkrhyme/core/package.json");
            const candidate = join(dirname(pkgPath), "seed-materials");
            return existsSync(candidate) ? candidate : "";
          } catch {
            return "";
          }
        })();

        if (mdSourceDir && existsSync(mdSourceDir)) {
          const mds = (await readdir(mdSourceDir))
            .filter((f) => f.toLowerCase().endsWith(".md"))
            .sort();
          // First remove stale entries (md no longer present upstream)
          // but only inside the transparency folder (never parent dirs).
          const existingOh = (await readdir(ohDir))
            .filter((f) => f.toLowerCase().endsWith(".md"));
          for (const existing of existingOh) {
            if (!mds.includes(existing)) {
              try { await rm(join(ohDir, existing), { force: true }); } catch { /* ignore */ }
            }
          }
          for (const md of mds) {
            const src = join(mdSourceDir, md);
            const dst = join(ohDir, basename(md));
            const { readFile } = await import("node:fs/promises");
            const content = await readFile(src, "utf-8");
            await writeIfChanged(dst, content, true);
            methodologyCopied += 1;
          }
          log(`       .novel/oh-story/ — ${methodologyCopied} methodology markdown synced (stale removed).`);
        } else {
          log(`       [warn] Could not resolve builtin methodology source. Methodology copy skipped.`);
          log(`       Hint: pass --materials-dir <path-to-core/seed-materials>.`);
        }
      } catch (err) {
        log(`       [warn] Methodology copy failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // ---- Step 4: seed material database .inkos/materials
      let seedOk = false;
      if (opts.skipSeed) {
        log("[4/5] Seed material database — skipped (--skip-seed)");
      } else {
        log("[4/5] Seed .inkos/materials with builtin reference library");
        try {
          const result = await seedProjectBuiltinMaterials(projectDir, {
            sourceDir: opts.materialsDir,
          });
          seedOk = result.seeded.length > 0;
          log(`       Cleaned ${result.cleaned} prior builtin seeds. Seeded ${result.seeded.length} reference cards.`);
          const sample = result.seeded.slice(0, 3);
          for (const s of sample) log(`         - ${s.title}`);
          if (result.seeded.length > sample.length) {
            log(`         ... and ${result.seeded.length - sample.length} more.`);
          }
        } catch (err) {
          log(`       [warn] Seed failed: ${err instanceof Error ? err.message : String(err)}`);
          log(`       Your project is ready; re-run with --materials-dir to seed later.`);
        }
      }

      // ---- Step 5: report
      log("");
      log("============================================================");
      log(` [ok] Project ready: ${projectDir}`);
      log(" ------------------------------------------------------------");
      if (!promptOk && !opts.skipPrompts) log(` !  prompt-pack overrides not present (check write permissions).`);
      if (methodologyCopied === 0) log(` !  methodology md not synced.`);
      if (!seedOk && !opts.skipSeed) log(` !  material database NOT seeded — reference retrieval will lack oh-story library.`);
      const globalConfigured = await hasGlobalConfig();
      if (globalConfigured) {
        log(" Global LLM config detected. Ready to go!");
      } else {
        log(" Next: configure global LLM (once) OR edit .env inside the project:");
        log("   inkos config set-global --provider openai --base-url <url> --api-key <key> --model <m>");
      }
      log("");
      log(" Next steps:");
      if (name) {
        const rel = relativeForDisplay(process.cwd(), projectDir);
        if (rel && rel !== ".") log(`   cd "${rel}"`);
      }
      if (language === "en") {
        log("   inkos book create --title 'My Novel' --genre progression --platform royalroad --lang en");
      } else {
        log("   inkos book create --title '我的小说' --genre xuanhuan --platform tomato");
      }
      log("   inkos write next <book-id> --words 3000");
      log(" ------------------------------------------------------------");
      log(" Injected: prompt/longform/(writer+reviser).md  |  .novel/oh-story/  |  .inkos/materials/");
      log(" To re-sync prompt pack + materials later, re-run this command on the same dir (idempotent).");
      log("============================================================");
    } catch (e) {
      logError(`inkos new failed: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    }
  });

function requireResolveSafe(id: string): string | null {
  try {
    return require.resolve(id);
  } catch {
    return null;
  }
}

async function hasGlobalConfig(): Promise<boolean> {
  try {
    await import("node:fs/promises").then((m) => m.access(GLOBAL_ENV_PATH));
    return true;
  } catch {
    return false;
  }
}

function relativeForDisplay(from: string, to: string): string {
  const out = resolve(from) === resolve(to)
    ? "."
    : relative(from, to);
  return out || ".";
}
