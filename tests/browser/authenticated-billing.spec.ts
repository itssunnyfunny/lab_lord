import fs from "node:fs";
import { expect, test } from "@playwright/test";

const authState = process.env.PLAYWRIGHT_AUTH_STATE;

test("authenticated workspace exposes normalized billing navigation", async ({ browser }) => {
  test.skip(!authState || !fs.existsSync(authState), "Set PLAYWRIGHT_AUTH_STATE to a restricted Clerk reviewer storage state.");
  const context = await browser.newContext({ storageState: authState! });
  const page = await context.newPage();
  await page.goto("/app");
  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(page.getByText(/Billing|trial|Standard|Basic/i).first()).toBeVisible();
  await context.close();
});
