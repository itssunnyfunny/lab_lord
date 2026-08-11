import fs from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import type {
  BillingCheckoutPayload,
  BillingOperationDto,
  BillingOverview,
  BillingPlanDto,
  OrganizationSubscriptionDto,
} from "@/lib/api/billing";
import type { BillingExperience } from "@/types/billingExperience";

const authState = process.env.PLAYWRIGHT_AUTH_STATE;
const reviewerStorageState = authState && fs.existsSync(authState)
  ? authState
  : { cookies: [], origins: [] };
const hasAuthState = typeof reviewerStorageState === "string";

test.use({
  storageState: reviewerStorageState,
});

test.beforeEach(() => {
  test.skip(
    !hasAuthState,
    "Set PLAYWRIGHT_AUTH_STATE to a restricted Clerk reviewer storage state."
  );
});

const ORG_ID = "playwright-billing-org";
const SETTINGS_PATH = `/org/${ORG_ID}/settings`;
const CHANGE_ID = "change-playwright-1";
const TRIAL_END = "2026-09-05T12:00:00.000Z";
const FIRST_CHARGE = "2026-09-05T12:00:00.000Z";

const CAPABILITIES = [
  { id: "STUDENT_RECORDS_IMPORT", label: "Student records and spreadsheet import", standardOnly: false },
  { id: "SEATS_SHIFTS_ALLOCATIONS", label: "Seats, shifts and allocations", standardOnly: false },
  { id: "PAYMENTS_DUES_AUDIT", label: "Payments, dues and audit history", standardOnly: false },
  { id: "MULTIPLE_BRANCHES", label: "Multiple branches, each billed separately", standardOnly: false },
  { id: "STAFF_CONTROLS", label: "Staff invitations, roles and permission controls", standardOnly: true },
  { id: "ADVANCED_ANALYTICS", label: "Branch and cross-branch advanced analytics", standardOnly: true },
  { id: "AI_ASSISTANCE", label: "AI reports and message drafting", standardOnly: true },
] as const;

const PLANS: BillingPlanDto[] = [
  {
    id: "BASIC",
    name: "Lab Lords Basic",
    shortName: "Basic",
    amount: 299,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: true,
    featured: false,
    comingSoon: false,
    custom: false,
    description: "Core operations billed per active branch.",
    capabilities: CAPABILITIES.map(capability => ({
      id: capability.id,
      label: capability.label,
      included: !capability.standardOnly,
    })),
    entitlements: [],
    limits: { maxBranches: null },
  },
  {
    id: "PRO",
    name: "Lab Lords Standard",
    shortName: "Standard",
    amount: 499,
    currency: "INR",
    period: "monthly",
    interval: 1,
    active: true,
    featured: true,
    comingSoon: false,
    custom: false,
    description: "Staff controls, analytics, and AI assistance for growing teams.",
    capabilities: CAPABILITIES.map(capability => ({
      id: capability.id,
      label: capability.label,
      included: true,
    })),
    entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
    limits: { maxBranches: null },
  },
];

function makeExperience(overrides: Partial<BillingExperience> = {}): BillingExperience {
  return {
    organizationId: ORG_ID,
    accessMode: "FULL",
    effectivePlan: "STANDARD_TRIAL",
    selectedPostTrialPlan: "BASIC",
    providerStatus: null,
    customerState: "TRIAL_ACTIVE",
    customerMessage: "Your 30-day Standard trial is active.",
    trialEndsAt: TRIAL_END,
    trialDaysRemaining: 30,
    paidThrough: null,
    confirmedQuantity: 2,
    projectedQuantity: 2,
    currentUnitAmount: 0,
    currentMonthlyTotal: 0,
    projectedUnitAmount: 299,
    projectedMonthlyTotal: 598,
    authorizationStatus: "NOT_AUTHORIZED",
    planFeeDueToday: 0,
    nextChargeAt: null,
    paymentAction: "AUTHORIZE_CARD",
    entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS"],
    latestOperation: null,
    activeOperation: null,
    scheduledChanges: [],
    branch: null,
    viewer: { isOwner: true, canManageBilling: true },
    ...overrides,
  };
}

