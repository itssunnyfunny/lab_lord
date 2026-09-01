import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
} from "@/lib/billingErrors";
import { POST as createBranch } from "@/app/api/branches/route";
import { POST as createOrganizationBranch } from "@/app/api/organizations/[orgId]/branches/route";
import {
  PATCH as changePlan,
  POST as createSubscription,
} from "@/app/api/organizations/[orgId]/billing/subscription/route";
import { POST as changePaymentMethod } from "@/app/api/organizations/[orgId]/billing/subscription/payment-method/route";
import { POST as reconcileMutation } from "@/app/api/organizations/[orgId]/billing/mutations/[changeId]/route";
import { POST as scheduleBranchRemoval } from "@/app/api/branches/[branchId]/billing-removal/route";
import { POST as reactivateBranch } from "@/app/api/branches/[branchId]/billing/reactivate/route";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  isOwner: vi.fn(),
  createBranchForOrg: vi.fn(),
  scheduleBillingRemoval: vi.fn(),
  reactivateArchivedBranch: vi.fn(),
  changeWorkspacePlan: vi.fn(),
  createSubscriptionCheckout: vi.fn(),
  createPaymentMethodReplacement: vi.fn(),
  getBillingOperation: vi.fn(),
  reconcileMutation: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSessionUser: mocks.getSessionUser,
}));

vi.mock("@/services/organization.service", () => ({
  OrganizationService: {
    isOwner: mocks.isOwner,
  },
}));

vi.mock("@/services/branch.service", () => ({
  BranchService: {
    createBranchForOrg: mocks.createBranchForOrg,
    scheduleBillingRemoval: mocks.scheduleBillingRemoval,
    reactivateArchivedBranch: mocks.reactivateArchivedBranch,
  },
}));

vi.mock("@/services/billing.service", () => ({
  BillingService: {
    changeWorkspacePlan: mocks.changeWorkspacePlan,
    createSubscriptionCheckout: mocks.createSubscriptionCheckout,
    createPaymentMethodReplacement: mocks.createPaymentMethodReplacement,
    getBillingOperation: mocks.getBillingOperation,
    reconcileMutation: mocks.reconcileMutation,
  },
}));

const conflictBody = {
  error: "Another billable change is already awaiting authorization or cutover",
  code: "BILLING_CHANGE_IN_PROGRESS",
  existingChangeId: "change_existing",
};

function conflict() {
  return new BillingChangeInProgressError("change_existing");
}

function request(
  path: string,
  body: Record<string, unknown>,
  method: "POST" | "PATCH" = "POST"
) {
  return new NextRequest(`http://test.local${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": "billing-change-1",
    },
    body: JSON.stringify(body),
  });
}

async function expectConflict(response: Response) {
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual(conflictBody);
}

describe("billable-change route conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "owner_1", email: "owner@test.com" });
    mocks.isOwner.mockResolvedValue(true);
  });

  it("returns a structured 409 for an initial subscription conflict", async () => {
    mocks.createSubscriptionCheckout.mockRejectedValueOnce(conflict());

    await expectConflict(await createSubscription(
      request("/api/organizations/org_1/billing/subscription", { plan: "PRO" }),
      { params: Promise.resolve({ orgId: "org_1" }) }
    ));
  });

  it("returns an owner-actionable 409 when initial provisioning remains ambiguous", async () => {
    mocks.createSubscriptionCheckout.mockRejectedValueOnce(
      new BillingManualReviewRequiredError("change_provisioning")
    );

    const response = await createSubscription(
      request("/api/organizations/org_1/billing/subscription", { plan: "PRO" }),
      { params: Promise.resolve({ orgId: "org_1" }) }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Provider evidence remains ambiguous; manual billing review is still required",
      code: "BILLING_MANUAL_REVIEW_REQUIRED",
      changeId: "change_provisioning",
      resolutionOutcome: "MANUAL_REVIEW_RETAINED",
    });
  });

  it("keeps read-only provisioning reconciliation in manual review with a typed 409", async () => {
    mocks.reconcileMutation.mockRejectedValueOnce(
      new BillingManualReviewRequiredError("change_provisioning")
    );

    const response = await reconcileMutation(
      request("/api/organizations/org_1/billing/mutations/change_provisioning", {}),
      { params: Promise.resolve({ orgId: "org_1", changeId: "change_provisioning" }) }
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Provider evidence remains ambiguous; manual billing review is still required",
      code: "BILLING_MANUAL_REVIEW_REQUIRED",
      changeId: "change_provisioning",
      resolutionOutcome: "MANUAL_REVIEW_RETAINED",
    });
  });

  it("returns a structured 409 for a plan-change conflict", async () => {
    mocks.changeWorkspacePlan.mockRejectedValueOnce(conflict());

    await expectConflict(await changePlan(
      request("/api/organizations/org_1/billing/subscription", { plan: "PRO" }, "PATCH"),
      { params: Promise.resolve({ orgId: "org_1" }) }
    ));
  });

  it("returns a structured 409 for a payment-method conflict", async () => {
    mocks.createPaymentMethodReplacement.mockRejectedValueOnce(conflict());

    await expectConflict(await changePaymentMethod(
      request("/api/organizations/org_1/billing/subscription/payment-method", {}),
      { params: Promise.resolve({ orgId: "org_1" }) }
    ));
  });

  it("returns a structured 409 for a top-level branch-creation conflict", async () => {
    mocks.createBranchForOrg.mockRejectedValueOnce(conflict());

    await expectConflict(await createBranch(request("/api/branches", {
      organizationId: "org_1",
      name: "Second Branch",
      contactPhone: "9876543210",
      seatCount: 10,
    })));
  });

  it("returns a structured 409 for an organization branch-creation conflict", async () => {
    mocks.createBranchForOrg.mockRejectedValueOnce(conflict());

    await expectConflict(await createOrganizationBranch(
      request("/api/organizations/org_1/branches", {
        name: "Second Branch",
        contactPhone: "9876543210",
      }),
      { params: Promise.resolve({ orgId: "org_1" }) }
    ));
  });

  it("returns a structured 409 for a branch-removal conflict", async () => {
    mocks.scheduleBillingRemoval.mockRejectedValueOnce(conflict());

    await expectConflict(await scheduleBranchRemoval(
      request("/api/branches/branch_1/billing-removal", {}),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    ));
  });

  it("returns a structured 409 for a branch-reactivation conflict", async () => {
    mocks.reactivateArchivedBranch.mockRejectedValueOnce(conflict());

    await expectConflict(await reactivateBranch(
      request("/api/branches/branch_1/billing/reactivate", {}),
      { params: Promise.resolve({ branchId: "branch_1" }) }
    ));
  });
});
