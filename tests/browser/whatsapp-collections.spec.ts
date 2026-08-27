import fs from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type Route } from "@playwright/test";
import {
  WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
  WHATSAPP_OPERATIONAL_CONSENT_STATEMENT,
} from "@/lib/whatsappConsentPolicy";

const EMPTY_STATE = { cookies: [], origins: [] };
const ownerAuthStatePath = process.env.PLAYWRIGHT_OWNER_AUTH_STATE;
const managerAuthStatePath = process.env.PLAYWRIGHT_MANAGER_AUTH_STATE;
const managerBranchId = process.env.PLAYWRIGHT_MANAGER_BRANCH_ID;
const hasOwnerSession = Boolean(ownerAuthStatePath && fs.existsSync(ownerAuthStatePath));
const hasManagerSession = Boolean(
  managerAuthStatePath
  && managerBranchId
  && fs.existsSync(managerAuthStatePath)
);

test.use({ storageState: hasOwnerSession ? ownerAuthStatePath! : EMPTY_STATE });
test.beforeEach(async ({ page }) => {
  test.skip(
    !hasOwnerSession,
    "Set PLAYWRIGHT_OWNER_AUTH_STATE to run authenticated WhatsApp collections coverage."
  );
  await page.route("https://graph.facebook.com/**", route =>
    route.abort("blockedbyclient")
  );
});

const ORG_ID = process.env.PLAYWRIGHT_OWNER_ORG_ID ?? "playwright-pr3-org";
const BRANCH_ID = process.env.PLAYWRIGHT_OWNER_BRANCH_ID ?? "playwright-pr3-branch";
const SENDER_ID = "sender_pr3_1";

if (managerBranchId && managerBranchId !== BRANCH_ID) {
  throw new Error("Owner and manager browser states must target the same branch.");
}
const STUDENT_ONE_ID = "student_pr3_1";
const STUDENT_TWO_ID = "student_pr3_2";
const PAYMENT_ID = "payment_pr3_1";
const AUTOMATION_CONFIRMATION = "I understand messages may incur charges in the customer-owned Meta account; only future stages will be automated; historical dues will not be automatically blasted; Meta determines final billing; and STOP immediately suppresses future unsubmitted messages.";
const MANUAL_QUEUE_CONFIRMATION = "I reviewed the official preview, server suppressions, recipient grouping, and estimated customer-owned Meta usage.";

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function shortProviderDelay() {
  await new Promise(resolve => setTimeout(resolve, 75));
}

async function assertNoSeriousAxeViolations(page: Page, selector: string) {
  const results = await new AxeBuilder({ page }).include(selector).analyze();
  expect(
    results.violations.filter(item => item.impact === "critical" || item.impact === "serious"),
    results.violations.map(item => `${item.id}: ${item.help}`).join("\n")
  ).toEqual([]);
}

async function mockExternalScripts(page: Page) {
  const graphRequests: string[] = [];
  page.on("request", request => {
    if (new URL(request.url()).hostname === "graph.facebook.com") {
      graphRequests.push(request.url());
    }
  });
  await page.route("https://graph.facebook.com/**", route => route.abort("blockedbyclient"));
  await page.route("https://checkout.razorpay.com/v1/checkout.js*", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.Razorpay=function(){};",
  }));
  await page.route("https://connect.facebook.net/en_US/sdk.js*", route => route.fulfill({
    contentType: "application/javascript",
    body: "window.FB={init:function(){},login:function(){}};",
  }));
  return graphRequests;
}

function senderFixture() {
  return {
    id: SENDER_ID,
    providerMode: "TEST",
    displayPhoneNumber: "+91 98••• 43210",
    verifiedName: "Synthetic Study Hall",
    qualityRating: "GREEN",
    accountMode: "SANDBOX",
    status: "ACTIVE",
    phoneRegisteredAt: "2026-08-23T08:00:00.000Z",
    webhookSubscribedAt: "2026-08-23T08:00:00.000Z",
    lastHealthCheckAt: "2026-08-23T08:30:00.000Z",
    lastTemplateSyncAt: "2026-08-23T08:35:00.000Z",
    templateCounts: { approved: 1, pending: 1, rejected: 0, other: 0, total: 2 },
    assignedBranches: [{ id: BRANCH_ID, name: "Synthetic Central Branch" }],
  };
}

