import { chromium } from "@playwright/test";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("console", (msg) => console.log("[console]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("request", (req) => {
    if (req.url().includes("events")) console.log("[request]", req.method(), req.url());
  });
  page.on("response", (res) => {
    if (res.url().includes("events")) console.log("[response]", res.status(), res.url());
  });
  await page.goto("http://localhost:4580/#/automation");
  await page.waitForTimeout(2000);

  // Click custom workflow
  await page.locator("button").filter({ hasText: "E2E 自定义审查" }).click();
  await page.waitForTimeout(500);

  // Select book
  const bookSelect = page.locator("select").filter({ has: page.locator("option[value='']") });
  await bookSelect.selectOption("automation-test");
  await page.waitForTimeout(500);

  // Set scope
  await page.locator("button").filter({ hasText: "按章节" }).click();
  const startInput = page.locator('input[type="number"]').nth(0);
  const endInput = page.locator('input[type="number"]').nth(1);
  await startInput.fill("1");
  await endInput.fill("2");
  await page.waitForTimeout(500);

  // Click run
  const runButton = page.locator("button").filter({ hasText: "按工作流执行" });
  console.log("run button enabled:", await runButton.isEnabled());
  console.log("run button text:", await runButton.textContent());

  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes("/workflow/") && res.url().endsWith("/run"), { timeout: 10_000 }).catch((e) => {
      console.log("waitForResponse error:", e.message);
      return null;
    }),
    runButton.click(),
  ]);
  if (response) {
    console.log("response status:", response.status());
    console.log("response body:", await response.text().catch(() => ""));
  }
  await page.waitForTimeout(3000);

  // Capture state
  const errorText = await page.locator("text-sm text-destructive").textContent().catch(() => null);
  console.log("error:", errorText);
  const bodyText = await page.locator("body").textContent();
  console.log("body contains 运行中:", bodyText?.includes("运行中"));
  console.log("body contains 完成:", bodyText?.includes("完成"));
  console.log("body contains 启动失败:", bodyText?.includes("启动失败"));
  console.log("body contains 终止:", bodyText?.includes("终止"));
  console.log("body contains 错误:", bodyText?.includes("错误"));

  // Get event log text
  const logText = await page.locator("text=事件日志").locator("..").textContent().catch(() => null);
  console.log("log preview:", logText?.slice(0, 1000));

  // Try to find and print the actual log entries (look for list items near 事件日志)
  const logItems = await page.locator("text=事件日志").locator("xpath=../../div").textContent().catch(() => null);
  console.log("log items:", logItems?.slice(0, 1000));

  // Capture all text in the execution panel
  const execPanel = await page.locator("h2").filter({ hasText: "执行" }).locator("..").textContent().catch(() => null);
  console.log("exec panel:", execPanel?.slice(0, 1000));

  await browser.close();
})();
