import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";

const EMPTY_STATE = { cookies: [], origins: [] };
const ownerAuthState = process.env.PLAYWRIGHT_OWNER_AUTH_STATE;
const managerAuthState = process.env.PLAYWRIGHT_MANAGER_AUTH_STATE;
const hasOwnerAuthState = Boolean(ownerAuthState && fs.existsSync(ownerAuthState));
const managerBranchId = process.env.PLAYWRIGHT_MANAGER_BRANCH_ID;
const hasManagerAuthState = Boolean(
  managerAuthState
  && managerBranchId
  && fs.existsSync(managerAuthState)
);

test.use({ storageState: hasOwnerAuthState ? ownerAuthState! : EMPTY_STATE });
test.beforeEach(() => {
  test.skip(
    !hasOwnerAuthState,
    "Set PLAYWRIGHT_OWNER_AUTH_STATE for owner operations coverage."
  );
});

const ORG_ID = process.env.PLAYWRIGHT_OWNER_ORG_ID ?? "playwright-report-org";
const BRANCH_ID = process.env.PLAYWRIGHT_OWNER_BRANCH_ID ?? "playwright-report-branch";
const SENDER_ID = "playwright-report-sender";

if (managerBranchId && managerBranchId !== BRANCH_ID) {
  throw new Error("Owner and manager browser states must target the same branch.");
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function subscription(scope: "BRANCH" | "ORGANIZATION", status = "ACTIVE") {
  return {
    id: `subscription_${scope.toLowerCase()}`,
    organizationId: ORG_ID,
    branchId: scope === "BRANCH" ? BRANCH_ID : null,
    scope,
    senderId: SENDER_ID,
    maskedPhone: "+91••••••3210",
    language: "en_IN",
    sendTimeLocal: "21:00",
    status,
    confirmationExpiresAt: status === "PENDING_CONFIRMATION"
      ? "2026-08-24T18:15:00.000Z"
      : null,
    confirmationAttemptCount: 0,
    activatedAt: status === "ACTIVE" ? "2026-08-24T17:30:00.000Z" : null,
    pausedAt: null,
    revokedAt: null,
    staleAt: null,
    lastPlannedAt: null,
    lastPlannedLocalDate: null,
    createdAt: "2026-08-24T17:00:00.000Z",
    updatedAt: "2026-08-24T17:30:00.000Z",
  };
}

function reportPreview(scope: "BRANCH" | "ORGANIZATION") {
  const aggregate = {
    localReportDate: "2026-08-24",
    metricsAsOfAt: "2026-08-24T15:45:00.000Z",
    asOfLocalTime: "21:15",
    paymentsRecordedTodayCount: 4,
    paymentsRecordedTodayAmount: 4500,
    newStudentsToday: 2,
    activeStudents: 40,
    usedShiftSlots: 31,
    totalShiftCapacity: 48,
    openDueCount: 9,
    openDueAmount: 12000,
    overdueCount: 3,
    overdueAmount: 2000,
    whatsAppAcceptedToday: 5,
    whatsAppDeliveredToday: 4,
    whatsAppFailedToday: 0,
    whatsAppUnknownToday: 1,
  };
  return {
    scope,
    localReportDate: "2026-08-24",
    scheduledCutoffAt: "2026-08-24T15:30:00.000Z",
    metricsAsOfAt: "2026-08-24T15:45:00.000Z",
    catchUpEndsAt: "2026-08-24T16:30:00.000Z",
    metricsVersion: 2,
    metrics: scope === "ORGANIZATION"
      ? { ...aggregate, organizationName: "Playwright Study Hall", branchCount: 3 }
      : { ...aggregate, branchName: "Playwright Central Branch" },
    template: {
      managedKey: scope === "ORGANIZATION" ? "DAILY_ORGANIZATION_REPORT" : "DAILY_BRANCH_REPORT",
      language: "en_IN",
      renderedPreview: `${scope === "ORGANIZATION" ? "Organization" : "Branch"} deterministic daily report preview.`,
    },
    estimate: {
      currency: "INR",
      estimatedCostMicros: "250000",
      rateCardVersion: "rate-v1",
      rateCardExpiresAt: "2026-08-31T00:00:00.000Z",
      disclaimer: "Estimate only. Meta's final invoice is authoritative.",
    },
    alreadyQueued: false,
  };
}

function queuedReport(scope: "BRANCH" | "ORGANIZATION", replayed = false) {
  return {
    replayed,
    localReportDate: "2026-08-24",
    message: {
      id: `message_${scope.toLowerCase()}`,
      status: "SCHEDULED",
      trigger: "MANUAL",
      scheduledFor: "2026-08-24T15:30:00.000Z",
      localScheduleDate: "2026-08-24",
      rateCardVersion: "rate-v1",
      estimatedCostMicros: "250000",
      dailyReportSnapshotId: "snapshot_1",
      reportSubscriptionId: `subscription_${scope.toLowerCase()}`,
      createdAt: "2026-08-24T15:00:00.000Z",
    },
  };
}

function senderSafety(paused: boolean) {
  return {
    senderLabel: "Playwright Study Hall",
    senderStatus: "ACTIVE",
    paused,
    pauseReason: paused ? "OWNER_PAUSED" : null,
    pausedAt: paused ? "2026-08-24T15:10:00.000Z" : null,
    pauseRevision: paused ? 2 : 1,
    ambiguousOutcomeCount: 1,
    ambiguousWindowStartedAt: "2026-08-24T15:00:00.000Z",
    definiteFailureCount: 0,
    failureWindowStartedAt: null,
    unknownOutcomeCount: 1,
    openCriticalIncidentCount: 0,
    lastAcceptedAt: "2026-08-24T14:50:00.000Z",
    lastDeliveredAt: "2026-08-24T14:51:00.000Z",
    lastHealthCheckAt: "2026-08-24T15:09:00.000Z",
    lastHealthyAt: "2026-08-24T15:09:00.000Z",
    providerRestricted: false,
    templatesHealthy: true,
    rateCardState: "CURRENT",
    rateCardVersion: "rate-v1",
    rateCardExpiresAt: "2026-08-31T00:00:00.000Z",
    resumeEligible: paused,
    resumeBlockers: [],
  };
}

async function blockAndRecordGraph(page: Page) {
  const requests: string[] = [];
  await page.route("https://graph.facebook.com/**", route => {
    requests.push(route.request().url());
    return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });
  return requests;
}

async function mockOrganizationShell(page: Page) {
  await page.route("https://checkout.razorpay.com/v1/checkout.js", route =>
    route.fulfill({ contentType: "application/javascript", body: "window.Razorpay=function(){};" })
  );
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
    json(route, { error: "Billing unavailable in isolated browser coverage" }, 503)
  );
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/config`, route => json(route, {
    enabled: true,
    providerMode: "TEST",
    appId: null,
    embeddedSignupConfigId: null,
    graphApiVersion: null,
    connectionAvailability: "HELD",
    safeReason: "Meta connection changes are held in this isolated test.",
  }));
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/senders`, route => json(route, {
    enabled: true,
    canManage: true,
    safeReason: null,
    senders: [{
      id: SENDER_ID,
      providerMode: "TEST",
      displayPhoneNumber: "+91 98••• 43210",
      verifiedName: "Playwright Study Hall",
      qualityRating: "GREEN",
      accountMode: "SANDBOX",
      status: "ACTIVE",
      phoneRegisteredAt: "2026-08-22T00:00:00.000Z",
      webhookSubscribedAt: "2026-08-22T00:00:00.000Z",
      lastHealthCheckAt: "2026-08-22T00:00:00.000Z",
      lastTemplateSyncAt: null,
      templateCounts: { approved: 2, pending: 0, rejected: 0, other: 0, total: 2 },
      assignedBranches: [],
    }],
  }));
  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/senders/${SENDER_ID}/managed-templates/install`,
    route => json(route, { installation: { catalogVersion: 1, languages: ["en_IN"], templates: [] } })
  );
}

async function mockOrganizationReportSettings(page: Page) {
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/report-settings`, route => json(route, {
    operationsUiEnabled: true,
    settings: {
      enabled: true,
      sender: {
        id: SENDER_ID,
        verifiedName: "Playwright Study Hall",
        maskedPhone: "+91••••••3210",
        status: "ACTIVE",
      },
      monthlyBudgetMinor: 10_000,
      configurationRevision: 2,
      updatedAt: "2026-08-24T17:00:00.000Z",
    },
  }));
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/incidents?limit=50`, route => json(route, {
    incidents: [],
    unknownMessages: [],
  }));
  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/senders/${SENDER_ID}/safety`,
    route => json(route, senderSafety(false))
  );
}