function installationFixture() {
  return {
    catalogVersion: 1,
    languages: ["en_IN", "hi"],
    templates: [
      {
        managedKey: "FEE_RENEWAL_POLITE",
        language: "en_IN",
        providerTemplateName: "lablords_fee_renewal_polite_en_in_v1",
        providerTemplateId: "provider-template-synthetic-1",
        status: "READY",
        active: true,
        errorCode: null,
        providerCategory: "UTILITY",
        providerStatus: "APPROVED",
        lastSyncedAt: "2026-08-23T08:35:00.000Z",
      },
      {
        managedKey: "FEE_RENEWAL_POLITE",
        language: "hi",
        providerTemplateName: "lablords_fee_renewal_polite_hi_v1",
        providerTemplateId: null,
        status: "UNKNOWN",
        active: false,
        errorCode: "META_MUTATION_OUTCOME_UNKNOWN",
        providerCategory: null,
        providerStatus: null,
        lastSyncedAt: null,
      },
    ],
  };
}

async function mockOrganizationSettings(page: Page) {
  let installPosts = 0;
  const installBodies: unknown[] = [];
  let persistedStatusReads = 0;
  const installation = installationFixture();

  await page.route(`**/api/organizations/${ORG_ID}`, route => fulfillJson(route, {
    id: ORG_ID,
    name: "Synthetic Study Hall",
    businessType: "Study Hall",
    legalName: null,
    contactEmail: "owner@example.test",
    contactPhone: "9876543210",
    address: "Synthetic address",
    timezone: "Asia/Kolkata",
    currency: "INR",
    weekStartsOn: 1,
    paymentGraceDays: 0,
    ownerId: "synthetic-owner",
    subscription: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    branches: [],
    _count: { branches: 0 },
  }));
  await page.route(`**/api/organizations/${ORG_ID}/billing`, route =>
    fulfillJson(route, { error: "Billing intentionally isolated in this UI test" }, 503)
  );
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/config`, route => fulfillJson(route, {
    enabled: true,
    providerMode: "TEST",
    appId: "synthetic-browser-app-id",
    embeddedSignupConfigId: "synthetic-config-id",
    graphApiVersion: "v25.0",
    connectionAvailability: "AVAILABLE",
    safeReason: null,
  }));
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/senders`, route => fulfillJson(route, {
    enabled: true,
    canManage: true,
    safeReason: null,
    senders: [senderFixture()],
  }));
  await page.route(`**/api/organizations/${ORG_ID}/whatsapp/report-subscription`, route => fulfillJson(route, {
    operationsUiEnabled: false,
    subscription: null,
  }));
  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/senders/${SENDER_ID}/managed-templates/install`,
    async route => {
      if (route.request().method() === "GET") {
        persistedStatusReads += 1;
        return fulfillJson(route, { installation });
      }
      installPosts += 1;
      installBodies.push(route.request().postDataJSON());
      await shortProviderDelay();
      return fulfillJson(route, { installation });
    }
  );

  return {
    get installPosts() { return installPosts; },
    get installBodies() { return installBodies; },
    get persistedStatusReads() { return persistedStatusReads; },
  };
}

const permissionKeys = [
  "manage_org",
  "manage_branch",
  "students",
  "seat_allocation",
  "view_payments",
  "generate_payments",
  "mark_payment_paid",
  "waive_payments",
  "analytics",
  "view_whatsapp",
  "send_whatsapp",
  "manage_whatsapp",
  "receive_whatsapp_reports",
  "staff_management",
] as const;

function accessFixture({
  isOwner = true,
  manageWhatsApp = true,
  sendWhatsApp = true,
}: {
  isOwner?: boolean;
  manageWhatsApp?: boolean;
  sendWhatsApp?: boolean;
} = {}) {
  const permissions = Object.fromEntries(permissionKeys.map(key => [key, true]));
  permissions.manage_whatsapp = manageWhatsApp;
  permissions.send_whatsapp = sendWhatsApp;
  return {
    branchId: BRANCH_ID,
    branchName: "Synthetic Central Branch",
    organizationId: ORG_ID,
    isOwner,
    role: isOwner ? "OWNER" : "MANAGER",
    permissions,
    effectivePlan: "PRO",
    entitlements: ["STAFF_MANAGEMENT", "ADVANCED_ANALYTICS", "AI_ACCESS", "WHATSAPP_AUTOMATION"],
    billingExperience: {
      accessMode: "FULL_ACCESS",
      customerMessage: "",
      branch: { billingStatus: "ACTIVE" },
      viewer: { canManageBilling: isOwner },
    },
  };
}

async function mockAccess(page: Page, readAccess: () => ReturnType<typeof accessFixture>) {
  await page.route(`**/api/branches/${BRANCH_ID}/access`, route =>
    fulfillJson(route, readAccess())
  );
}

async function mockBranchIdentity(page: Page) {
  await page.route(`**/api/branches/${BRANCH_ID}`, route => fulfillJson(route, {
    id: BRANCH_ID,
    name: "Synthetic Central Branch",
    city: "Delhi",
    address: "Synthetic address",
    contactPhone: "+919876543210",
    openingTime: "06:00",
    closingTime: "22:00",
    defaultFee: 1500,
    defaultAdmissionFee: 100,
    defaultMessageLanguage: "en",
    reminderTone: "polite",
    aiEnabled: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    lastDataChange: "2026-08-23T08:00:00.000Z",
    organization: { id: ORG_ID, name: "Synthetic Study Hall" },
    _count: { seats: 10, students: 2, shifts: 1, payments: 1, staff: 0 },
    shifts: [],
    staff: [],
  }));
  await page.route(`**/api/branches/${BRANCH_ID}/billing`, route => fulfillJson(route, {
    organizationId: ORG_ID,
    branchStatus: "ACTIVE",
    inheritedPlan: "PRO",
    billingState: "ACTIVE",
    accessMode: "FULL",
    billingUrl: `/org/${ORG_ID}/settings#billing`,
  }));
}

