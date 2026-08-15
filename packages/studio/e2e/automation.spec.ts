import { test, expect } from "@playwright/test";
import { seedAutomationBook, E2E_BOOK_ID, E2E_CUSTOM_WORKFLOW_ID } from "./fixtures/seed-automation";

test.beforeAll(async () => { await seedAutomationBook(); });

test("custom review workflow runs with the configured chapter scope", async ({ page }) => {
  await page.goto("/#/automation");

  // Select the custom workflow from the library.
  const workflowButton = page.locator("button").filter({ hasText: "E2E 自定义审查" });
  await expect(workflowButton).toBeVisible();
  await workflowButton.click();

  // Wait for the editor to load the custom workflow.
  await expect(page.locator("text=目标：").locator("..").locator("text=审查（通用，可选范围）")).toBeVisible();
  await expect(page.locator("text=治理/审计")).toBeVisible();

  // Select the seeded book (the book dropdown is the one with the placeholder option).
  const bookSelect = page.locator("select").filter({ has: page.locator("option[value='']") });
  await bookSelect.selectOption(E2E_BOOK_ID);

  // Configure review scope to chapters 1-2.
  await page.locator("button").filter({ hasText: "按章节" }).click();
  const startInput = page.locator('input[type="number"]').nth(0);
  const endInput = page.locator('input[type="number"]').nth(1);
  await startInput.fill("1");
  await endInput.fill("2");

  // Start the workflow.
  const runButton = page.locator("button").filter({ hasText: "按工作流执行" });
  await expect(runButton).toBeEnabled();
  await runButton.click();

  // Wait for execution to complete.
  const logPanel = page.locator("text=事件日志").locator("../..");
  await expect(logPanel).toContainText("全部 2 章完成", { timeout: 30_000 });

  // Verify the scope reached the backend via the event log.
  await expect(logPanel).toContainText("范围：章节 1-2");
  await expect(logPanel).toContainText("发起运行 e2e-custom-review 书=automation-test 范围=章节 1-2");
});
