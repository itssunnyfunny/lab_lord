import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { refreshDevelopmentSession } from "./helpers/development-session";

const EMPTY_STATE = { cookies: [], origins: [] };

const roleSessions = [
  { label: "Owner", stateEnv: "PLAYWRIGHT_OWNER_AUTH_STATE", branchEnv: "PLAYWRIGHT_OWNER_BRANCH_ID" },
  { label: "Manager", stateEnv: "PLAYWRIGHT_MANAGER_AUTH_STATE", branchEnv: "PLAYWRIGHT_MANAGER_BRANCH_ID" },
  { label: "Staff", stateEnv: "PLAYWRIGHT_STAFF_AUTH_STATE", branchEnv: "PLAYWRIGHT_STAFF_BRANCH_ID" },
] as const;

function searchResults(branchId: string) {
  return [
    {
      id: "actions",
      label: "Quick actions",
      results: [
        {
          id: "action:add-student",
          type: "action",
          group: "actions",
          title: "Add Student",
          subtitle: "Create a new student record",
          href: `/branch/${branchId}/students`,
          keywords: ["student", "add"],
          score: 100,
        },
        {
          id: "action:payments",
          type: "action",
          group: "actions",
          title: "Payments",
          subtitle: "Review dues and payment history",
          href: `/branch/${branchId}/payments`,
          keywords: ["payments", "dues"],
          score: 90,
        },
      ],
    },
  ];
}

async function mockChartData(page: Page, branchId: string) {
  await page.route(`**/api/branches/${branchId}`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ id: branchId, name: "Keyboard Test Branch" }),
  }));
  await page.route(`**/api/analytics/branch/${branchId}/snapshot?**`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      period: "month",
      totalStudents: 12,
      activeStudents: 10,
      assignedSeats: 8,
      totalSeats: 16,
      occupancyRate: 50,
      monthlyRevenue: 12000,
      dueAmount: 3000,
      paidAmount: 9000,
      collectionRate: 75,
    }),
  }));
  await page.route(`**/api/analytics/branch/${branchId}/trends?**`, route => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify([
      { date: "2026-08-01T00:00:00.000Z", value: 4000, category: "Revenue" },
      { date: "2026-08-08T00:00:00.000Z", value: 8000, category: "Revenue" },
    ]),
  }));
}