function branchSettingsFixture(state: { deliveryEnabled: boolean; automationEnabled: boolean }) {
  return {
    branchId: BRANCH_ID,
    enabled: state.deliveryEnabled,
    automationEnabled: state.automationEnabled,
    automationEnabledAt: state.automationEnabled ? "2026-08-23T09:00:00.000Z" : null,
    defaultLanguage: "en_IN",
    defaultTone: "polite",
    sendTimeLocal: "10:00",
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
    rules: [
      { stage: "FEE_DUE_TODAY", enabled: true },
      { stage: "WELCOME", enabled: false },
      { stage: "FEE_DUE_MINUS_7", enabled: false },
      { stage: "FEE_DUE_MINUS_3", enabled: false },
      { stage: "FEE_DUE_MINUS_1", enabled: false },
      { stage: "PAST_DUE_PLUS_1", enabled: false },
      { stage: "PAST_DUE_PLUS_3", enabled: false },
      { stage: "PAST_DUE_PLUS_7", enabled: false },
      { stage: "PAYMENT_CONFIRMATION", enabled: false },
      { stage: "PAYMENT_CORRECTION", enabled: false },
    ],
    templateHealth: ["FEE_RENEWAL_POLITE", "MULTI_STUDENT_COLLECTION_SUMMARY"].map(managedKey => ({
      managedKey,
      active: true,
      template: { providerStatus: "APPROVED", category: "UTILITY", staleAt: null },
    })),
    budget: {
      month: "2026-08",
      ceilingMicros: "100000000",
      reservedMicros: "250000",
      committedMicros: "0",
      reservedAndCommittedMicros: "250000",
      remainingMicros: "99750000",
    },
    consentCoverage: {
      activeStudents: 2,
      missingPhone: 1,
      associated: 1,
      optedIn: 1,
      optedOut: 0,
      stale: 0,
      recipientStatusCounts: { ACTIVE: 1 },
    },
    deliveryHealth: { UNKNOWN: 1 },
    deliveryHealthWindowDays: 30,
    lastWebhookReceivedAt: "2026-08-23T08:40:00.000Z",
    lastPlannedAt: "2026-08-23T08:45:00.000Z",
    lastPlannerErrorCode: null,
  };
}

