import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrganizationAccessNotFoundError } from "@/lib/organizationErrors";
import { RazorpayConfigurationError } from "@/lib/razorpay";
import { POST as createBranch } from "@/app/api/branches/route";
import { GET as getOrganization, PATCH as patchOrganization } from "@/app/api/organizations/[orgId]/route";
import { GET as getOrganizationBranches, POST as createOrganizationBranch } from "@/app/api/organizations/[orgId]/branches/route";
import { GET as getBilling } from "@/app/api/organizations/[orgId]/billing/route";
import { GET as getInvoices } from "@/app/api/organizations/[orgId]/billing/invoices/route";
import { POST as createSubscription, PATCH as changeSubscription } from "@/app/api/organizations/[orgId]/billing/subscription/route";
import { POST as verifySubscription } from "@/app/api/organizations/[orgId]/billing/subscription/verify/route";
import { POST as cancelSubscription, DELETE as undoCancellation } from "@/app/api/organizations/[orgId]/billing/subscription/cancel/route";
import { POST as replacePaymentMethod } from "@/app/api/organizations/[orgId]/billing/subscription/payment-method/route";
import { POST as recoverSubscription } from "@/app/api/organizations/[orgId]/billing/subscription/recovery/route";
import { GET as getMutation, POST as reconcileMutation, DELETE as undoMutation } from "@/app/api/organizations/[orgId]/billing/mutations/[changeId]/route";
import { POST as recordCheckoutEvent } from "@/app/api/organizations/[orgId]/billing/mutations/[changeId]/checkout-event/route";
import { POST as retryMutation } from "@/app/api/organizations/[orgId]/billing/mutations/[changeId]/retry/route";
import { POST as claimTrial } from "@/app/api/organizations/[orgId]/billing/trial/claim/route";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  getOrganizationForOwnerAccess: vi.fn(),
  updateSettings: vi.fn(),
  getBranchesByOrganizationId: vi.fn(),
  createBranchForOrg: vi.fn(),
  listPlansForOrganization: vi.fn(),
  createSubscriptionCheckout: vi.fn(),
  changeWorkspacePlan: vi.fn(),
  verifySubscriptionSuccess: vi.fn(),
  requestCancellation: vi.fn(),
  undoWorkspaceCancellation: vi.fn(),
  createPaymentMethodReplacement: vi.fn(),
  getRecoveryCheckout: vi.fn(),
  getBillingOperation: vi.fn(),
  reconcileMutation: vi.fn(),
  undoWorkspaceChange: vi.fn(),
  recordCheckoutEvent: vi.fn(),
  retryBillingOperation: vi.fn(),
  claimMigratedTrial: vi.fn(),
  findInvoices: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ getSessionUser: mocks.getSessionUser }));

vi.mock("@/services/organization.service", () => ({
  OrganizationService: {
    getOrganizationForOwnerAccess: mocks.getOrganizationForOwnerAccess,
    updateSettings: mocks.updateSettings,
  },
}));

vi.mock("@/services/branch.service", () => ({
  BranchService: {
    getBranchesByOrganizationId: mocks.getBranchesByOrganizationId,
    createBranchForOrg: mocks.createBranchForOrg,
  },
}));

vi.mock("@/services/billing.service", () => ({
  BillingService: {
    listPlansForOrganization: mocks.listPlansForOrganization,
    createSubscriptionCheckout: mocks.createSubscriptionCheckout,
    changeWorkspacePlan: mocks.changeWorkspacePlan,
    verifySubscriptionSuccess: mocks.verifySubscriptionSuccess,
    requestCancellation: mocks.requestCancellation,
    undoWorkspaceCancellation: mocks.undoWorkspaceCancellation,
    createPaymentMethodReplacement: mocks.createPaymentMethodReplacement,
    getRecoveryCheckout: mocks.getRecoveryCheckout,
    getBillingOperation: mocks.getBillingOperation,
    reconcileMutation: mocks.reconcileMutation,
    undoWorkspaceChange: mocks.undoWorkspaceChange,
    recordCheckoutEvent: mocks.recordCheckoutEvent,
    retryBillingOperation: mocks.retryBillingOperation,
  },
}));

