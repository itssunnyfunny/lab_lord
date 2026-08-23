import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const authState = process.env.PLAYWRIGHT_AUTH_STATE;
const storageState = authState && fs.existsSync(authState)
  ? authState
  : { cookies: [], origins: [] };
const hasAuthState = typeof storageState === "string";

test.use({ storageState });
test.beforeEach(() => {
  test.skip(!hasAuthState, "Set PLAYWRIGHT_AUTH_STATE to run authenticated WhatsApp UI coverage.");
});

const ORG_ID = "playwright-whatsapp-org";
const SETTINGS_PATH = `/org/${ORG_ID}/settings`;
const FINISH_EVENT = JSON.stringify({
  type: "WA_EMBEDDED_SIGNUP",
  event: "FINISH",
  data: {
    business_id: "123456",
    waba_id: "234567",
    phone_number_id: "345678",
  },
});

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installWhatsAppMocks(page: Page) {
  const completedBodies: Array<Record<string, unknown>> = [];

  await page.route("https://checkout.razorpay.com/v1/checkout.js", route =>
    route.fulfill({ contentType: "application/javascript", body: "window.Razorpay=function(){};" })
  );
  await page.route("https://connect.facebook.net/en_US/sdk.js", route =>
    route.fulfill({
      contentType: "application/javascript",
      body: `window.FB={
        init:function(options){window.__metaSignupHarness.initOptions=options;},
        login:function(callback,options){
          window.__metaSignupHarness.callback=callback;
          window.__metaSignupHarness.loginOptions=options;
        }
      };`,
    })
  );
  await page.addInitScript(() => {
    (window as typeof window & {
      __metaSignupHarness: {
        callback: ((value: unknown) => void) | null;
        initOptions: Record<string, unknown> | null;
        loginOptions: Record<string, unknown> | null;
      };
    }).__metaSignupHarness = {
      callback: null,
      initOptions: null,
      loginOptions: null,
    };
  });

  await page.route(`**/api/organizations/${ORG_ID}`, route => json(route, {
    id: ORG_ID,
    name: "Playwright Study Hall",
    businessType: "Study Hall",
    legalName: null,
    contactEmail: "owner@example.test",
    contactPhone: "9876543210",
    address: "Test address",
    timezone: "Asia/Kolkata",
    currency: "INR",
    weekStartsOn: 1,
    paymentGraceDays: 0,
    ownerId: "owner_playwright",
    subscription: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    branches: [],
    _count: { branches: 0 },
  }));
  await page.route(`**/api/organizations/${ORG_ID}/billing`, route =>
    json(route, { error: "Billing unavailable in isolated UI test" }, 503)
  );
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/config`, route => json(route, {
    enabled: true,
    providerMode: "TEST",
    appId: "browser-safe-app-id",
    embeddedSignupConfigId: "browser-safe-config-id",
    graphApiVersion: "v26.0",
    connectionAvailability: "AVAILABLE",
    safeReason: null,
  }));
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/senders`, route => json(route, {
    enabled: true,
    canManage: true,
    safeReason: null,
    senders: [{
      id: "sender_local_1",
      providerMode: "TEST",
      displayPhoneNumber: "+91 98765 43210",
      verifiedName: "Playwright Study Hall",
      qualityRating: "GREEN",
      accountMode: "SANDBOX",
      status: "ACTIVE",
      phoneRegisteredAt: "2026-08-22T00:00:00.000Z",
      webhookSubscribedAt: "2026-08-22T00:00:00.000Z",
      lastHealthCheckAt: "2026-08-22T00:00:00.000Z",
      lastTemplateSyncAt: null,
      templateCounts: { approved: 0, pending: 0, rejected: 0, other: 0, total: 0 },
      assignedBranches: [],
    }],
  }));
  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/connection-intents`,
    route => json(route, {
      intentId: "intent_local_1",
      state: "one-time-state-kept-in-memory",
      expiresAt: "2026-08-22T00:10:00.000Z",
    })
  );
  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/connection-intents/intent_local_1/complete`,
    route => {
      completedBodies.push(route.request().postDataJSON() as Record<string, unknown>);
      return json(route, { senderId: "sender_local_1", status: "ACTIVE", replay: false });
    }
  );

  return completedBodies;
}

