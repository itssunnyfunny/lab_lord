import fs from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { refreshDevelopmentSession } from "./helpers/development-session";

// Opt-in synthetic fixtures only. The operator must independently verify the
// local server's database; this suite does not seed or reset any database.
const branchId = process.env.PLAYWRIGHT_OWNER_BRANCH_ID;
const orgId = process.env.PLAYWRIGHT_OWNER_ORG_ID;
const foreignBranch = process.env.PLAYWRIGHT_FOREIGN_BRANCH_ID;
const foreignOrg = process.env.PLAYWRIGHT_FOREIGN_ORG_ID;
const isolated = process.env.PLAYWRIGHT_RC_ISOLATED_CONFIRM === "lab_lords_final_fresh_test"
  && new URL(process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3000").hostname === "localhost";

async function request(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const clerk = (window as unknown as {
      Clerk: { session: { getToken(options: { skipCache: boolean }): Promise<string | null> } };
    }).Clerk;
    const token = await clerk.session.getToken({ skipCache: true });
    if (!token) throw new Error("Authenticated Clerk session expired during the journey.");
    const response = await fetch(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }, { path, method, body });
}

test.describe("Release candidate owner", () => {
  const state = process.env.PLAYWRIGHT_OWNER_AUTH_STATE;
  test.use({ storageState: state && fs.existsSync(state) ? state : { cookies: [], origins: [] } });
  test.beforeEach(async ({ page }) => {
    test.skip(!isolated || !state || !branchId || !orgId || !foreignBranch || !foreignOrg,
      "Requires independently verified isolated RC database and owner/foreign fixtures.");
    await refreshDevelopmentSession(page);
  });

  test("real owner operations persist and foreign tenants match missing responses", async ({ page }) => {
    test.setTimeout(120_000);
    const base = `/api/branches/${branchId}`;
    const suffix = Date.now().toString().slice(-8);
    const seat = await request(page, `${base}/seats`, "POST", { label: `RC${suffix}` });
    expect(seat.status).toBe(201);
    const shifts = await request(page, `${base}/shifts`);
    expect(shifts.status).toBe(200);
    const shift = shifts.body.find((item: { name: string }) => item.name === "Morning");
    expect(shift).toBeDefined();
    const student = await request(page, `${base}/students`, "POST", {
      name: `RC Student ${suffix}`, phone: `98${suffix}`, monthlyFee: 1000, admissionFee: 100,
      seatId: seat.body.id, shiftIds: [shift.id],
    });
    expect(student.status).toBe(201);
    const allocations = await request(page, `${base}/seat-allocations?studentId=${student.body.id}&all=true`);
    expect(allocations.status).toBe(200);
    expect(JSON.stringify(allocations.body)).toContain(seat.body.id);
    for (const route of ["students", "seats", "shifts", "allocations"]) {
      await page.goto(`/branch/${branchId}/${route}`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }
    await page.goto(`/branch/${branchId}/students`);
    await expect(page.getByLabel("Students table").getByText(student.body.name, { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Students table").getByText(student.body.name, { exact: true })).toBeVisible();
    for (const [foreign, missing] of [
      [`/api/branches/${foreignBranch}`, "/api/branches/rc-not-present"],
      [`/api/organizations/${foreignOrg}/billing`, "/api/organizations/rc-not-present/billing"],
    ]) {
      const actual = await request(page, foreign);
      expect(actual.status).toBe(404);
      expect(actual).toEqual(await request(page, missing));
      expect(Object.keys(actual.body)).toEqual(["error"]);
    }
    await page.goto(`/org/${orgId}/settings#billing`);
    await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
  });
});

test.describe("Release candidate restricted staff", () => {
  const state = process.env.PLAYWRIGHT_STAFF_AUTH_STATE;
  test.use({ storageState: state && fs.existsSync(state) ? state : { cookies: [], origins: [] } });
  test.beforeEach(async ({ page }) => {
    test.skip(!isolated || !state || !branchId || !orgId,
      "Requires real STAFF membership with VIEW_PAYMENTS denied in the isolated owner branch.");
    await refreshDevelopmentSession(page);
  });

  test("complete protected payloads remain unavailable while student access works", async ({ page }) => {
    await page.goto(`/branch/${branchId}/students`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect((await request(page, `/api/branches/${branchId}/students`)).status).toBe(200);
    for (const path of [
      `/api/branches/${branchId}/payments`,
      `/api/branches/${branchId}/staff`,
      `/api/analytics/branch/${branchId}/snapshot?period=month`,
    ]) {
      const result = await request(page, path);
      expect(result.status).toBe(403);
      expect(Object.keys(result.body)).toEqual(["error"]);
    }
    const billing = await request(page, `/api/organizations/${orgId}/billing`);
    expect(billing.status).toBe(404);
    expect(Object.keys(billing.body)).toEqual(["error"]);
    const navigation = page.getByRole("complementary", { name: "Branch navigation" });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Students", exact: true })).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Payments", exact: true })).toHaveCount(0);
    await expect(navigation.getByRole("link", { name: "Staff", exact: true })).toHaveCount(0);
  });
});