vi.mock("@/services/ownerTrial.service", () => ({
  OwnerTrialService: { claimMigratedTrial: mocks.claimMigratedTrial },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    organizationSubscriptionInvoice: { findMany: mocks.findInvoices },
  },
}));

type OrgContext = { params: Promise<{ orgId: string }> };
type MutationContext = { params: Promise<{ orgId: string; changeId: string }> };

function orgContext(orgId: string): OrgContext {
  return { params: Promise.resolve({ orgId }) };
}

function mutationContext(orgId: string): MutationContext {
  return { params: Promise.resolve({ orgId, changeId: "change_unknown" }) };
}

function request(path: string, method = "GET", body?: unknown, idempotent = false) {
  return new Request(`http://test.local${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotent ? { "idempotency-key": "access-parity" } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const routeCases: Array<{
  name: string;
  invoke: (organizationId: string) => Promise<Response>;
}> = [
  {
    name: "legacy branch POST",
    invoke: orgId => createBranch(
      request("/api/branches", "POST", {
        organizationId: orgId,
        name: "Branch",
        contactPhone: "9876543210",
        seatCount: 1,
      }, true)
    ),
  },
  {
    name: "organization GET",
    invoke: orgId => getOrganization(
      request(`/api/organizations/${orgId}`) as never,
      orgContext(orgId)
    ),
  },
  {
    name: "organization PATCH",
    invoke: orgId => patchOrganization(
      request(`/api/organizations/${orgId}`, "PATCH", { name: "Updated" }) as never,
      orgContext(orgId)
    ),
  },
  {
    name: "organization branches GET",
    invoke: orgId => getOrganizationBranches(
      request(`/api/organizations/${orgId}/branches`),
      orgContext(orgId)
    ),
  },
  {
    name: "organization branches POST",
    invoke: orgId => createOrganizationBranch(
      request(`/api/organizations/${orgId}/branches`, "POST", {
        name: "Branch",
        contactPhone: "9876543210",
      }, true),
      orgContext(orgId)
    ),
  },
  {
    name: "billing GET",
    invoke: orgId => getBilling(
      request(`/api/organizations/${orgId}/billing`) as never,
      orgContext(orgId)
    ),
  },
  {
    name: "invoice GET",
    invoke: orgId => getInvoices(
      request(`/api/organizations/${orgId}/billing/invoices`),
      orgContext(orgId)
    ),
  },
  {
    name: "subscription POST",
    invoke: orgId => createSubscription(
      request(`/api/organizations/${orgId}/billing/subscription`, "POST", { plan: "BASIC" }) as never,
      orgContext(orgId)
    ),
  },
  {
    name: "subscription PATCH",
    invoke: orgId => changeSubscription(
      request(`/api/organizations/${orgId}/billing/subscription`, "PATCH", { plan: "PRO" }, true) as never,
      orgContext(orgId)
    ),
  },
  {
    name: "subscription verify POST",
    invoke: orgId => verifySubscription(
      request(`/api/organizations/${orgId}/billing/subscription/verify`, "POST", {}) as never,
      orgContext(orgId)
    ),
  },
  {
    name: "subscription cancel POST",
    invoke: orgId => cancelSubscription(
      request(`/api/organizations/${orgId}/billing/subscription/cancel`, "POST", undefined, true),
      orgContext(orgId)
    ),
  },
  {
    name: "subscription cancel DELETE",
    invoke: orgId => undoCancellation(
      request(`/api/organizations/${orgId}/billing/subscription/cancel`, "DELETE"),
      orgContext(orgId)
    ),
  },
  {
    name: "payment-method POST",
    invoke: orgId => replacePaymentMethod(
      request(`/api/organizations/${orgId}/billing/subscription/payment-method`, "POST", {}, true),
      orgContext(orgId)
    ),
  },
  {
    name: "recovery POST",
    invoke: orgId => recoverSubscription(
      request(`/api/organizations/${orgId}/billing/subscription/recovery`, "POST", {}),
      orgContext(orgId)
    ),
  },
  {
    name: "billing mutation GET",
    invoke: orgId => getMutation(
      request(`/api/organizations/${orgId}/billing/mutations/change_unknown`),
      mutationContext(orgId)
    ),
  },
  {
    name: "billing mutation POST",
    invoke: orgId => reconcileMutation(
      request(`/api/organizations/${orgId}/billing/mutations/change_unknown`, "POST", {}),
      mutationContext(orgId)
    ),
  },
  {
    name: "billing mutation DELETE",
    invoke: orgId => undoMutation(
      request(`/api/organizations/${orgId}/billing/mutations/change_unknown`, "DELETE"),
      mutationContext(orgId)
    ),
  },
  {
    name: "checkout-event POST",
    invoke: orgId => recordCheckoutEvent(
      request(`/api/organizations/${orgId}/billing/mutations/change_unknown/checkout-event`, "POST", {
        event: "ABANDONED",
      }),
      mutationContext(orgId)
    ),
  },
  {
    name: "billing mutation retry POST",
    invoke: orgId => retryMutation(
      request(`/api/organizations/${orgId}/billing/mutations/change_unknown/retry`, "POST"),
      mutationContext(orgId)
    ),
  },
  {
    name: "trial claim POST",
    invoke: orgId => claimTrial(
      request(`/api/organizations/${orgId}/billing/trial/claim`, "POST"),
      orgContext(orgId)
    ),
  },
];

describe("organization owner-access response parity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: "owner_requesting" });
    const rejectAccess = () => Promise.reject(new OrganizationAccessNotFoundError());
    [
      mocks.getOrganizationForOwnerAccess,
      mocks.updateSettings,
      mocks.listPlansForOrganization,
      mocks.createSubscriptionCheckout,
      mocks.changeWorkspacePlan,
      mocks.verifySubscriptionSuccess,
      mocks.requestCancellation,
      mocks.undoWorkspaceCancellation,
      mocks.createPaymentMethodReplacement,
      mocks.getRecoveryCheckout,
      mocks.getBillingOperation,
      mocks.reconcileMutation,
      mocks.undoWorkspaceChange,
      mocks.recordCheckoutEvent,
      mocks.retryBillingOperation,
      mocks.claimMigratedTrial,
    ].forEach(mock => mock.mockImplementation(rejectAccess));
  });

  it.each(routeCases)("returns the same generic 404 for foreign and missing IDs: $name", async ({ invoke }) => {
    const [foreignResponse, missingResponse] = await Promise.all([
      invoke("org_foreign"),
      invoke("org_missing"),
    ]);

    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(await foreignResponse.json()).toEqual({ error: "Organization not found" });
    expect(await missingResponse.json()).toEqual({ error: "Organization not found" });
  });

  it.each([
    {
      name: "legacy branch POST",
      invoke: () => createBranch(
        request("/api/branches", "POST", {
          organizationId: "org_owned",
          name: "Branch",
          contactPhone: "9876543210",
          seatCount: 1,
        }, true)
      ),
    },
    {
      name: "organization branch POST",
      invoke: () => createOrganizationBranch(
        request("/api/organizations/org_owned/branches", "POST", {
          name: "Branch",
          contactPhone: "9876543210",
        }, true),
        orgContext("org_owned")
      ),
    },
  ])("maps a provider-mode mismatch to 503: $name", async ({ invoke }) => {
    mocks.getOrganizationForOwnerAccess.mockResolvedValue({ id: "org_owned" });
    mocks.createBranchForOrg.mockRejectedValue(
      new RazorpayConfigurationError("Subscription provider mode does not match current Razorpay credentials")
    );

    const response = await invoke();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Subscription provider mode does not match current Razorpay credentials",
    });
  });
});