async function openMetaLauncher(page: Page) {
  await page.goto(SETTINGS_PATH);
  await expect(page.getByRole("heading", { name: "WhatsApp", exact: true })).toBeVisible();
  await expect(page.getByText("Playwright Study Hall").last()).toBeVisible();
  await expect(page.getByText("TEST", { exact: true }).last()).toBeVisible();
  await expect(page.getByText(/Send test message/i)).toHaveCount(0);

  await page.getByRole("button", { name: "Prepare Meta connection" }).click();
  await page.getByRole("button", { name: "Continue with Meta" }).click();
  await expect(page.getByRole("button", { name: "Cancel setup" })).toBeVisible();
}

async function dispatchFinish(page: Page, origin: string, duplicate = false) {
  await page.evaluate(({ data, eventOrigin, twice }) => {
    const frame = document.createElement("iframe");
    frame.hidden = true;
    document.body.append(frame);
    const dispatch = () => window.dispatchEvent(new MessageEvent("message", {
      origin: eventOrigin,
      source: frame.contentWindow,
      data,
    }));
    dispatch();
    if (twice) dispatch();
  }, { data: FINISH_EVENT, eventOrigin: origin, twice: duplicate });
}

for (const order of ["code-first", "session-first"] as const) {
  test(`completes ${order} once, rejects hostile origins, and keeps state out of SDK options`, async ({ page }) => {
    const completedBodies = await installWhatsAppMocks(page);
    await openMetaLauncher(page);

    const loginOptions = await page.evaluate(() => (
      window as typeof window & {
        __metaSignupHarness: { loginOptions: Record<string, unknown> | null };
      }
    ).__metaSignupHarness.loginOptions);
    expect(loginOptions).not.toHaveProperty("state");

    await dispatchFinish(page, "http://facebook.com");
    expect(completedBodies).toHaveLength(0);

    if (order === "code-first") {
      await page.evaluate(() => (
        window as typeof window & {
          __metaSignupHarness: { callback: ((value: unknown) => void) | null };
        }
      ).__metaSignupHarness.callback?.({ authResponse: { code: "bounded-authorization-code" } }));
      await dispatchFinish(page, "https://business.facebook.com", true);
    } else {
      await dispatchFinish(page, "https://business.facebook.com", true);
      await page.evaluate(() => (
        window as typeof window & {
          __metaSignupHarness: { callback: ((value: unknown) => void) | null };
        }
      ).__metaSignupHarness.callback?.({ authResponse: { code: "bounded-authorization-code" } }));
    }

    await expect.poll(() => completedBodies.length).toBe(1);
    expect(completedBodies[0]).toMatchObject({
      state: "one-time-state-kept-in-memory",
      code: "bounded-authorization-code",
      businessId: "123456",
      wabaId: "234567",
      phoneNumberId: "345678",
    });
    await expect(page.getByText("WhatsApp connection setup completed.")).toBeVisible();

    const results = await new AxeBuilder({ page }).include("#whatsapp").analyze();
    expect(
      results.violations.filter(item => item.impact === "critical" || item.impact === "serious"),
      results.violations.map(item => `${item.id}: ${item.help}`).join("\n")
    ).toEqual([]);
  });
}

test("cancelling clears the attempt and ignores late provider callbacks", async ({ page }) => {
  const completedBodies = await installWhatsAppMocks(page);
  await openMetaLauncher(page);

  await page.getByRole("button", { name: "Cancel setup" }).click();
  await expect(page.getByRole("button", { name: "Prepare Meta connection" })).toBeVisible();
  await dispatchFinish(page, "https://business.facebook.com");
  await page.evaluate(() => (
    window as typeof window & {
      __metaSignupHarness: { callback: ((value: unknown) => void) | null };
    }
  ).__metaSignupHarness.callback?.({ authResponse: { code: "late-code" } }));

  await expect.poll(() => completedBodies.length).toBe(0);
});