for (const session of roleSessions) {
  test.describe(`${session.label} authenticated UI`, () => {
    const statePath = process.env[session.stateEnv];
    const branchId = process.env[session.branchEnv];
    const available = Boolean(statePath && fs.existsSync(statePath) && branchId);

    test.use({ storageState: available ? statePath : EMPTY_STATE });
    test.beforeEach(async ({ page }) => {
      test.skip(!available, `Set ${session.stateEnv} and ${session.branchEnv} to run ${session.label} coverage.`);
      await refreshDevelopmentSession(page);
    });

    test("dashboard loads without creating payments and passes an axe smoke check", async ({ page }) => {
      const writeRequests: string[] = [];
      page.on("request", request => {
        if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) writeRequests.push(request.url());
      });

      await page.goto(`/branch/${branchId}`);
      await expect(page.getByRole("main")).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      expect(writeRequests.filter(url => /\/payments\/(ensure|generate)/.test(url))).toEqual([]);
      const results = await new AxeBuilder({ page }).include("main").analyze();
      expect(
        results.violations.filter(item => item.impact === "critical" || item.impact === "serious"),
        results.violations.map(item => `${item.id}: ${item.help}`).join("\n")
      ).toEqual([]);
    });

    test("workspace menu supports keyboard selection, dismissal, and viewport-safe placement", async ({ page }) => {
      await page.goto(`/branch/${branchId}`);
      const workspace = page.locator("header").getByRole("combobox", {
        name: /^(Org \/ Branch|Branch|Workspace)$/,
      });
      await expect(workspace).toBeVisible();
      await expect(workspace).not.toContainText(/Loading workspaces|Workspaces unavailable/);

      await workspace.focus();
      await page.keyboard.press("End");
      const listbox = page.getByRole("listbox", { name: /^(Org \/ Branch|Branch|Workspace)$/ });
      const accountOption = listbox.getByRole("option", { name: /Account settings/i });
      await expect(listbox).toBeVisible();
      await expect(accountOption).toBeVisible();
      await expect(workspace).toHaveAttribute("aria-activedescendant", await accountOption.getAttribute("id") ?? "");

      const enabledOptions = listbox.locator('[role="option"]:not([aria-disabled="true"])');
      const firstOptionId = await enabledOptions.first().getAttribute("id");
      const secondOptionId = await enabledOptions.nth(1).getAttribute("id");
      await page.keyboard.press("Home");
      await expect(workspace).toHaveAttribute("aria-activedescendant", firstOptionId ?? "");
      await page.keyboard.press("ArrowDown");
      await expect(workspace).toHaveAttribute("aria-activedescendant", secondOptionId ?? "");
      await page.keyboard.press("End");
      await expect(workspace).toHaveAttribute("aria-activedescendant", await accountOption.getAttribute("id") ?? "");

      const menuBox = await listbox.boundingBox();
      const viewport = page.viewportSize();
      expect(menuBox).not.toBeNull();
      expect(viewport).not.toBeNull();
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.y).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(viewport!.width);
      expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(viewport!.height);

      await page.keyboard.press("Escape");
      await expect(listbox).toBeHidden();
      await expect(workspace).toBeFocused();

      await workspace.click();
      await page.keyboard.press("Tab");
      await expect(listbox).toBeHidden();

      await workspace.click();
      await expect(listbox).toBeVisible();
      await page.getByRole("heading", { level: 1 }).click();
      await expect(listbox).toBeHidden();

      await workspace.focus();
      await workspace.click();
      await page.keyboard.type("account");
      await expect(workspace).toHaveAttribute("aria-activedescendant", await accountOption.getAttribute("id") ?? "");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/account(?:\?|$)/);
    });

    test("branch search follows the combobox keyboard pattern", async ({ page }, testInfo) => {
      await page.route(`**/api/branches/${branchId}/search?**`, route => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(searchResults(branchId!)),
      }));

      await page.goto(`/branch/${branchId}`);
      const mobile = testInfo.project.name === "mobile-chromium";
      const mobileTrigger = page.getByRole("button", { name: "Search current branch" });
      if (mobile) {
        await mobileTrigger.click();
        await expect(page.getByRole("dialog", { name: "Search this branch" })).toBeVisible();
      }
      const search = page.getByRole("combobox", { name: "Search current branch" });
      await expect(search).toBeEnabled();
      await search.focus();

      const listbox = page.getByRole("listbox", { name: "Branch search results" });
      const options = listbox.getByRole("option");
      await expect(search).toHaveAttribute("aria-expanded", "true");
      await expect(options).toHaveCount(2);

      const firstOptionId = await options.nth(0).getAttribute("id");
      const secondOptionId = await options.nth(1).getAttribute("id");
      expect(firstOptionId).toBeTruthy();
      expect(secondOptionId).toBeTruthy();
      await expect(search).toHaveAttribute("aria-activedescendant", firstOptionId!);

      await page.keyboard.press("ArrowDown");
      await expect(search).toHaveAttribute("aria-activedescendant", secondOptionId!);
      await page.keyboard.press("ArrowUp");
      await expect(search).toHaveAttribute("aria-activedescendant", firstOptionId!);

      await page.keyboard.press("Escape");
      await expect(listbox).toBeHidden();
      if (mobile) {
        await expect(page.getByRole("dialog", { name: "Search this branch" })).toBeHidden();
        await expect(mobileTrigger).toBeFocused();
      } else {
        await expect(search).toHaveAttribute("aria-expanded", "false");
        await expect(search).toBeFocused();
      }
    });

    test("shared dialog receives, contains, and restores keyboard focus", async ({ page }) => {
      await page.goto(`/branch/${branchId}/students`);
      const trigger = page.getByRole("button", { name: "Add student", exact: true });

      if (session.label === "Owner") {
        await expect(trigger).toBeVisible();
      } else if (await trigger.count() === 0) {
        test.skip(true, `${session.label} does not have student-management access in this session.`);
      }
      test.skip(await trigger.isDisabled(), `${session.label} student mutations are currently restricted.`);

      await trigger.focus();
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "Add new student" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: /Full Name/i })).toBeFocused();

      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => page.evaluate(() => (
        document.activeElement?.closest('[role="dialog"]')?.getAttribute("aria-modal")
      ))).toBe("true");

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test("mobile navigation drawer supports focus and Escape", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile-chromium", "Mobile drawer coverage runs in the Pixel 7 project.");

      await page.goto(`/branch/${branchId}`);
      const trigger = page.getByRole("button", { name: "Open navigation" });
      await trigger.focus();
      await trigger.click();

      const drawer = page.getByRole("dialog", { name: "Workspace navigation" });
      await expect(drawer).toBeVisible();
      await expect(drawer.getByRole("button", { name: "Close navigation" })).toBeFocused();
      await expect(drawer.getByRole("complementary", { name: "Branch navigation" })).toBeVisible();

      await page.keyboard.press("Tab");
      await expect.poll(() => page.evaluate(() => (
        document.activeElement?.closest('[role="dialog"]')?.getAttribute("aria-modal")
      ))).toBe("true");

      await page.keyboard.press("Escape");
      await expect(drawer).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test("mobile notifications use a modal and restore trigger focus", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile-chromium", "Mobile notifications coverage runs in the mobile project.");

      await page.goto(`/branch/${branchId}`);
      const trigger = page.getByRole("button", { name: /branch notifications/i });
      await expect(trigger).toBeEnabled();
      await trigger.focus();
      await trigger.click();

      const dialog = page.getByRole("dialog", { name: "Notifications" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Close dialog" })).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect.poll(() => page.evaluate(() => (
        document.activeElement?.closest('[role="dialog"]')?.getAttribute("aria-modal")
      ))).toBe("true");

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test("core mobile shell has no overlapping controls and exposes deterministic back navigation", async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== "mobile-chromium", "Responsive shell coverage runs in the mobile project.");

      for (const viewport of [
        { width: 320, height: 568 },
        { width: 360, height: 800 },
        { width: 390, height: 844 },
        { width: 430, height: 932 },
        { width: 844, height: 390 },
      ]) {
        await page.setViewportSize(viewport);
        await page.goto(`/branch/${branchId}`);
        await expect(page.getByRole("main")).toBeVisible();

        const shellMetrics = await page.locator("header").first().evaluate(header => {
          const controls = Array.from(header.querySelectorAll<HTMLElement>("button, select, a[href]"))
            .filter(element => {
              const rect = element.getBoundingClientRect();
              const style = window.getComputedStyle(element);
              return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
            })
            .map(element => {
              const rect = element.getBoundingClientRect();
              return {
                name: element.getAttribute("aria-label") || element.textContent?.trim() || element.tagName,
                left: rect.left,
                right: rect.right,
                top: rect.top,
                bottom: rect.bottom,
                height: rect.height,
              };
            });
          const overlaps: string[] = [];
          for (let leftIndex = 0; leftIndex < controls.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < controls.length; rightIndex += 1) {
              const left = controls[leftIndex];
              const right = controls[rightIndex];
              const sharesRow = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > 1;
              const overlapsHorizontally = Math.min(left.right, right.right) - Math.max(left.left, right.left) > 1;
              if (sharesRow && overlapsHorizontally) overlaps.push(`${left.name} / ${right.name}`);
            }
          }
          return {
            overlaps,
            undersized: controls.filter(control => control.height < 43.5).map(control => control.name),
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
          };
        });

        expect(shellMetrics.overlaps, `${viewport.width}x${viewport.height} overlaps`).toEqual([]);
        expect(shellMetrics.undersized, `${viewport.width}x${viewport.height} touch targets`).toEqual([]);
        expect(shellMetrics.scrollWidth, `${viewport.width}x${viewport.height} horizontal overflow`).toBeLessThanOrEqual(shellMetrics.clientWidth);
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/branch/${branchId}/payments`);
      await expect(page.getByRole("link", { name: "Back to branch dashboard" })).toHaveAttribute("href", `/branch/${branchId}`);
      await expect(page.getByRole("button", { name: "Table view" })).toBeHidden();

      await page.goto(`/branch/${branchId}`);
      const exactDueLink = page.locator('main a[href*="/payments?paymentId="]').filter({ visible: true }).first();
      if (await exactDueLink.count()) {
        const href = await exactDueLink.getAttribute("href");
        expect(href).toContain("status=DUE");
        expect(href).not.toContain("month=");
        await exactDueLink.click();
        const focusedPayment = page.locator('[aria-current="true"][aria-label*="selected search result"]').filter({ visible: true });
        await expect(focusedPayment).toBeFocused();
      }
    });

    test("chart exposes a keyboard-operable data-table alternative", async ({ page }) => {
      await mockChartData(page, branchId!);
      await page.goto(`/branch/${branchId}/analytics`);

      const dataToggle = page.getByText("View chart data", { exact: true });
      const accessOutcome = await Promise.race([
        dataToggle.waitFor({ state: "visible", timeout: 15_000 }).then(() => "chart" as const),
        page.getByText("Standard feature", { exact: true }).waitFor({ state: "visible", timeout: 15_000 }).then(() => "upgrade" as const),
        page.getByRole("heading", { name: "No access" }).waitFor({ state: "visible", timeout: 15_000 }).then(() => "permission" as const),
      ]);
      test.skip(accessOutcome !== "chart", `${session.label} cannot open branch analytics in this session.`);

      const chart = page.getByRole("img", { name: /Revenue trend for the current month/i });
      await expect(chart).toBeVisible();
      await dataToggle.focus();
      await page.keyboard.press("Enter");

      const table = page.getByRole("table", { name: "Data displayed in the Revenue Trend chart" });
      await expect(table).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Date" })).toBeVisible();
      await expect(table.getByRole("columnheader", { name: "Value" })).toBeVisible();
      await expect(table.getByRole("row")).toHaveCount(3);
    });
  });
}

test.describe("Read-only authenticated UI", () => {
  const statePath = process.env.PLAYWRIGHT_READ_ONLY_AUTH_STATE;
  const branchId = process.env.PLAYWRIGHT_READ_ONLY_BRANCH_ID;
  const available = Boolean(statePath && fs.existsSync(statePath) && branchId);

  test.use({ storageState: available ? statePath : EMPTY_STATE });
  test.beforeEach(async ({ page }) => {
    test.skip(!available, "Set PLAYWRIGHT_READ_ONLY_AUTH_STATE and PLAYWRIGHT_READ_ONLY_BRANCH_ID.");
    await refreshDevelopmentSession(page);
  });

  test("mutation controls expose their blocker before submission", async ({ page }) => {
    await page.goto(`/branch/${branchId}/students`);
    await expect(page.getByText(/read-only/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add student" })).toBeDisabled();
    await expect(page.getByText(/Student changes are disabled/i)).toBeVisible();
  });
});

test.describe("Clerk account dark theme", () => {
  const statePath = process.env.PLAYWRIGHT_OWNER_AUTH_STATE;
  const branchId = process.env.PLAYWRIGHT_OWNER_BRANCH_ID;
  const available = Boolean(statePath && fs.existsSync(statePath) && branchId);

  test.use({ storageState: available ? statePath : EMPTY_STATE });
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(!available, "Set PLAYWRIGHT_OWNER_AUTH_STATE and PLAYWRIGHT_OWNER_BRANCH_ID.");
    test.skip(testInfo.project.name !== "chromium", "Clerk profile contrast is exercised once in desktop Chromium.");
    await refreshDevelopmentSession(page);
  });

  test("profile and security surfaces retain readable dark-theme contrast", async ({ page }) => {
    await page.goto(`/branch/${branchId}`);
    await page.getByRole("button", { name: "Open user menu" }).click();
    await page.getByText("Manage account", { exact: true }).click();

    const dialog = page.getByRole("dialog").first();
    await expect(dialog).toBeVisible();
    const profileResults = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(
      profileResults.violations.filter(item => item.id === "color-contrast"),
      profileResults.violations.map(item => `${item.id}: ${item.help}`).join("\n")
    ).toEqual([]);

    const security = dialog.getByText("Security", { exact: true });
    await expect(security).toBeVisible();
    await security.click();
    await expect(dialog.getByText(/Password|Active devices|Security/i).first()).toBeVisible();

    const securityResults = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(
      securityResults.violations.filter(item => item.id === "color-contrast"),
      securityResults.violations.map(item => `${item.id}: ${item.help}`).join("\n")
    ).toEqual([]);
  });
});
