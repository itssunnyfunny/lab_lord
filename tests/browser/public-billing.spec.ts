import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const hasClerkCredentials = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
);

async function hideDevelopmentOverlays(page: Page) {
  await page.waitForTimeout(750);

  const keylessPrompt = page.getByRole("button", { name: "Keyless prompt" });
  if (await keylessPrompt.count()) {
    await keylessPrompt.first().locator("..").evaluate(element => {
      if (element instanceof HTMLElement) element.style.display = "none";
    });
  }

  await page.evaluate(() => {
    const roots: Array<Document | ShadowRoot> = [document];

    while (roots.length > 0) {
      const root = roots.pop();
      if (!root) continue;

      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);

        if (element.localName === "nextjs-portal" && element instanceof HTMLElement) {
          element.style.display = "none";
        }

        if (element.textContent?.trim() !== "Configure your application") continue;

        let overlay: Element | null = element;
        while (overlay instanceof HTMLElement) {
          if (getComputedStyle(overlay).position === "fixed") {
            overlay.style.display = "none";
            break;
          }
          overlay = overlay.parentElement;
        }

        if (!overlay && root instanceof ShadowRoot && root.host instanceof HTMLElement) {
          root.host.style.display = "none";
        }
      }
    }
  });
}

test("public landing has no serious or critical accessibility violations", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await hideDevelopmentOverlays(page);
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter(violation =>
    violation.impact === "serious" || violation.impact === "critical"
  );
  expect(blocking, blocking.map(item => `${item.id}: ${item.help}`).join("\n")).toEqual([]);
});

test("public landing reflows at 320px and browser-style 400% zoom", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await hideDevelopmentOverlays(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { document.documentElement.style.zoom = "4"; });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("public landing visual regression", async ({ page }, testInfo) => {
  const mobile = testInfo.project.name.includes("mobile");
  const width = mobile ? 390 : 1440;
  await page.setViewportSize({ width, height: mobile ? 844 : 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.getByRole("main")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await hideDevelopmentOverlays(page);
  await expect(page).toHaveScreenshot(`landing-${width}.png`, {
    animations: "disabled",
    fullPage: true,
    timeout: 30_000,
  });
});

test("public pricing exposes only Basic and Standard branch pricing", async ({ page }, testInfo) => {
  await page.goto("/#pricing");
  await expect(page.getByText("Basic", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Standard", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/\u20B9299/)).toBeVisible();
  await expect(page.getByText(/\u20B9499/)).toBeVisible();
  await expect(page.getByText(/Agent Control/i)).toHaveCount(0);
  for (const capability of [
    "Student records and spreadsheet import",
    "Seats, shifts and allocations",
    "Payments, dues and audit history",
    "Multiple branches, each billed separately",
    "Staff invitations, roles and permission controls",
    "Branch and cross-branch advanced analytics",
    "AI reports and message drafting",
  ]) {
    await expect(page.getByText(capability, { exact: false })).toHaveCount(2);
  }
  await expect(page.getByText(/Standard only/)).toHaveCount(3);
  await expect(page.getByText(/billable branch \/ month/)).toHaveCount(2);
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

test("mobile landing navigation exposes every primary section by keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  const disclosure = page.locator("details").filter({ hasText: "Navigation menu" });
  const menuButton = disclosure.locator("summary");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await menuButton.focus();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("open", "");

  const mobileNavigation = page.getByRole("navigation", { name: "Mobile navigation" });
  for (const label of ["Platform", "Software", "Workflow", "Pricing"]) {
    await expect(mobileNavigation.getByRole("link", { name: label, exact: true })).toBeVisible();
  }

  await mobileNavigation.getByRole("link", { name: "Platform", exact: true }).click();
  await expect(page).toHaveURL(/#platform$/);
});

test("hero product tour CTA points to clearly labelled sample data", async ({ page }) => {
  await page.goto("/");

  const tourLink = page.getByRole("link", { name: "See product tour" });
  await expect(tourLink).toHaveAttribute("href", "#product-tour");
  await expect(page.getByText("Sample workspace data", { exact: true })).toBeVisible();
  await tourLink.click();

  await expect(page).toHaveURL(/#product-tour$/);
  await expect(page.locator("#product-tour")).toBeVisible();
  await expect(page.getByText("Illustrative workspace and sample data", { exact: true })).toBeVisible();
});

test("footer legal links keep mobile-sized touch targets", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");

  for (const route of ["/privacy", "/terms", "/refund-policy", "/shipping-delivery-policy", "/contact", "/cookies"]) {
    const link = page.locator(`footer a[href="${route}"]`);
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test("support and software routes expose route-specific metadata", async ({ page }) => {
  await page.goto("/support");
  await expect(page).toHaveTitle("Support | Lab Lords");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/support$/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Lab Lords Support");

  await page.goto("/software/seat-management");
  await expect(page).toHaveTitle(/Seat Management Software.*Lab Lords/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/software\/seat-management$/);
});

test("application routes still require authentication", async ({ page }) => {
  test.skip(!hasClerkCredentials, "Clerk credentials are required to verify the authentication redirect.");
  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in/);
});
