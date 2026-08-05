import { expect, test } from "@playwright/test";

test("public pricing exposes only Basic and Standard branch pricing", async ({ page }, testInfo) => {
  await page.goto("/#pricing");
  await expect(page.getByText("Basic", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Standard", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("₹299", { exact: false })).toBeVisible();
  await expect(page.getByText("₹499", { exact: false })).toBeVisible();
  await expect(page.getByText(/Agent Control/i)).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("landing-pricing.png"), fullPage: true });
});

for (const route of ["/privacy", "/terms", "/refund-policy", "/shipping-delivery-policy", "/contact"]) {
  test(`${route} is public and linked from the footer`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response?.status()).toBe(200);
    await expect(page.locator("main")).toBeVisible();
  });
}

test("public footer exposes all required trust links", async ({ page }) => {
  await page.goto("/");
  for (const route of ["/privacy", "/terms", "/refund-policy", "/shipping-delivery-policy", "/contact"]) {
    await expect(page.locator(`footer a[href="${route}"]`)).toBeVisible();
  }
});

test("application routes still require authentication", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in/);
});