async function mockExactReportRecipientBranch(page: Page, canSendOperations = false) {
  const permissions = {
    manage_org: false,
    manage_branch: canSendOperations,
    students: false,
    seat_allocation: false,
    view_payments: true,
    generate_payments: false,
    mark_payment_paid: false,
    waive_payments: false,
    analytics: true,
    view_whatsapp: true,
    send_whatsapp: canSendOperations,
    manage_whatsapp: canSendOperations,
    receive_whatsapp_reports: true,
    staff_management: false,
  };
  await page.route(`**/api/branches/${BRANCH_ID}/access`, route => json(route, {
    branchId: BRANCH_ID,
    branchName: "Playwright Central Branch",
    organizationId: ORG_ID,
    isOwner: false,
    role: canSendOperations ? "MANAGER" : "STAFF",
    staffId: "staff_report_recipient",
    permissions,
    effectivePlan: "PRO",
    entitlements: ["WHATSAPP_AUTOMATION"],
    billingExperience: {
      accessMode: "FULL",
      customerMessage: "Workspace access is available.",
      branch: { billingStatus: "ACTIVE" },
      viewer: { canManageBilling: false },
    },
  }));
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/branch-assignments?**`, route => json(route, {
    enabled: true,
    canManage: false,
    safeReason: null,
    assignment: {
      branchId: BRANCH_ID,
      sender: {
        id: SENDER_ID,
        providerMode: "TEST",
        displayPhoneNumber: "+91 98••• 43210",
        verifiedName: "Playwright Study Hall",
        qualityRating: "GREEN",
        status: "ACTIVE",
        phoneRegisteredAt: "2026-08-23T08:00:00.000Z",
        webhookSubscribedAt: "2026-08-23T08:00:00.000Z",
      },
      defaultLanguage: "en_IN",
      defaultTone: "polite",
      automationEnabled: false,
    },
    availableSenders: [],
  }));
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/settings`, route => json(route, {
    branchId: BRANCH_ID,
    enabled: true,
    automationEnabled: false,
    automationEnabledAt: null,
    defaultLanguage: "en_IN",
    defaultTone: "polite",
    sendTimeLocal: "21:00",
    dailyAutomaticMessageLimit: 20,
    maxAutomaticCollectionMessagesPerCycle: 3,
    configurationRevision: 4,
    monthlyBudgetMinor: 10_000,
    timeZone: "Asia/Kolkata",
    sender: {
      id: SENDER_ID,
      status: "ACTIVE",
      providerMode: "TEST",
      displayPhoneNumber: "+91 98••• 43210",
      lastHealthCheckAt: "2026-08-23T08:30:00.000Z",
    },
    rules: [],
    templateHealth: [],
    budget: {
      month: "2026-08",
      ceilingMicros: "100000000",
      reservedMicros: "0",
      committedMicros: "0",
      reservedAndCommittedMicros: "0",
      remainingMicros: "100000000",
    },
    consentCoverage: {
      activeStudents: 0,
      missingPhone: 0,
      associated: 0,
      optedIn: 0,
      optedOut: 0,
      stale: 0,
      recipientStatusCounts: {},
    },
    deliveryHealth: {},
    deliveryHealthWindowDays: 30,
    lastWebhookReceivedAt: null,
    lastPlannedAt: null,
    lastPlannerErrorCode: null,
  }));
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/messages?**`, route => json(route, {
    items: [],
    nextCursor: null,
    total: 0,
  }));
}

test("shows an organization confirmation code once and never sends it to Graph", async ({ page }) => {
  const graphRequests = await blockAndRecordGraph(page);
  await mockOrganizationShell(page);
  await mockOrganizationReportSettings(page);
  let currentSubscription: ReturnType<typeof subscription> | null = null;
  const createBodies: unknown[] = [];
  let reportQueueKey: string | null = null;
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/report-subscription`, route => {
    if (route.request().method() === "POST") {
      createBodies.push(route.request().postDataJSON());
      currentSubscription = subscription("ORGANIZATION", "PENDING_CONFIRMATION");
      return json(route, { subscription: currentSubscription, confirmationCode: "AB12CD" }, 201);
    }
    return json(route, { operationsUiEnabled: true, subscription: currentSubscription });
  });
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/reports/preview`, route =>
    json(route, reportPreview("ORGANIZATION"))
  );
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/reports/queue-today`, route => {
    reportQueueKey = route.request().headers()["idempotency-key"] ?? null;
    return json(route, queuedReport("ORGANIZATION"), 202);
  });

  await page.goto(`/org/${ORG_ID}/settings`);
  await expect(page.getByRole("heading", { name: "Organization daily report recipient" })).toBeVisible();
  await page.getByLabel("Report recipient phone").fill("+919876543210");
  await page.getByRole("button", { name: "Create pending subscription" }).click();

  await expect(page.getByText("START REPORTS AB12CD", { exact: true })).toBeVisible();
  expect(createBodies).toEqual([{ phone: "+919876543210", language: "en_IN", sendTimeLocal: "21:00" }]);
  expect(graphRequests).toEqual([]);

  const accessibility = await new AxeBuilder({ page })
    .include("main")
    .analyze();
  expect(accessibility.violations).toEqual([]);

  await page.reload();
  await expect(page.getByText("The original one-time code is no longer displayed.", { exact: false })).toBeVisible();
  await expect(page.getByText("START REPORTS AB12CD", { exact: true })).toHaveCount(0);

  currentSubscription = subscription("ORGANIZATION", "ACTIVE");
  await page.reload();
  await page.getByRole("button", { name: "Preview today's report" }).click();
  await expect(page.getByText("Organization deterministic daily report preview.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Branches", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: /reviewed the aggregate snapshot/i }).check();
  await page.getByRole("button", { name: "Confirm and queue today's report" }).click();
  await expect(page.getByText("Queue status: queued.", { exact: false })).toBeVisible();
  expect(reportQueueKey).toMatch(/\S+/);
  expect(graphRequests).toEqual([]);
});

