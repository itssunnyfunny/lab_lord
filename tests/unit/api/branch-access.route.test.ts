import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BillingExperience, BranchAccess, StaffAction } from "@/types";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getBranchAccess: vi.fn(),
  getForBranch: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/services/staff.service", () => ({
  StaffService: { getBranchAccess: mocks.getBranchAccess },
}));
vi.mock("@/services/billingExperience.service", () => ({
  BillingExperienceService: { getForBranch: mocks.getForBranch },
}));

const permissions = Object.fromEntries([
  "manage_org",
  "manage_branch",
  "students",
  "seat_allocation",
  "view_payments",
  "generate_payments",
  "mark_payment_paid",
  "waive_payments",
  "analytics",
  "staff_management",
].map(action => [action, true])) as Record<StaffAction, boolean>;

const fullExperience: BillingExperience = {
  organizationId: "org_1",
  accessMode: "FULL",
  effectivePlan: "STANDARD",
  selectedPostTrialPlan: "STANDARD",
  providerStatus: "ACTIVE",
  customerState: "CONFIRMING",
  customerMessage: "Your payment is being confirmed.",
  trialEndsAt: "2026-09-01T00:00:00.000Z",
  trialDaysRemaining: 18,
  paidThrough: "2026-10-01T00:00:00.000Z",
  confirmedQuantity: 2,
  projectedQuantity: 3,
  currentUnitAmount: 499,
  currentMonthlyTotal: 998,
  projectedUnitAmount: 499,
  projectedMonthlyTotal: 1497,
  authorizationStatus: "VERIFYING",
  planFeeDueToday: 499,
  nextChargeAt: "2026-10-01T00:00:00.000Z",
  paymentAction: "WAIT_FOR_CONFIRMATION",
  entitlements: ["AI_ACCESS"],
  latestOperation: {
    id: "change_1",
    type: "QUANTITY_INCREASE",
    status: "AWAITING_PROVIDER_CONFIRMATION",
    returnPath: "/org/org_1/settings",
    confirmationDeadlineAt: null,
    effectiveAt: null,
    failureCategory: null,
    failureCode: null,
    providerPaymentId: "pay_private",
    branchId: "branch_1",
    toPlan: "STANDARD",
    toQuantity: 3,
    lastError: "private provider detail",
  },
  activeOperation: {
    id: "change_1",
    type: "QUANTITY_INCREASE",
    status: "AWAITING_PROVIDER_CONFIRMATION",
    returnPath: "/org/org_1/settings",
    confirmationDeadlineAt: null,
    effectiveAt: null,
    failureCategory: null,
    failureCode: null,
    providerPaymentId: "pay_private",
    branchId: "branch_1",
    toPlan: "STANDARD",
    toQuantity: 3,
    lastError: "private provider detail",
  },
  scheduledChanges: [],
  branch: { id: "branch_1", name: "Main Branch", billingStatus: "ACTIVE" },
  viewer: { isOwner: false, canManageBilling: false },
};

function access(isOwner: boolean): BranchAccess {
  return {
    branchId: "branch_1",
    branchName: "Main Branch",
    organizationId: "org_1",
    isOwner,
    role: isOwner ? "OWNER" : "STAFF",
    permissions,
    effectivePlan: "PRO",
    entitlements: ["AI_ACCESS"],
  };
}

describe("GET /api/branches/[branchId]/access billing projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "user_1", email: "user@example.com" });
    mocks.getForBranch.mockResolvedValue(fullExperience);
  });

  it("returns only minimal branch billing state to staff", async () => {
    mocks.getBranchAccess.mockResolvedValue(access(false));
    const { GET } = await import("@/app/api/branches/[branchId]/access/route");

    const response = await GET(new Request("http://test.local") as never, {
      params: Promise.resolve({ branchId: "branch_1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.billingExperience).toEqual({
      organizationId: "org_1",
      accessMode: "FULL",
      effectivePlan: "STANDARD",
      customerState: "CONFIRMING",
      customerMessage: "Your payment is being confirmed.",
      trialEndsAt: "2026-09-01T00:00:00.000Z",
      entitlements: ["AI_ACCESS"],
      hasActiveOperation: true,
      branch: { id: "branch_1", billingStatus: "ACTIVE" },
      viewer: { isOwner: false, canManageBilling: false },
    });
    expect(body.billingExperience).not.toHaveProperty("providerStatus");
    expect(body.billingExperience).not.toHaveProperty("currentUnitAmount");
    expect(body.billingExperience).not.toHaveProperty("latestOperation");
    expect(body.billingExperience).not.toHaveProperty("activeOperation");
    expect(body.billingExperience).not.toHaveProperty("scheduledChanges");
  });

  it("preserves the full billing experience for the organization owner", async () => {
    mocks.getBranchAccess.mockResolvedValue(access(true));
    mocks.getForBranch.mockResolvedValue({
      ...fullExperience,
      viewer: { isOwner: true, canManageBilling: true },
    });
    const { GET } = await import("@/app/api/branches/[branchId]/access/route");

    const response = await GET(new Request("http://test.local") as never, {
      params: Promise.resolve({ branchId: "branch_1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.billingExperience).toMatchObject({
      providerStatus: "ACTIVE",
      currentUnitAmount: 499,
      activeOperation: { id: "change_1", providerPaymentId: "pay_private" },
      viewer: { isOwner: true, canManageBilling: true },
    });
  });
});