function makeSubscription(
  overrides: Partial<OrganizationSubscriptionDto> = {}
): OrganizationSubscriptionDto {
  return {
    id: "subscription-local-1",
    organizationId: ORG_ID,
    plan: "BASIC",
    planName: "Lab Lords Basic",
    shortName: "Basic",
    amount: 299,
    amountSubunits: 29_900,
    currency: "INR",
    period: "monthly",
    interval: 1,
    totalCount: 120,
    quantity: 2,
    unitAmount: 299,
    monthlyTotal: 598,
    status: "CREATED",
    razorpaySubscriptionId: "sub_playwright_1",
    currentStart: null,
    currentEnd: null,
    chargeAt: null,
    endedAt: null,
    providerStartAt: TRIAL_END,
    authorizationExpiresAt: TRIAL_END,
    providerPaymentMethod: "UNKNOWN",
    paidThrough: null,
    cancelAtCycleEnd: false,
    cancellationRequestedAt: null,
    cancellationScheduledAt: null,
    cancelledAt: null,
    createdAt: "2026-08-06T10:00:00.000Z",
    updatedAt: "2026-08-06T10:00:00.000Z",
    ...overrides,
  };
}

function makeOperation(
  operationStatus: BillingOperationDto["operationStatus"] = "CHECKOUT_OPEN",
  overrides: Partial<BillingOperationDto> = {}
): BillingOperationDto {
  return {
    id: CHANGE_ID,
    organizationId: ORG_ID,
    type: "SUBSCRIPTION_AUTHORIZATION",
    queueStatus: operationStatus === "APPLIED" ? "APPLIED" : "AWAITING_PAYMENT",
    operationStatus,
    returnPath: `${SETTINGS_PATH}#billing`,
    confirmationDeadlineAt: "2026-08-06T11:00:00.000Z",
    failureCategory: null,
    failureCode: null,
    providerPaymentId: null,
    message: null,
    effectiveAt: null,
    createdAt: "2026-08-06T10:00:00.000Z",
    updatedAt: "2026-08-06T10:00:00.000Z",
    ...overrides,
  };
}

function makeOverview(
  experience: BillingExperience = makeExperience(),
  current: OrganizationSubscriptionDto | null = null
): BillingOverview {
  return {
    experience,
    razorpayTestMode: true,
    plans: PLANS,
    current,
    history: [],
    entitlements: {
      organizationId: ORG_ID,
      plan: current?.plan ?? null,
      effectivePlan: current?.plan ?? "PRO",
      subscriptionStatus: current?.status ?? null,
      fallbackAccess: false,
      entitlements: experience.entitlements,
      limits: { maxBranches: null },
      usage: { branches: 2 },
      accessMode: experience.accessMode,
      canWrite: experience.accessMode !== "READ_ONLY",
      accessReason: experience.customerMessage,
      trial: experience.trialEndsAt
        ? { status: "ACTIVE", endsAt: experience.trialEndsAt }
        : null,
    },
    billingModelVersion: "WORKSPACE_V2",
    trial: experience.trialEndsAt
      ? {
          status: "ACTIVE",
          source: "ONBOARDING",
          organizationId: ORG_ID,
          startedAt: "2026-08-06T12:00:00.000Z",
          endsAt: experience.trialEndsAt,
        }
      : null,
    ownerTrialEligibility: {
      status: "ACTIVE",
      claimable: false,
      boundOrganizationId: ORG_ID,
    },
    paymentMethod: current?.providerPaymentMethod ?? null,
    invoices: [],
    scheduledChanges: [],
  };
}

