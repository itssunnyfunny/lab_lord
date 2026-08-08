import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

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
    test.beforeEach(() => {
      test.skip(!available, `Set ${session.stateEnv} and ${session.branchEnv} to run ${session.label} coverage.`);
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

    test("branch search follows the combobox keyboard pattern", async ({ page }) => {
      await page.route(`**/api/branches/${branchId}/search?**`, route => route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(searchResults(branchId!)),
      }));

      await page.goto(`/branch/${branchId}`);
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
      await expect(search).toHaveAttribute("aria-expanded", "false");
      await expect(listbox).toBeHidden();
      await expect(search).toBeFocused();
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
  test.beforeEach(() => {
    test.skip(!available, "Set PLAYWRIGHT_READ_ONLY_AUTH_STATE and PLAYWRIGHT_READ_ONLY_BRANCH_ID.");
  });

  test("mutation controls expose their blocker before submission", async ({ page }) => {
    await page.goto(`/branch/${branchId}/students`);
    await expect(page.getByText(/read-only/i).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Add student" })).toBeDisabled();
    await expect(page.getByText(/Student changes are disabled/i)).toBeVisible();
  });
});