function unknownHistoryFixture() {
  return {
    items: [{
      id: "message_unknown_1",
      student: { id: STUDENT_ONE_ID, name: "Aarav Synthetic" },
      maskedPhone: "+91••••••3210",
      purpose: "MANUAL_REMINDER",
      trigger: "MANUAL",
      automationStage: null,
      managedTemplateKey: "PAST_DUE_POLITE",
      template: { name: "lablords_past_due_polite_en_in_v1", language: "en_IN" },
      status: "UNKNOWN",
      scheduledFor: "2026-08-23T10:00:00.000Z",
      submissionStartedAt: "2026-08-23T10:00:01.000Z",
      acceptedAt: null,
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      failedAt: null,
      safeFailureCode: "META_MUTATION_OUTCOME_UNKNOWN",
      estimatedCostMicros: "250000",
      providerBillable: null,
      providerPricingCategory: null,
      createdBy: { id: "manager_synthetic", name: "Synthetic Manager" },
      payments: [{ id: PAYMENT_ID, status: "DUE", amount: 1500, dueDate: "2026-08-20T00:00:00.000Z" }],
      createdAt: "2026-08-23T10:00:00.000Z",
    }],
    nextCursor: null,
    total: 1,
  };
}

async function mockBranchWhatsApp(page: Page) {
  const state = { deliveryEnabled: false, automationEnabled: false };
  let deliveryPosts = 0;
  let automationPosts = 0;
  const automationBodies: unknown[] = [];

  await page.route(
    `**/api/organizations/${ORG_ID}/whatsapp/branch-assignments?**`,
    route => fulfillJson(route, {
      enabled: true,
      canManage: true,
      safeReason: null,
      assignment: {
        branchId: BRANCH_ID,
        sender: {
          id: SENDER_ID,
          providerMode: "TEST",
          displayPhoneNumber: "+91 98••• 43210",
          verifiedName: "Synthetic Study Hall",
          qualityRating: "GREEN",
          status: "ACTIVE",
          phoneRegisteredAt: "2026-08-23T08:00:00.000Z",
          webhookSubscribedAt: "2026-08-23T08:00:00.000Z",
        },
        defaultLanguage: "en_IN",
        defaultTone: "polite",
        automationEnabled: false,
      },
      availableSenders: [{
        id: SENDER_ID,
        providerMode: "TEST",
        displayPhoneNumber: "+91 98••• 43210",
        verifiedName: "Synthetic Study Hall",
        qualityRating: "GREEN",
        status: "ACTIVE",
        phoneRegisteredAt: "2026-08-23T08:00:00.000Z",
        webhookSubscribedAt: "2026-08-23T08:00:00.000Z",
      }],
    })
  );
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/settings`, route => {
    if (route.request().method() === "PATCH") return fulfillJson(route, { updated: true });
    return fulfillJson(route, branchSettingsFixture(state));
  });
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/report-subscription`, route => fulfillJson(route, {
    operationsUiEnabled: false,
    subscription: null,
  }));
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/messages?**`, route =>
    fulfillJson(route, unknownHistoryFixture())
  );
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/delivery/enable`, async route => {
    deliveryPosts += 1;
    await shortProviderDelay();
    state.deliveryEnabled = true;
    return fulfillJson(route, { enabled: true });
  });
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/automation/enable`, async route => {
    automationPosts += 1;
    automationBodies.push(route.request().postDataJSON());
    await shortProviderDelay();
    state.automationEnabled = true;
    return fulfillJson(route, { enabled: true, prospectiveFrom: "2026-08-23T09:00:00.000Z" });
  });

  return {
    get deliveryPosts() { return deliveryPosts; },
    get automationPosts() { return automationPosts; },
    get automationBodies() { return automationBodies; },
  };
}

function studentFixture(id: string, name: string, phone: string | null) {
  return {
    id,
    branchId: BRANCH_ID,
    name,
    phone,
    status: "ACTIVE",
    monthlyFee: 1500,
    admissionFee: 100,
    joinedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    seatAllocations: [],
  };
}

async function mockStudents(page: Page) {
  const students = [
    studentFixture(STUDENT_ONE_ID, "Aarav Synthetic", "+919876543210"),
    studentFixture(STUDENT_TWO_ID, "Anaya Synthetic", null),
  ];
  let individualPosts = 0;
  let bulkPosts = 0;
  const individualBodies: unknown[] = [];
  const bulkBodies: unknown[] = [];
  let recipient: Record<string, unknown> | null = null;

  const recipientState = () => ({
    studentId: STUDENT_ONE_ID,
    studentStatus: "ACTIVE",
    maskedPhone: "••••••3210",
    studentMaskedPhone: "••••••3210",
    assignedSender: {
      id: SENDER_ID,
      status: "ACTIVE",
      verifiedName: "Synthetic Study Hall",
      maskedPhone: "••••••4321",
    },
    recipient,
  });

  await page.route(`**/api/branches/${BRANCH_ID}/students?**`, route => {
    const status = new URL(route.request().url()).searchParams.get("status");
    return fulfillJson(route, {
      items: status === "INACTIVE" ? [] : students,
      nextCursor: null,
      total: status === "INACTIVE" ? 0 : students.length,
    });
  });
  await page.route(
    `**/api/branches/${BRANCH_ID}/whatsapp/recipients/student/${STUDENT_ONE_ID}`,
    route => fulfillJson(route, recipientState())
  );
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/recipients`, async route => {
    individualPosts += 1;
    individualBodies.push(route.request().postDataJSON());
    await shortProviderDelay();
    recipient = {
      id: "recipient_pr3_1",
      studentId: STUDENT_ONE_ID,
      relationship: "SELF",
      status: "ACTIVE",
      consentStatus: "OPTED_IN",
      consentType: "OPERATIONAL",
      policyVersion: WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION,
      maskedPhone: "••••••3210",
      phoneMatchesCurrentStudent: true,
      consentSource: "IN_PERSON",
      consentRecordedAt: "2026-08-23T09:10:00.000Z",
      verifiedAt: "2026-08-23T09:10:00.000Z",
      staleAt: null,
      disabledAt: null,
    };
    return fulfillJson(route, {
      recipient: { id: "recipient_pr3_1", studentId: STUDENT_ONE_ID, relationship: "SELF", status: "ACTIVE" },
      changed: true,
      consentChanged: true,
    });
  });
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/recipients/bulk`, async route => {
    bulkPosts += 1;
    bulkBodies.push(route.request().postDataJSON());
    await shortProviderDelay();
    return fulfillJson(route, {
      requestedCount: 2,
      associatedCount: 1,
      unchangedCount: 0,
      skipped: [{ studentId: STUDENT_TWO_ID, reason: "NO_PHONE" }],
    });
  });

  return {
    get individualPosts() { return individualPosts; },
    get bulkPosts() { return bulkPosts; },
    get individualBodies() { return individualBodies; },
    get bulkBodies() { return bulkBodies; },
  };
}

async function mockOverdueCollections(page: Page) {
  let previewPosts = 0;
  let queuePosts = 0;
  const previewBodies: unknown[] = [];
  const queueBodies: unknown[] = [];
  const queueIdempotencyKeys: string[] = [];

  await page.route(`**/api/branches/${BRANCH_ID}/payments/overdue*`, route => fulfillJson(route, {
    items: [{
      paymentId: PAYMENT_ID,
      studentId: STUDENT_ONE_ID,
      studentName: "Aarav Synthetic",
      phone: "+919876543210",
      dueDate: "2026-08-20T00:00:00.000Z",
      amount: 1500,
      daysOverdue: 3,
    }],
    nextCursor: null,
    total: 1,
  }));
  await page.route("**/api/users/me", route => fulfillJson(route, {
    id: "synthetic-owner",
    defaultMessageLanguage: "en",
  }));
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/payment-reminders/preview`, async route => {
    previewPosts += 1;
    previewBodies.push(route.request().postDataJSON());
    await shortProviderDelay();
    return fulfillJson(route, {
      selectedPaymentCount: 1,
      eligibleRecipientCount: 1,
      suppressedCount: 0,
      estimatedCostMicros: "250000",
      rateCardVersion: "synthetic-rate-v1",
      currency: "INR",
      groups: [{
        maskedPhone: "+91••••••3210",
        paymentCount: 1,
        studentCount: 1,
        studentName: "Aarav Synthetic",
        managedTemplateKey: "PAST_DUE_POLITE",
        renderedPreview: "Namaste Aarav. Your ₹1,500 fee remains due.",
        scheduledFor: "2026-08-23T10:00:00.000Z",
      }],
      suppressed: [],
      estimateDisclaimer: "Estimated Meta usage. Final charges are determined by Meta.",
    });
  });
  await page.route(`**/api/branches/${BRANCH_ID}/whatsapp/payment-reminders`, async route => {
    queuePosts += 1;
    queueBodies.push(route.request().postDataJSON());
    queueIdempotencyKeys.push(route.request().headers()["idempotency-key"] ?? "");
    await shortProviderDelay();
    return fulfillJson(route, {
      replayed: false,
      request: {
        id: "manual_request_pr3_1",
        status: "QUEUED",
        selectedPaymentCount: 1,
        eligibleRecipientCount: 1,
        queuedMessageCount: 1,
        suppressedCount: 0,
        estimatedCostMicros: "250000",
        createdAt: "2026-08-23T09:20:00.000Z",
        completedAt: "2026-08-23T09:20:01.000Z",
      },
    });
  });

  return {
    get previewPosts() { return previewPosts; },
    get queuePosts() { return queuePosts; },
    get previewBodies() { return previewBodies; },
    get queueBodies() { return queueBodies; },
    get queueIdempotencyKeys() { return queueIdempotencyKeys; },
  };
}