function makeCheckoutPayload(): BillingCheckoutPayload {
  const subscription = makeSubscription();
  const operation = makeOperation();
  return {
    changeId: CHANGE_ID,
    processingUrl: `/org/${ORG_ID}/billing/processing/${CHANGE_ID}`,
    keyId: "rzp_test_playwright",
    testMode: true,
    type: "subscription",
    subscriptionId: subscription.razorpaySubscriptionId,
    amount: 299,
    currency: "INR",
    name: "Lab Lords",
    description: "Basic · 2 branches · ₹598/month · starts 5 September 2026",
    config: {
      display: {
        blocks: {
          cards: {
            name: "Pay using card",
            instruments: [{ method: "card" }],
          },
        },
        sequence: ["block.cards"],
        preferences: { show_default_blocks: false },
      },
    },
    plan: {
      id: "BASIC",
      name: "Lab Lords Basic",
      shortName: "Basic",
      amount: 299,
      currency: "INR",
      period: "monthly",
    },
    prefill: {
      name: "Billing Owner",
      email: "billing.owner@lablords.test",
      contact: "+919876543210",
    },
    notes: { organizationId: ORG_ID, changeId: CHANGE_ID },
    summary: {
      plan: "BASIC",
      unitAmount: 299,
      quantity: 2,
      estimatedMonthlyTotal: 598,
      planFeeDueToday: 0,
      trialEndsAt: TRIAL_END,
      firstChargeAt: FIRST_CHARGE,
    },
    subscription,
    operation,
  };
}

const ORGANIZATION_RESPONSE = {
  id: ORG_ID,
  name: "Playwright Labs",
  businessType: "Study Hall",
  legalName: "Playwright Labs Private Limited",
  contactEmail: "billing.owner@lablords.test",
  contactPhone: "98765 43210",
  address: "Test Business Address, Bengaluru",
  timezone: "Asia/Kolkata",
  currency: "INR",
  weekStartsOn: 1,
  paymentGraceDays: 3,
  ownerId: "owner_playwright",
  owner: {
    id: "owner_playwright",
    name: "Billing Owner",
    email: "billing.owner@lablords.test",
  },
  subscription: null,
  createdAt: "2026-08-01T10:00:00.000Z",
  branches: [
    { id: "branch-1", name: "Central", city: "Bengaluru", createdAt: "2026-08-01T10:00:00.000Z" },
    { id: "branch-2", name: "North", city: "Bengaluru", createdAt: "2026-08-02T10:00:00.000Z" },
  ],
  _count: { branches: 2 },
};

type CheckoutScenario = "hold" | "dismiss" | "decline" | "technical" | "ambiguous" | "success";

type CapturedRazorpayOptions = {
  readonly?: { name: boolean; email: boolean; contact: boolean };
  prefill?: { name?: string; email?: string; contact?: string };
  remember_customer?: boolean;
  config?: Record<string, unknown>;
  subscriptionId?: string;
};

type RazorpayHarness = {
  scenario: CheckoutScenario;
  opens: number;
  lastOptions: CapturedRazorpayOptions | null;
};

async function installRazorpayMock(page: Page) {
  await page.addInitScript(() => {
    type FailureResponse = {
      error: {
        code: string;
        description: string;
        reason: string;
        source: string;
        step: string;
        metadata: { payment_id: string };
      };
    };
    type MockOptions = {
      subscription_id: string;
      remember_customer?: boolean;
      readonly?: { name: boolean; email: boolean; contact: boolean };
      prefill?: { name?: string; email?: string; contact?: string };
      config?: Record<string, unknown>;
      modal?: { ondismiss: () => void | Promise<void> };
      handler?: (response: {
        razorpay_payment_id: string;
        razorpay_subscription_id: string;
        razorpay_signature: string;
      }) => void | Promise<void>;
    };
    type TestWindow = Window & {
      __billingCheckoutHarness: RazorpayHarness;
      Razorpay: new (options: MockOptions) => {
        open: () => void;
        on: (event: string, handler: (response: FailureResponse) => void) => void;
      };
    };

    const testWindow = window as unknown as TestWindow;
    testWindow.__billingCheckoutHarness = {
      scenario: "hold",
      opens: 0,
      lastOptions: null,
    };

    class MockRazorpay {
      private readonly options: MockOptions;
      private failureHandler: ((response: FailureResponse) => void) | null = null;

      constructor(options: MockOptions) {
        this.options = options;
      }

      on(_event: string, handler: (response: FailureResponse) => void) {
        this.failureHandler = handler;
      }

      open() {
        const harness = testWindow.__billingCheckoutHarness;
        harness.opens += 1;
        harness.lastOptions = {
          readonly: this.options.readonly,
          prefill: this.options.prefill,
          remember_customer: this.options.remember_customer,
          config: this.options.config,
          subscriptionId: this.options.subscription_id,
        };

        window.setTimeout(() => {
          if (harness.scenario === "hold") return;
          if (harness.scenario === "success") {
            void this.options.handler?.({
              razorpay_payment_id: "pay_success_playwright",
              razorpay_subscription_id: this.options.subscription_id,
              razorpay_signature: "signature_playwright",
            });
            return;
          }
          if (harness.scenario !== "dismiss") {
            const technical = harness.scenario === "technical";
            const ambiguous = harness.scenario === "ambiguous";
            this.failureHandler?.({
              error: {
                code: technical ? "GATEWAY_ERROR" : "BAD_REQUEST_ERROR",
                description: technical
                  ? "The payment network could not respond"
                  : ambiguous
                    ? "The authorization result is unavailable"
                    : "The bank declined the card authorization",
                reason: technical ? "network_error" : ambiguous ? "unknown_error" : "card_declined",
                source: technical ? "network" : ambiguous ? "customer" : "bank",
                step: "payment_authentication",
                metadata: {
                  payment_id: technical
                    ? "pay_network_playwright"
                    : ambiguous
                      ? "pay_unknown_playwright"
                      : "pay_declined_playwright",
                },
              },
            });
          }
          void this.options.modal?.ondismiss();
        }, 0);
      }
    }

    testWindow.Razorpay = MockRazorpay;
  });

  await page.route("https://checkout.razorpay.com/v1/checkout.js*", async route => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript",
      body: "window.__razorpayCheckoutScriptLoaded = true;",
    });
  });
}