test.describe("Manager authenticated WhatsApp operations", () => {
  test.use({ storageState: hasManagerAuthState ? managerAuthState! : EMPTY_STATE });
  test.beforeEach(() => {
    test.skip(
      !hasManagerAuthState,
      "Set PLAYWRIGHT_MANAGER_AUTH_STATE and PLAYWRIGHT_MANAGER_BRANCH_ID for manager operations coverage."
    );
  });

test("lets an exact branch report recipient preview and queue without manage_branch", async ({ page }) => {
  const graphRequests = await blockAndRecordGraph(page);
  await mockExactReportRecipientBranch(page);
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/report-subscription`, route => json(route, {
    operationsUiEnabled: true,
    subscription: subscription("BRANCH"),
  }));
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/incidents?limit=50`, route => json(route, {
    incidents: [],
    unknownMessages: [],
  }));

  let previewPosts = 0;
  let queuePosts = 0;
  let queueKey: string | null = null;
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/reports/preview`, async route => {
    previewPosts += 1;
    expect(route.request().postDataJSON()).toEqual({});
    await new Promise(resolve => setTimeout(resolve, 25));
    return json(route, reportPreview("BRANCH"));
  });
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/reports/queue-today`, async route => {
    queuePosts += 1;
    queueKey = route.request().headers()["idempotency-key"] ?? null;
    expect(route.request().postDataJSON()).toEqual({});
    await new Promise(resolve => setTimeout(resolve, 25));
    return json(route, queuedReport("BRANCH"), 202);
  });

  await page.goto(`/branch/${BRANCH_ID}/settings`);
  await expect(page.getByRole("heading", { name: "WhatsApp Daily Reports" })).toBeVisible();
  await expect(page.getByText("This access does not grant branch settings management.")).toBeVisible();
  await expect(page.getByText("WhatsApp Reports", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Branch Settings", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Branch name", { exact: true })).toHaveCount(0);

  const previewButton = page.getByRole("button", { name: "Preview today's report" });
  await previewButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByText("Branch deterministic daily report preview.")).toBeVisible();
  expect(previewPosts).toBe(1);
  await expect(page.getByText("This is an estimate, not an invoice", { exact: false })).toBeVisible();

  await page.getByRole("checkbox", { name: /reviewed the aggregate snapshot/i }).check();
  const queueButton = page.getByRole("button", { name: "Confirm and queue today's report" });
  await queueButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByText("Queue status: queued.", { exact: false })).toBeVisible();
  expect(queuePosts).toBe(1);
  expect(queueKey).toMatch(/\S+/);
  expect(graphRequests).toEqual([]);
});