test("reloads persisted managed-template state and deduplicates rapid installation clicks", async ({ page }) => {
  const graphRequests = await mockExternalScripts(page);
  const api = await mockOrganizationSettings(page);

  await page.goto(`/org/${ORG_ID}/settings#whatsapp`);
  const whatsApp = page.locator("#whatsapp");
  await expect(whatsApp.getByText("Lab Lords Utility catalogue v1")).toBeVisible();
  await expect(whatsApp.getByText("Fee renewal polite · English (India)")).toBeVisible();
  await expect(whatsApp.getByText("Provider: Approved · Utility")).toBeVisible();
  await expect(whatsApp.getByText("Binding active", { exact: false })).toBeVisible();
  await expect(whatsApp.getByText(/Do not retry; synchronize or request operator review/)).toBeVisible();
  expect(api.persistedStatusReads).toBeGreaterThanOrEqual(1);

  const install = whatsApp.getByRole("button", { name: "Install Lab Lords Utility templates" });
  await install.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => api.installPosts).toBe(1);
  await expect(whatsApp.getByText("1 managed template is approved and active.", { exact: false })).toBeVisible();
  expect(api.installBodies).toEqual([{ languages: ["en_IN", "hi"], catalogVersion: 1 }]);

  const readsBeforeReload = api.persistedStatusReads;
  await page.reload();
  await expect(page.locator("#whatsapp").getByText("Lab Lords Utility catalogue v1")).toBeVisible();
  expect(api.persistedStatusReads).toBeGreaterThan(readsBeforeReload);
  expect(graphRequests).toEqual([]);
  await assertNoSeriousAxeViolations(page, "#whatsapp");
});

