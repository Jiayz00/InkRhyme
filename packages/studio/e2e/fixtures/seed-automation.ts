import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL(".", import.meta.url));
export const E2E_ROOT = resolve(dir, "../../../..", "test-project");
export const E2E_BOOK_ID = "automation-test";
export const E2E_CUSTOM_WORKFLOW_ID = "e2e-custom-review";

export async function seedAutomationBook(): Promise<void> {
  const bookDir = resolve(E2E_ROOT, "books", E2E_BOOK_ID);
  const chaptersDir = resolve(bookDir, "chapters");
  const storyDir = resolve(bookDir, "story");
  const outlineDir = resolve(storyDir, "outline");
  const workflowsDir = resolve(E2E_ROOT, ".inkos", "workflows");

  await mkdir(chaptersDir, { recursive: true });
  await mkdir(outlineDir, { recursive: true });
  await mkdir(workflowsDir, { recursive: true });

  const now = new Date().toISOString();

  await writeFile(
    resolve(bookDir, "book.json"),
    JSON.stringify(
      {
        id: E2E_BOOK_ID,
        title: "自动化测试书",
        platform: "other",
        genre: "测试",
        status: "active",
        targetChapters: 10,
        chapterWordCount: 3000,
        language: "zh",
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    ),
  );

  await writeFile(
    resolve(storyDir, "story_bible.md"),
    "# 故事圣经\n\n自动化测试用故事圣经。\n",
  );

  await writeFile(
    resolve(outlineDir, "story_frame.md"),
    "# 故事大纲\n\n自动化测试用大纲。\n",
  );

  await writeFile(
    resolve(chaptersDir, "ch0001_第一章.md"),
    "# 第一章\n\n这是第一章的测试内容，用于自动化审查流程。\n",
  );

  await writeFile(
    resolve(chaptersDir, "ch0002_第二章.md"),
    "# 第二章\n\n这是第二章的测试内容，用于自动化审查流程。\n",
  );

  await writeFile(
    resolve(chaptersDir, "index.json"),
    JSON.stringify(
      [
        {
          number: 1,
          title: "第一章",
          status: "ready-for-review",
          wordCount: 24,
          createdAt: now,
          updatedAt: now,
          auditIssues: [],
          lengthWarnings: [],
        },
        {
          number: 2,
          title: "第二章",
          status: "ready-for-review",
          wordCount: 24,
          createdAt: now,
          updatedAt: now,
          auditIssues: [],
          lengthWarnings: [],
        },
      ],
      null,
      2,
    ),
  );

  await writeFile(
    resolve(workflowsDir, `${E2E_CUSTOM_WORKFLOW_ID}.json`),
    JSON.stringify(
      {
        id: E2E_CUSTOM_WORKFLOW_ID,
        name: "E2E 自定义审查",
        description: "自定义审查工作流，用于端到端测试。",
        target: "review",
        builtin: false,
        steps: [
          {
            id: "s1",
            agent: "continuity-auditor",
            enabled: true,
            options: {},
          },
        ],
        createdAt: now,
        updatedAt: now,
      },
      null,
      2,
    ),
  );
}