test("queues only a typed service notice and shows UNKNOWN evidence without a retry action", async ({ page }) => {
  const graphRequests = await blockAndRecordGraph(page);
  await mockExactReportRecipientBranch(page, true);
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/report-subscription`, route => json(route, {
    operationsUiEnabled: true,
    subscription: subscription("BRANCH"),
  }));

  let noticeStatus = "QUEUED";
  let incidentStatus = "OPEN";
  let previewPosts = 0;
  let queuePosts = 0;
  let queuedBody: Record<string, unknown> | null = null;
  let queueKey: string | null = null;
  let cancelBody: unknown = null;
  let acknowledgeBody: unknown = null;
  const incident = () => ({
    id: "incident_unknown_1",
    organizationId: ORG_ID,
    branchId: BRANCH_ID,
    senderId: SENDER_ID,
    messageId: "message_unknown_1",
    type: "UNKNOWN_DELIVERY",
    severity: "CRITICAL",
    status: incidentStatus,
    safeCode: "META_MUTATION_OUTCOME_UNKNOWN",
    firstSeenAt: "2026-08-24T15:00:00.000Z",
    lastSeenAt: "2026-08-24T15:01:00.000Z",
    occurrenceCount: 1,
    acknowledgedAt: incidentStatus === "ACKNOWLEDGED" ? "2026-08-24T15:02:00.000Z" : null,
    resolvedAt: null,
    resolutionCode: null,
  });
  const listedNotice = () => ({
    id: "notice_existing_1",
    type: "BRANCH_CLOSED",
    reason: "PUBLIC_HOLIDAY",
    localEffectiveDate: "2026-08-25",
    status: noticeStatus,
    eligibleRecipientCount: 12,
    queuedMessageCount: noticeStatus === "CANCELLED" ? 0 : 12,
    suppressedCount: 1,
    scheduledFor: "2026-08-24T15:00:00.000Z",
    estimatedCostMicros: "3000000",
    rateCardVersion: "rate-v1",
    canCancel: noticeStatus !== "CANCELLED",
    queuedAt: "2026-08-24T14:55:00.000Z",
    cancelledAt: noticeStatus === "CANCELLED" ? "2026-08-24T15:03:00.000Z" : null,
    completedAt: null,
    createdAt: "2026-08-24T14:55:00.000Z",
  });

  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/incidents?limit=50`, route => json(route, {
    incidents: [incident()],
    unknownMessages: [{
      id: "message_unknown_1",
      organizationId: ORG_ID,
      branchId: BRANCH_ID,
      senderId: SENDER_ID,
      purpose: "SERVICE_NOTICE",
      scheduledFor: "2026-08-24T15:00:00.000Z",
      submissionStartedAt: "2026-08-24T15:00:01.000Z",
      estimatedCostMicros: "250000",
      reportSubscriptionId: null,
      dailyReportSnapshotId: null,
      serviceNoticeId: "notice_existing_1",
      paymentResolutionEventId: null,
      providerStatusTimestamp: null,
      maskedRecipient: "+91••••••4321",
      laterWebhookArrived: false,
    }],
  }));
  await page.route(
    `**/api/branches/${BRANCH_ID}/whatsapp/incidents/incident_unknown_1/acknowledge`,
    route => {
      acknowledgeBody = route.request().postDataJSON();
      incidentStatus = "ACKNOWLEDGED";
      return json(route, incident());
    }
  );
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/service-notices?limit=20`, route =>
    json(route, { notices: [listedNotice()] })
  );
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/service-notices/preview`, async route => {
    previewPosts += 1;
    await new Promise(resolve => setTimeout(resolve, 25));
    return json(route, {
      renderedPreview: "Playwright Central Branch will be closed for a public holiday.",
      eligibleRecipientCount: 12,
      suppressedCount: 1,
      estimatedCostMicros: "3000000",
      currency: "INR",
      rateCardVersion: "rate-v1",
      scheduledFor: "2026-08-24T15:00:00.000Z",
      budgetRemainingAfterMicros: "97000000",
      estimateDisclaimer: "Estimated customer-owned Meta usage.",
    });
  });
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/service-notices`, async route => {
    queuePosts += 1;
    queuedBody = route.request().postDataJSON() as Record<string, unknown>;
    queueKey = route.request().headers()["idempotency-key"] ?? null;
    await new Promise(resolve => setTimeout(resolve, 25));
    return json(route, {
      replayed: false,
      noticeId: "notice_new_1",
      status: "QUEUED",
      queuedMessageCount: 12,
      suppressedCount: 1,
    }, 202);
  });
  await page.route(
    `**/api/branches/${BRANCH_ID}/whatsapp/service-notices/notice_existing_1/cancel`,
    route => {
      cancelBody = route.request().postDataJSON();
      noticeStatus = "CANCELLED";
      return json(route, {
        noticeId: "notice_existing_1",
        status: "CANCELLED",
        queuedMessageCount: 0,
        suppressedCount: 1,
      });
    }
  );

  await page.goto(`/branch/${BRANCH_ID}/settings`);
  await expect(page.getByRole("heading", { name: "Operational service notice" })).toBeVisible();
  await expect(page.locator("textarea")).toHaveCount(0);
  await expect(page.getByText("Do not retry.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /retry/i })).toHaveCount(0);
  await expect(page.getByText("+91••••••4321")).toBeVisible();
  await expect(page.getByText("+919876543210")).toHaveCount(0);

  await page.getByLabel("Closure local date").fill("2026-08-25");
  await page.getByLabel("Resume local date").fill("2026-08-26");
  const previewButton = page.getByRole("button", { name: "Preview typed notice" });
  await previewButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByText("12", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("This is an estimate, not an invoice", { exact: false })).toBeVisible();
  expect(previewPosts).toBe(1);

  await page.getByRole("checkbox", { name: /reviewed the fixed operational wording/i }).check();
  const queueButton = page.getByRole("button", { name: "Confirm charges and queue notice" });
  await queueButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(page.getByText("Notice status: queued.", { exact: false })).toBeVisible();
  expect(queuePosts).toBe(1);
  expect(queueKey).toMatch(/\S+/);
  expect(queuedBody).toEqual({
    type: "BRANCH_CLOSED",
    reason: "PUBLIC_HOLIDAY",
    localEffectiveDate: "2026-08-25",
    resumeLocalDate: "2026-08-26",
    openingTimeLocal: null,
    closingTimeLocal: null,
    maintenanceStartTimeLocal: null,
    maintenanceEndTimeLocal: null,
    delivery: "IMMEDIATE",
    scheduledForLocal: null,
    confirmCustomerCharge: true,
  });

  await page.getByRole("button", { name: "Cancel unsubmitted" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel unsubmitted", exact: true }).click();
  await expect(page.getByText("Cancellation reconciled:", { exact: false })).toBeVisible();
  expect(cancelBody).toEqual({ confirmation: true });

  await page.getByRole("button", { name: "Acknowledge incident" }).click();
  await expect(page.getByText("Incident acknowledged.", { exact: false })).toBeVisible();
  expect(acknowledgeBody).toEqual({ confirmation: true });
  expect(graphRequests).toEqual([]);
});
});

test("pauses and safely resumes a sender without retrying UNKNOWN messages", async ({ page }) => {
  const graphRequests = await blockAndRecordGraph(page);
  await mockOrganizationShell(page);
  await mockOrganizationReportSettings(page);
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/report-subscription`, route => json(route, {
    operationsUiEnabled: true,
    subscription: subscription("ORGANIZATION"),
  }));

  const safetyPath = `**/api/organizations/${ORG_ID}/whatsapp/senders/${SENDER_ID}/safety`;
  await page.unroute(safetyPath);
  let paused = false;
  let pauseBody: unknown = null;
  let resumeBody: unknown = null;
  await page.route(safetyPath, route => json(route, senderSafety(paused)));
  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/senders/${SENDER_ID}/pause`,
    route => {
      pauseBody = route.request().postDataJSON();
      paused = true;
      return json(route, {
        changed: true,
        paused: true,
        pauseReason: "OWNER_PAUSED",
        pauseRevision: 2,
      });
    }
  );
  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/senders/${SENDER_ID}/resume`,
    route => {
      resumeBody = route.request().postDataJSON();
      paused = false;
      return json(route, {
        changed: true,
        paused: false,
        pauseRevision: 3,
        unknownRetried: false,
      });
    }
  );

  await page.goto(`/org/${ORG_ID}/settings`);
  await expect(page.getByRole("heading", { name: "Sender delivery safety" })).toBeVisible();
  await expect(page.getByText("Unknown delivery warning:", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Pause sender delivery" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Pause delivery", exact: true }).click();
  await expect(page.getByText("Delivery paused", { exact: true })).toBeVisible();
  expect(pauseBody).toEqual({ confirmation: true });

  await page.getByRole("button", { name: "Resume sender delivery" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm safe resume", exact: true }).click();
  await expect(page.getByText("Sender delivery resumed.", { exact: false })).toBeVisible();
  await expect(page.getByText("Delivery active", { exact: true })).toBeVisible();
  expect(resumeBody).toEqual({ confirmation: true });
  expect(graphRequests).toEqual([]);
});