test("activates delivery prospectively with the exact charge confirmation and shows UNKNOWN history safely", async ({ page }) => {
  const graphRequests = await mockExternalScripts(page);
  await mockAccess(page, () => accessFixture());
  await mockBranchIdentity(page);
  const api = await mockBranchWhatsApp(page);

  await page.goto(`/branch/${BRANCH_ID}/settings#whatsapp`);
  const whatsApp = page.locator("#whatsapp");
  await expect(whatsApp.getByRole("heading", { name: "Activation checklist" })).toBeVisible();
  for (const label of [
    "Active sender assigned",
    "Managed templates installed",
    "Operational consent coverage",
    "Send time configured",
    "Reminder stages selected",
    "Branch delivery enabled",
    "Automation explicitly enabled",
  ]) {
    await expect(whatsApp.locator("li", { hasText: label })).toBeVisible();
  }

  await whatsApp.getByRole("button", { name: "Enable branch delivery" }).click();
  await expect.poll(() => api.deliveryPosts).toBe(1);
  await expect(whatsApp.getByRole("button", { name: "Disable branch delivery" })).toBeVisible();

  await expect(whatsApp.getByText(AUTOMATION_CONFIRMATION, { exact: true })).toBeVisible();
  const enableAutomation = whatsApp.getByRole("button", { name: "Enable prospective automation" });
  await expect(enableAutomation).toBeDisabled();
  await whatsApp.locator("label", { hasText: AUTOMATION_CONFIRMATION }).locator('input[type="checkbox"]').check();
  await expect(enableAutomation).toBeEnabled();
  await enableAutomation.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => api.automationPosts).toBe(1);
  expect(api.automationBodies).toEqual([{ confirmChargesAndProspectiveAutomation: true }]);
  await expect(whatsApp.getByRole("button", { name: "Disable automation" })).toBeVisible();
  await expect(
    whatsApp.locator("li", { hasText: "Automation explicitly enabled" })
  ).toContainText("Complete:");

  await expect(whatsApp.getByText("Unknown", { exact: true })).toBeVisible();
  const unknownWarning = whatsApp.getByRole("alert").filter({
    hasText: "Provider acceptance could not be confirmed.",
  });
  await expect(unknownWarning).toContainText(
    "Lab Lords will not retry automatically because that could send a duplicate message"
  );
  await expect(unknownWarning).toContainText("operator review is required");
  await expect(whatsApp.getByText("META_MUTATION_OUTCOME_UNKNOWN")).toBeVisible();
  expect(graphRequests).toEqual([]);
  await assertNoSeriousAxeViolations(page, "#whatsapp");
});

