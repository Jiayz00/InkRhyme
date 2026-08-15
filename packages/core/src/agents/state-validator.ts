import { BaseAgent } from "./base.js";

export interface ValidationWarning {
  readonly category: string;
  readonly description: string;
}

export interface ValidationResult {
  readonly warnings: ReadonlyArray<ValidationWarning>;
  readonly passed: boolean;
}

export interface StateValidationAuthorityContext {
  readonly storyFrame?: string;
  readonly bookRules?: string;
  readonly chapterSummaries?: string;
}

/**
 * Validates Settler output by comparing old and new truth files via LLM.
 * Catches contradictions, missing state changes, and temporal inconsistencies.
 *
 * Uses a minimal verdict protocol instead of requiring structured JSON:
 *   Line 1: PASS or FAIL
 *   Remaining lines: free-form warnings (one per line, optional category prefix)
 */
export class StateValidatorAgent extends BaseAgent {
  get name(): string {
    return "state-validator";
  }

  async validate(
    chapterContent: string,
    chapterNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    language: "zh" | "en" = "zh",
    authorityContext?: StateValidationAuthorityContext,
  ): Promise<ValidationResult> {
    const stateDiff = this.computeDiff(oldState, newState, "State Card");
    const hooksDiff = this.computeDiff(oldHooks, newHooks, "Hooks Pool");

    // Skip validation if nothing changed
    if (!stateDiff && !hooksDiff) {
      return { warnings: [], passed: true };
    }

    // Fast path: local rule-based validation. If no suspicious patterns
    // are found AND no authority context is provided, skip the LLM call
    // entirely (saves 1 network roundtrip). When authorityContext is
    // provided, cross-file semantic checks require the LLM.
    if (!authorityContext) {
      const localResult = this.fastValidate(
        chapterContent,
        chapterNumber,
        oldState,
        newState,
        oldHooks,
        newHooks,
        stateDiff,
        hooksDiff,
      );
      if (localResult.passed && localResult.warnings.length === 0) {
        return localResult;
      }

      // If local rules found hard contradictions, fail immediately without LLM.
      if (!localResult.passed) {
        return localResult;
      }
    }

    const langInstruction = language === "en"
      ? "Respond in English."
      : "用中文回答。";

    const systemPrompt = `You are a continuity validator for a novel writing system. ${langInstruction}

Given the chapter text and the CHANGES made to truth files (state card + hooks pool), check for contradictions:

1. State change without narrative support — truth file says something changed but the chapter text doesn't describe it
2. Missing state change — chapter text describes something happening but the truth file didn't capture it
3. Temporal impossibility — character moves locations without transition, injury heals without time passing
4. Hook anomaly — a hook disappeared without being marked resolved, or a new hook has no basis in the chapter
5. Retroactive edit — truth file change implies something happened in a PREVIOUS chapter, not the current one
6. Cross-truth key-setting conflict — numbered rules, named laws, ranks, identities, locations, or relationship labels in the new truth files contradict the chapter text or the authority context

Output format (simple, NOT JSON):
- First line: exactly PASS or FAIL (nothing else on this line)
- Following lines: one warning per line, optionally prefixed with [category]
- If no issues at all, just output: PASS

Example:
PASS
[unsupported_change] State card says character moved to the forest, but text only shows intent
[minor] Hook H03 advanced but text mention is brief

Or if there are hard contradictions:
FAIL
[contradiction] State says character is dead but chapter text shows them speaking
[unsupported_change] New location not mentioned anywhere in chapter text

IMPORTANT: Output FAIL ONLY for hard contradictions — facts that directly conflict with the chapter text. Do NOT fail for:
- Slightly ahead-of-text inferences
- Missing details that the state card didn't capture
- Reasonable extrapolations from text
- Hook management differences that don't contradict text
These should be warnings with PASS, not FAIL.`;

    const authorityBlock = this.buildAuthorityContextBlock(authorityContext);

    const userPrompt = `Chapter ${chapterNumber} validation:

${authorityBlock}

## State Card Changes
${stateDiff || "(no changes)"}

## Hooks Pool Changes
${hooksDiff || "(no changes)"}

## Chapter Text (for reference)
${chapterContent}`;

    try {
      const response = await this.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { temperature: 0.1 },
      );

      return this.parseResult(response.content);
    } catch (error) {
      this.log?.warn(`State validation failed: ${error}`);
      throw error;
    }
  }

  /**
   * Local rule-based validation — zero LLM cost.
   *
   * Checks for structural anomalies that can be detected without semantic
   * understanding. Returns { passed: true, warnings: [] } when everything
   * looks clean (caller can skip LLM validation). Returns { passed: false }
   * for hard contradictions. Returns { passed: true, warnings: [...] } for
   * suspicious patterns that warrant LLM review.
   */
  private fastValidate(
    chapterContent: string,
    chapterNumber: number,
    oldState: string,
    newState: string,
    oldHooks: string,
    newHooks: string,
    stateDiff: string | null,
    hooksDiff: string | null,
  ): ValidationResult {
    const warnings: ValidationWarning[] = [];

    // 1. Empty new state — hard fail
    if (newState.trim().length === 0 && oldState.trim().length > 0) {
      return {
        passed: false,
        warnings: [{
          category: "empty_state",
          description: `State card became empty after chapter ${chapterNumber}`,
        }],
      };
    }

    // 2. Hook anomaly — hooks that vanished without resolution marker
    if (hooksDiff) {
      const oldHookIds = this.extractHookIds(oldHooks);
      const newHookIds = new Set(this.extractHookIds(newHooks));
      const resolutionMarkers = /(?:resolved|paid.?off|recycled|closed|completed|废弃|回收|兑现|结束)/i;

      for (const hookId of oldHookIds) {
        if (!newHookIds.has(hookId)) {
          // Check if the diff mentions resolution
          const hookLine = oldHooks.split("\n").find((l) => l.includes(hookId));
          if (hookLine && !resolutionMarkers.test(hookLine)) {
            // Check if the hook appears in the removed section of the diff
            const removedPattern = new RegExp(`^- .*${hookId}`, "m");
            if (removedPattern.test(hooksDiff)) {
              // Hook was removed without explicit resolution — warning, not hard fail
              warnings.push({
                category: "hook_anomaly",
                description: `Hook ${hookId} disappeared without resolution marker`,
              });
            }
          }
        }
      }

      // New hooks with no basis in chapter text
      const addedHookIds = this.extractHookIds(newHooks).filter((id) => !oldHookIds.includes(id));
      for (const hookId of addedHookIds) {
        // New hook — check if its ID or key terms appear in chapter text
        const hookLine = newHooks.split("\n").find((l) => l.includes(hookId));
        if (hookLine) {
          // Extract a keyword from the hook line (first few chars after the ID)
          const keyword = hookLine.replace(hookId, "").trim().slice(0, 20);
          if (keyword.length > 3 && !chapterContent.includes(keyword)) {
            warnings.push({
              category: "hook_anomaly",
              description: `New hook ${hookId} may lack basis in chapter text`,
            });
          }
        }
      }
    }

    // 3. Retroactive edit — diff references chapters before current
    if (stateDiff) {
      const retroactivePattern = /第\s*(\d+)\s*章|chapter\s+(\d+)/gi;
      let match: RegExpExecArray | null;
      while ((match = retroactivePattern.exec(stateDiff)) !== null) {
        const refChapter = parseInt(match[1] ?? match[2] ?? "0", 10);
        if (refChapter > 0 && refChapter < chapterNumber) {
          warnings.push({
            category: "retroactive_edit",
            description: `State diff references chapter ${refChapter} (current: ${chapterNumber})`,
          });
        }
      }
    }

    // 4. Basic structural — new state should have some content structure.
    // Only warn if the state is substantial (>200 chars) but lacks any
    // recognizable structure (headings, key-value pairs, list items).
    if (newState.trim().length > 200 && !newState.includes("#") && !newState.includes("：") && !newState.includes(":") && !newState.includes("- ") && !newState.includes("|")) {
      warnings.push({
        category: "structural",
        description: "New state card lacks any section headings or key-value structure",
      });
    }

    return { warnings, passed: true };
  }

  /** Extract hook IDs from pending_hooks markdown. */
  private extractHookIds(hooksMarkdown: string): string[] {
    const ids: string[] = [];
    // Match patterns like "H001", "H01", "hook-001", or lines starting with | ID
    const patterns = [
      /\b(H\d{2,4})\b/g,
      /\b(hook[-_]?\d{1,4})\b/gi,
      /^\|\s*([A-Z0-9_-]{2,10})\s*\|/gm,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(hooksMarkdown)) !== null) {
        ids.push(match[1]!);
      }
    }
    return [...new Set(ids)];
  }

  private computeDiff(oldText: string, newText: string, label: string): string | null {
    if (oldText === newText) return null;

    const oldLines = oldText.split("\n").filter((l) => l.trim());
    const newLines = newText.split("\n").filter((l) => l.trim());

    const added = newLines.filter((l) => !oldLines.includes(l));
    const removed = oldLines.filter((l) => !newLines.includes(l));

    if (added.length === 0 && removed.length === 0) return null;

    const parts = [`### ${label}`];
    if (removed.length > 0) parts.push("Removed:\n" + removed.map((l) => `- ${l}`).join("\n"));
    if (added.length > 0) parts.push("Added:\n" + added.map((l) => `+ ${l}`).join("\n"));
    return parts.join("\n");
  }

  private buildAuthorityContextBlock(authorityContext?: StateValidationAuthorityContext): string {
    if (!authorityContext) return "## Authority / Cross-Truth Context\n(no authority context provided)";

    const storyFrame = (authorityContext.storyFrame ?? "").trim();
    const bookRules = (authorityContext.bookRules ?? "").trim();
    const chapterSummaries = (authorityContext.chapterSummaries ?? "").trim();

    return [
      "## Authority / Cross-Truth Context",
      "Authority priority: current chapter text > runtime truth files/current summaries > story_frame/book_rules > legacy story_bible intro or marketing-style prose. If the current chapter establishes a numbered/name mapping, new truth files must follow that mapping instead of preserving an older intro-only version.",
      "",
      "### story_frame / legacy story_bible excerpt",
      storyFrame || "(empty)",
      "",
      "### book_rules excerpt",
      bookRules || "(empty)",
      "",
      "### recent chapter_summaries excerpt",
      chapterSummaries || "(empty)",
    ].join("\n");
  }

  private parseResult(content: string): ValidationResult {
    const trimmed = content.trim();
    if (!trimmed) {
      throw new Error("LLM returned empty response");
    }

    const jsonResult = this.tryParseJsonResult(trimmed);
    if (jsonResult) {
      return jsonResult;
    }

    const lines = trimmed.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) {
      throw new Error("LLM returned empty response");
    }

    const verdictLine = lines[0]!;
    if (!/^(PASS|FAIL)$/i.test(verdictLine)) {
      throw new Error("State validator returned invalid response");
    }
    const passed = /^PASS$/i.test(verdictLine);

    const warnings: ValidationWarning[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^(PASS|FAIL)$/i.test(line)) continue;

      const categoryMatch = line.match(/^\[([^\]]+)\]\s*(.+)$/);
      if (categoryMatch) {
        warnings.push({
          category: categoryMatch[1]!.trim(),
          description: categoryMatch[2]!.trim(),
        });
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        warnings.push({
          category: "general",
          description: line.slice(2).trim(),
        });
      } else if (line.length > 5) {
        warnings.push({
          category: "general",
          description: line,
        });
      }
    }

    return { warnings, passed };
  }

  private tryParseJsonResult(text: string): ValidationResult | null {
    const direct = this.tryParseExactJsonResult(text);
    if (direct) {
      return direct;
    }

    const candidate = extractBalancedJsonObject(text);
    if (!candidate) {
      return null;
    }
    return this.tryParseExactJsonResult(candidate);
  }

  private tryParseExactJsonResult(text: string): ValidationResult | null {
    try {
      const parsed = JSON.parse(text) as {
        warnings?: Array<{ category?: string; description?: string }>;
        passed?: boolean;
      };
      if (typeof parsed.passed !== "boolean") return null;
      return {
        warnings: (parsed.warnings ?? []).map((w) => ({
          category: w.category ?? "unknown",
          description: w.description ?? "",
        })),
        passed: parsed.passed,
      };
    } catch {
      return null;
    }
  }
}

function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!;

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        endIndex = index;
        break;
      }
      if (depth < 0) {
        return null;
      }
    }
  }

  if (endIndex < 0) return null;

  // Only accept the candidate if what follows the closing brace is
  // nothing, whitespace, or a structural JSON terminator.
  // This rejects trailing content like "{...} more text here"
  const followingChar = text[endIndex + 1];
  if (
    followingChar !== undefined &&
    followingChar !== "\n" &&
    followingChar !== "\r" &&
    followingChar !== "\t" &&
    followingChar !== " " &&
    followingChar !== "," &&
    followingChar !== "]" &&
    followingChar !== "}"
  ) {
    return null;
  }

  return text.slice(start, endIndex + 1);
}