async function setCheckoutScenario(page: Page, scenario: CheckoutScenario) {
  await page.evaluate(nextScenario => {
    const testWindow = window as unknown as Window & { __billingCheckoutHarness: RazorpayHarness };
    testWindow.__billingCheckoutHarness.scenario = nextScenario;
  }, scenario);
}

async function getCheckoutHarness(page: Page): Promise<RazorpayHarness> {
  return page.evaluate(() => {
    const testWindow = window as unknown as Window & { __billingCheckoutHarness: RazorpayHarness };
    return testWindow.__billingCheckoutHarness;
  });
}

type BillingMockController = {
  overview: BillingOverview;
  operation: BillingOperationDto;
  checkoutEvents: Array<Record<string, unknown>>;
  createRequests: Array<Record<string, unknown>>;
  verifyRequests: Array<Record<string, unknown>>;
  retryRequests: number;
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function mockBillingPage(
  page: Page,
  overview = makeOverview(),
  operation = makeOperation()
): Promise<BillingMockController> {
  const controller: BillingMockController = {
    overview,
    operation,
    checkoutEvents: [],
    createRequests: [],
    verifyRequests: [],
    retryRequests: 0,
  };
  const checkout = makeCheckoutPayload();

  await installRazorpayMock(page);

  await page.route(`**/api/organizations/${ORG_ID}`, route => {
    if (route.request().method() === "GET") return json(route, ORGANIZATION_RESPONSE);
    return json(route, ORGANIZATION_RESPONSE);
  });

  await page.route(`**/api/organizations/${ORG_ID}/billing`, route =>
    json(route, controller.overview)
  );

  await page.route(`**/api/organizations/${ORG_ID}/billing/subscription`, route => {
    controller.createRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    return json(route, checkout);
  });

  await page.route(`**/api/organizations/${ORG_ID}/billing/subscription/verify`, route => {
    controller.verifyRequests.push(route.request().postDataJSON() as Record<string, unknown>);
    controller.operation = makeOperation("APPLIED", {
      providerPaymentId: "pay_success_playwright",
    });
    return json(route, {
      verified: true,
      operation: controller.operation,
      processingUrl: checkout.processingUrl,
      subscription: makeSubscription({
        status: "AUTHENTICATED",
        providerPaymentMethod: "CARD",
        chargeAt: FIRST_CHARGE,
      }),
    });
  });

  await page.route(
    `**/api/organizations/${ORG_ID}/billing/mutations/${CHANGE_ID}/checkout-event`,
    route => {
      const event = route.request().postDataJSON() as Record<string, unknown>;
      controller.checkoutEvents.push(event);
      const status = event.event;
      if (
        status === "ABANDONED"
        || status === "DECLINED"
        || status === "FAILED"
        || status === "AWAITING_PROVIDER_CONFIRMATION"
      ) {
        controller.operation = makeOperation(status, {
          failureCategory: typeof event.failureCategory === "string" ? event.failureCategory : null,
          failureCode: typeof event.failureCode === "string" ? event.failureCode : null,
          providerPaymentId: typeof event.paymentId === "string" ? event.paymentId : null,
        });
      }
      return json(route, { operation: controller.operation });
    }
  );

  await page.route(
    `**/api/organizations/${ORG_ID}/billing/mutations/${CHANGE_ID}/retry`,
    route => {
      controller.retryRequests += 1;
      return json(route, checkout);
    }
  );

  await page.route(
    `**/api/organizations/${ORG_ID}/billing/mutations/${CHANGE_ID}`,
    route => {
      if (route.request().method() === "GET") {
        return json(route, {
          operation: controller.operation,
          processingUrl: checkout.processingUrl,
        });
      }
      return json(route, {
        operation: controller.operation,
        processingUrl: checkout.processingUrl,
      });
    }
  );

  return controller;
}

async function gotoBilling(page: Page, query = "") {
  await page.goto(`${SETTINGS_PATH}${query}#billing`);
  await expect(page.getByRole("heading", { name: "Organization Settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Billing", exact: true })).toBeVisible();
}

async function startBasicAuthorization(page: Page, scenario: CheckoutScenario) {
  await setCheckoutScenario(page, scenario);
  await page.getByRole("button", { name: "Authorize Basic", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: /Authorize Basic after your trial/i });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole("button", { name: "Continue to Razorpay" }).click();
}

test("authenticated workspace exposes normalized billing navigation", async ({ page }) => {
  await page.goto("/app");
  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(page.getByText(/Billing|trial|Standard|Basic/i).first()).toBeVisible();
});

test("shows exact current-trial and post-trial pricing without inventing a charge date", async ({ page }) => {
  const controller = await mockBillingPage(page);
  await gotoBilling(page);

  const summary = page.getByRole("region", { name: "Trial and post-trial billing summary" });
  await expect(summary.getByRole("heading", { name: "Current access" })).toBeVisible();
  await expect(summary.getByText("Standard trial", { exact: true })).toBeVisible();
  await expect(summary.getByText("₹0", { exact: true })).toBeVisible();
  await expect(summary.getByText("5 September 2026", { exact: true })).toBeVisible();
  await expect(summary.getByText("Full Standard features", { exact: true })).toBeVisible();

  await expect(summary.getByRole("heading", { name: "After the trial" })).toBeVisible();
  await expect(summary.getByText("Basic", { exact: true })).toBeVisible();
  await expect(summary.getByText("Not authorized", { exact: true })).toBeVisible();
  await expect(summary.getByText("₹598/month", { exact: true })).toBeVisible();
  await expect(summary.getByText(/2 branches × ₹299/)).toBeVisible();
  await expect(summary.getByText("Not scheduled — authorize a card first", { exact: true })).toBeVisible();
  await expect(summary.getByText(/temporary ₹5 card-verification payment/i)).toBeVisible();

  await expect(page.getByRole("button", { name: "Authorize Basic", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Authorize Standard", exact: true })).toBeEnabled();
  await expect(page.getByText("Selected after trial", { exact: true })).toBeVisible();

  controller.overview = makeOverview(makeExperience({
    selectedPostTrialPlan: null,
    projectedUnitAmount: 0,
    projectedMonthlyTotal: 0,
    paymentAction: "CHOOSE_PLAN",
  }));
  await page.reload();
  await expect(page.getByText("Choose a plan", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Not scheduled — authorize a card first", { exact: true })).toBeVisible();
});

test("labels future authorization separately from a provider-confirmed current plan", async ({ page }) => {
  const authenticated = makeSubscription({
    status: "AUTHENTICATED",
    providerPaymentMethod: "CARD",
    chargeAt: FIRST_CHARGE,
  });
  const controller = await mockBillingPage(
    page,
    makeOverview(
      makeExperience({
        providerStatus: "AUTHENTICATED",
        authorizationStatus: "AUTHORIZED",
        nextChargeAt: FIRST_CHARGE,
      }),
      authenticated
    )
  );
  await gotoBilling(page);

  await expect(page.getByRole("button", { name: "Authorized for after trial" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Change to Standard after trial" })).toBeEnabled();
  await expect(page.getByText("Authorized after trial", { exact: true })).toBeVisible();
  await expect(page.getByText("5 September 2026", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Current plan" })).toHaveCount(0);

  const paidStandard = makeSubscription({
    plan: "PRO",
    planName: "Lab Lords Standard",
    shortName: "Standard",
    amount: 499,
    amountSubunits: 49_900,
    unitAmount: 499,
    monthlyTotal: 998,
    status: "ACTIVE",
    providerPaymentMethod: "CARD",
    paidThrough: "2026-10-05T12:00:00.000Z",
    currentEnd: "2026-10-05T12:00:00.000Z",
    chargeAt: "2026-10-05T12:00:00.000Z",
  });
  controller.overview = makeOverview(
    makeExperience({
      effectivePlan: "STANDARD",
      selectedPostTrialPlan: "STANDARD",
      providerStatus: "ACTIVE",
      customerState: "STANDARD_ACTIVE",
      customerMessage: "Standard is active.",
      trialEndsAt: null,
      trialDaysRemaining: null,
      paidThrough: paidStandard.paidThrough,
      currentUnitAmount: 499,
      currentMonthlyTotal: 998,
      projectedUnitAmount: 499,
      projectedMonthlyTotal: 998,
      authorizationStatus: "AUTHORIZED",
      nextChargeAt: paidStandard.chargeAt,
      paymentAction: "NONE",
    }),
    paidStandard
  );
  await page.reload();

  await expect(page.getByRole("heading", { name: "Current subscription" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Current plan" })).toBeDisabled();
  await expect(page.getByText("Standard trial", { exact: true })).toHaveCount(0);
});

test("billingPlan query opens review first and passes editable payer defaults to card-only Checkout", async ({ page }) => {
  const controller = await mockBillingPage(page);
  await gotoBilling(page, "?billingPlan=PRO");

  const confirmation = page.getByRole("dialog", { name: /Authorize Standard after your trial/i });
  await expect(confirmation).toBeVisible();
  expect(controller.createRequests).toHaveLength(0);
  expect((await getCheckoutHarness(page)).opens).toBe(0);

  await expect(confirmation.getByText("₹0", { exact: true })).toBeVisible();
  await expect(confirmation.getByText("₹998/month", { exact: true })).toBeVisible();
  await expect(confirmation.getByText(/2 branches × ₹499 per branch/)).toBeVisible();
  await expect(confirmation.getByText(/If card authorization succeeds.*5 September 2026/i)).toBeVisible();
  await expect(confirmation.getByText(/temporary ₹5 card-verification payment/i)).toBeVisible();
  await expect(confirmation.getByText(/editable phone and email are billing-contact defaults.*do not tell Lab Lords which mobile number is registered with your card/i)).toBeVisible();
  await expect(confirmation.getByText(/bank or 3-D Secure OTP is controlled by your card issuer.*mobile number, email, or device registered with that issuer/i)).toBeVisible();
  await expect(confirmation.getByText(/does not ask Razorpay to remember your card for one-click payments/i)).toBeVisible();
  await expect(confirmation.getByText(/Test Mode simulates the bank authentication step.*No real OTP, SMS, or email is sent/i)).toBeVisible();

  await confirmation.getByRole("button", { name: "Continue to Razorpay" }).click();
  await expect.poll(async () => (await getCheckoutHarness(page)).opens).toBe(1);
  expect(controller.createRequests).toEqual([
    expect.objectContaining({ plan: "PRO" }),
  ]);

  const harness = await getCheckoutHarness(page);
  expect(harness.lastOptions).toEqual(expect.objectContaining({
    remember_customer: false,
    readonly: { name: false, email: false, contact: false },
    prefill: {
      name: "Billing Owner",
      email: "billing.owner@lablords.test",
      contact: "+919876543210",
    },
    subscriptionId: "sub_playwright_1",
  }));
  expect(harness.lastOptions?.config).toEqual(expect.objectContaining({
    display: expect.objectContaining({
      sequence: ["block.cards"],
      preferences: { show_default_blocks: false },
    }),
  }));
});

test("trial banner dismissal lasts for reloads in this session only", async ({ page }) => {
  await mockBillingPage(page);
  await gotoBilling(page);

  const trialStatus = page.getByRole("status").filter({
    hasText: "Your 30-day Standard trial is active.",
  });
  await expect(trialStatus).toBeVisible();
  await trialStatus.getByRole("button", {
    name: "Dismiss trial reminder for this session",
  }).click();
  await expect(trialStatus).toHaveCount(0);

  expect(await page.evaluate(orgId =>
    window.sessionStorage.getItem(`lablords:billing-banner:trial:${orgId}`), ORG_ID
  )).toBe("dismissed");
  expect(await page.evaluate(orgId =>
    window.localStorage.getItem(`lablords:billing-banner:trial:${orgId}`), ORG_ID
  )).toBeNull();

  await page.reload();
  await expect(page.getByRole("status").filter({
    hasText: "Your 30-day Standard trial is active.",
  })).toHaveCount(0);
});

test("critical payment warnings cannot be dismissed", async ({ page }) => {
  const pending = makeSubscription({
    status: "PENDING",
    providerPaymentMethod: "CARD",
    paidThrough: "2026-08-10T12:00:00.000Z",
  });
  const warningMessage = "Your renewal payment is retrying. Update the card if needed.";
  await mockBillingPage(
    page,
    makeOverview(
      makeExperience({
        accessMode: "WARNING",
        effectivePlan: "STANDARD",
        selectedPostTrialPlan: "STANDARD",
        providerStatus: "PENDING",
        customerState: "PAYMENT_RETRYING",
        customerMessage: warningMessage,
        trialEndsAt: null,
        trialDaysRemaining: null,
        paidThrough: pending.paidThrough,
        authorizationStatus: "AUTHORIZED",
        paymentAction: "UPDATE_CARD",
      }),
      pending
    )
  );
  await gotoBilling(page);

  const warning = page.getByRole("status").filter({ hasText: warningMessage });
  await expect(warning).toBeVisible();
  await expect(warning.getByRole("button", {
    name: "Dismiss trial reminder for this session",
  })).toHaveCount(0);
  await expect(warning.getByText("Manage billing", { exact: true })).toBeVisible();
});

test("dismissed Checkout is recorded as abandoned with a retryable result", async ({ page }) => {
  const controller = await mockBillingPage(page);
  await gotoBilling(page);
  await startBasicAuthorization(page, "dismiss");

  const result = page.getByRole("alertdialog", { name: "Authorization was not completed" });
  await expect(result).toBeVisible();
  await expect(result.getByText(/trial or current confirmed plan remains unchanged/i)).toBeVisible();
  await expect(result.getByRole("button", { name: "Retry authorization" })).toBeVisible();
  await expect(result.getByRole("button", { name: "Continue" })).toBeVisible();
  expect(controller.checkoutEvents).toEqual([
    expect.objectContaining({ event: "ABANDONED" }),
  ]);
});

test("a declined attempt can be retried successfully without preserving the old failure", async ({ page }) => {
  const controller = await mockBillingPage(page);
  await gotoBilling(page);
  await startBasicAuthorization(page, "decline");

  const result = page.getByRole("alertdialog", { name: "The card authorization was declined" });
  await expect(result).toBeVisible();
  await expect(result.getByText(/try another supported card/i)).toBeVisible();
  await expect(result.getByText(/current confirmed plan remains unchanged/i)).toBeVisible();
  expect(controller.checkoutEvents).toEqual([
    expect.objectContaining({
      event: "DECLINED",
      failureCategory: "card_declined",
      failureCode: "BAD_REQUEST_ERROR",
      reason: "card_declined",
      source: "bank",
      step: "payment_authentication",
      paymentId: "pay_declined_playwright",
    }),
  ]);

  await setCheckoutScenario(page, "success");
  await result.getByRole("button", { name: "Try another card" }).click();

  await expect.poll(async () => (await getCheckoutHarness(page)).opens).toBe(2);
  await expect(page).toHaveURL(new RegExp(`/org/${ORG_ID}/billing/processing/${CHANGE_ID}`));
  await expect(page.getByRole("heading", { name: "Billing update confirmed" })).toBeVisible();
  expect(controller.retryRequests).toBe(1);
  expect(controller.verifyRequests).toEqual([
    expect.objectContaining({
      changeId: CHANGE_ID,
      razorpay_payment_id: "pay_success_playwright",
      razorpay_subscription_id: "sub_playwright_1",
      razorpay_signature: "signature_playwright",
    }),
  ]);
  expect(controller.checkoutEvents).toHaveLength(1);
});

test("technical Checkout errors show a non-destructive failure result", async ({ page }) => {
  const controller = await mockBillingPage(page);
  await gotoBilling(page);
  await startBasicAuthorization(page, "technical");

  const result = page.getByRole("alertdialog", {
    name: "Razorpay could not complete the authorization",
  });
  await expect(result).toBeVisible();
  await expect(result.getByText(/bank, network, or provider error/i)).toBeVisible();
  await expect(result.getByText(/No confirmed billing change was applied/i)).toBeVisible();
  expect(controller.checkoutEvents).toEqual([
    expect.objectContaining({
      event: "FAILED",
      failureCategory: "network_error",
      failureCode: "GATEWAY_ERROR",
      source: "network",
      paymentId: "pay_network_playwright",
    }),
  ]);
});

test("unknown payment.failed metadata resolves to a retryable failure instead of verification", async ({ page }) => {
  const controller = await mockBillingPage(page);
  await gotoBilling(page);
  await startBasicAuthorization(page, "ambiguous");

  const result = page.getByRole("alertdialog", {
    name: "Razorpay could not complete the authorization",
  });
  await expect(result).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(`/org/${ORG_ID}/billing/processing/${CHANGE_ID}`));
  expect(controller.checkoutEvents).toEqual([
    expect.objectContaining({
      event: "FAILED",
      failureCategory: "unknown_error",
      paymentId: "pay_unknown_playwright",
    }),
  ]);
});

test("successful Checkout is verified server-side before confirmation is shown", async ({ page }) => {
  const controller = await mockBillingPage(page);
  await gotoBilling(page);
  await startBasicAuthorization(page, "success");

  await expect(page).toHaveURL(new RegExp(`/org/${ORG_ID}/billing/processing/${CHANGE_ID}`));
  await expect(page.getByRole("heading", { name: "Billing update confirmed" })).toBeVisible();
  expect(controller.verifyRequests).toEqual([
    expect.objectContaining({
      changeId: CHANGE_ID,
      razorpay_payment_id: "pay_success_playwright",
      razorpay_subscription_id: "sub_playwright_1",
      razorpay_signature: "signature_playwright",
    }),
  ]);
  expect(controller.checkoutEvents).toHaveLength(0);
});

test("processing retry reopens Razorpay only after the explicit retry click", async ({ page }) => {
  const controller = await mockBillingPage(
    page,
    makeOverview(),
    makeOperation("FAILED", {
      failureCategory: "network_error",
      failureCode: "GATEWAY_ERROR",
      message: "The provider network did not confirm the authorization.",
    })
  );
  await page.goto(`/org/${ORG_ID}/billing/processing/${CHANGE_ID}`);

  await expect(page.getByRole("heading", { name: "We could not apply the billing update" })).toBeVisible();
  expect((await getCheckoutHarness(page)).opens).toBe(0);

  await page.getByRole("button", { name: "Retry safely" }).click();
  await expect.poll(async () => (await getCheckoutHarness(page)).opens).toBe(1);
  expect(controller.retryRequests).toBe(1);
  expect((await getCheckoutHarness(page)).lastOptions).toEqual(expect.objectContaining({
    remember_customer: false,
    readonly: { name: false, email: false, contact: false },
    subscriptionId: "sub_playwright_1",
  }));
});