test("records individual and bounded bulk operational consent once per rapid action", async ({ page }) => {
  await mockAccess(page, () => accessFixture());
  await mockBranchIdentity(page);
  const api = await mockStudents(page);

  await page.goto(`/branch/${BRANCH_ID}/students`);
  await expect(page.getByRole("heading", { level: 1, name: "Students" })).toBeVisible();
  await page.getByRole("button", { name: "Actions" }).first().click();
  await page.getByRole("menuitem", { name: "WhatsApp consent" }).click();

  const individualDialog = page.getByRole("dialog", { name: "WhatsApp recipient and consent" });
  await expect(individualDialog).toBeVisible();
  await expect(individualDialog.getByText("••••••3210")).toBeVisible();
  await expect(individualDialog.getByText("Synthetic Study Hall · ••••••4321")).toBeVisible();
  await expect(individualDialog).not.toContainText("+919876543210");
  await expect(individualDialog.getByText(WHATSAPP_OPERATIONAL_CONSENT_STATEMENT, { exact: false })).toBeVisible();
  await individualDialog
    .locator("label", { hasText: `I attest to policy ${WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION}` })
    .locator('input[type="checkbox"]')
    .check();
  const recordIndividual = individualDialog.getByRole("button", { name: "Record operational consent" });
  await recordIndividual.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => api.individualPosts).toBe(1);
  expect(api.individualBodies).toEqual([{
    studentId: STUDENT_ONE_ID,
    relationship: "SELF",
    attestation: true,
  }]);
  await expect(individualDialog.getByText("Operational consent active")).toBeVisible();
  await expect(individualDialog.getByText(/In-person attestation ·/)).toBeVisible();
  await expect(individualDialog.getByText(`Policy: ${WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION}`)).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(individualDialog).toBeHidden();
  await page.getByRole("button", { name: "Bulk WhatsApp consent" }).click();
  const bulkDialog = page.getByRole("dialog", { name: "Bulk WhatsApp operational consent" });
  await expect(bulkDialog).toBeVisible();
  await expect(bulkDialog.getByText("A single request is capped at 100.", { exact: false })).toBeVisible();
  await bulkDialog.getByRole("button", { name: "Select loaded students" }).click();
  await expect(bulkDialog.getByText("Loaded students (2/100 selected)")).toBeVisible();
  await bulkDialog
    .locator("label", { hasText: `I attest for every selected student to policy ${WHATSAPP_OPERATIONAL_CONSENT_POLICY_VERSION}` })
    .locator('input[type="checkbox"]')
    .check();
  const recordBulk = bulkDialog.getByRole("button", { name: "Record consent for 2 selected" });
  await recordBulk.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => api.bulkPosts).toBe(1);
  expect(api.bulkBodies).toEqual([{
    recipients: [
      { studentId: STUDENT_ONE_ID, relationship: "GUARDIAN" },
      { studentId: STUDENT_TWO_ID, relationship: "GUARDIAN" },
    ],
    attestation: true,
  }]);
  await expect(bulkDialog.getByText("1 associated · 0 unchanged · 1 skipped")).toBeVisible();
  await expect(bulkDialog.getByText("Anaya Synthetic: No current student phone")).toBeVisible();
  await assertNoSeriousAxeViolations(page, '[role="dialog"]');
});

test("previews and confirms the fixed manual reminder once, with an idempotency key", async ({ page }) => {
  await mockAccess(page, () => accessFixture());
  await mockBranchIdentity(page);
  const api = await mockOverdueCollections(page);

  await page.goto(`/branch/${BRANCH_ID}/overdue`);
  await expect(page.getByRole("heading", { level: 1, name: "Overdue collections" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Aarav Synthetic's overdue payment" }).check();
  const preview = page.getByRole("button", { name: "Preview approved reminder (1)" });
  await preview.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => api.previewPosts).toBe(1);
  expect(api.previewBodies).toEqual([{ paymentIds: [PAYMENT_ID] }]);
  await expect(page.getByText("Namaste Aarav. Your ₹1,500 fee remains due.")).toBeVisible();
  await expect(page.getByText("Estimated Meta usage. Final charges are determined by Meta.")).toBeVisible();
  await page.locator("label", { hasText: MANUAL_QUEUE_CONFIRMATION }).locator('input[type="checkbox"]').check();

  const queue = page.getByRole("button", { name: "Confirm and queue 1 recipient group" });
  await queue.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect.poll(() => api.queuePosts).toBe(1);
  expect(api.queueBodies).toEqual([{ paymentIds: [PAYMENT_ID] }]);
  expect(api.queueIdempotencyKeys).toHaveLength(1);
  expect(api.queueIdempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(page.getByText("1 message queued. Delivery remains subject to send-time revalidation.")).toBeVisible();
  await expect(page.getByText("Queue request queued: 1 queued, 0 suppressed.")).toBeVisible();
  await assertNoSeriousAxeViolations(page, "main");
});

test.describe("Manager authenticated WhatsApp authorization", () => {
  test.use({ storageState: hasManagerSession ? managerAuthStatePath! : EMPTY_STATE });
  test.beforeEach(() => {
    test.skip(
      !hasManagerSession,
      "Set PLAYWRIGHT_MANAGER_AUTH_STATE and PLAYWRIGHT_MANAGER_BRANCH_ID to run manager authorization coverage."
    );
  });

test("keeps assignment owner-only and all consent or send mutations permission-gated", async ({ page }) => {
  let access = accessFixture({ isOwner: false, manageWhatsApp: true, sendWhatsApp: false });
  await mockAccess(page, () => access);
  await mockBranchIdentity(page);
  await mockBranchWhatsApp(page);
  await mockStudents(page);
  await mockOverdueCollections(page);
  const attemptedMutations: string[] = [];
  page.on("request", request => {
    if (request.url().includes("/whatsapp/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      attemptedMutations.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto(`/branch/${BRANCH_ID}/settings#whatsapp`);
  const whatsApp = page.locator("#whatsapp");
  await expect(whatsApp.getByRole("button", { name: "Assign sender" })).toHaveCount(0);
  await expect(whatsApp.getByRole("button", { name: "Unassign sender" })).toHaveCount(0);
  await expect(whatsApp.getByRole("button", { name: "Save WhatsApp settings" })).toBeEnabled();

  access = accessFixture({ isOwner: false, manageWhatsApp: false, sendWhatsApp: false });
  await page.goto(`/branch/${BRANCH_ID}/students`);
  await expect(page.getByRole("button", { name: "Bulk WhatsApp consent" })).toBeDisabled();
  await page.getByRole("button", { name: "Actions" }).first().click();
  await page.getByRole("menuitem", { name: "WhatsApp consent" }).click();
  const dialog = page.getByRole("dialog", { name: "WhatsApp recipient and consent" });
  await expect(dialog.getByText("You need WhatsApp management permission to change consent.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Record operational consent" })).toBeDisabled();

  await page.goto(`/branch/${BRANCH_ID}/overdue`);
  await page.getByRole("checkbox", { name: "Select Aarav Synthetic's overdue payment" }).check();
  await expect(page.getByText("Your role does not include this action.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview approved reminder (1)" })).toBeDisabled();
  expect(attemptedMutations).toEqual([]);
});
});
