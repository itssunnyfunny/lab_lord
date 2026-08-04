import { apiClient } from "./core";
import type {
  BillingEntitlement,
  BillingPlanId,
  CheckoutBillingPlanId,
} from "@/lib/billingPlans";
import type { BillingExperience } from "@/types/billingExperience";

export type BillingPlanDto = {
  id: CheckoutBillingPlanId;
  name: string;
  shortName: string;
  amount: number | null;
  currency: "INR";
  period: "monthly";
  interval: 1;
  active: boolean;
  featured: boolean;
  comingSoon: boolean;
  custom: boolean;
  description: string;
  features: string[];
  entitlements: BillingEntitlement[];
  limits: { maxBranches: number | null };
};

export type OrganizationSubscriptionDto = {
  id: string;
  organizationId: string;
  plan: BillingPlanId;
  planName: string;
  shortName: string;
  amount: number;
  amountSubunits: number;
  currency: string;
  period: string;
  interval: number;
  totalCount: number;
  quantity: number;
  unitAmount: number;
  monthlyTotal: number;
  status: string;
  razorpaySubscriptionId: string;
  currentStart: string | null;
  currentEnd: string | null;
  chargeAt: string | null;
  endedAt: string | null;
  providerStartAt: string | null;
  authorizationExpiresAt: string | null;
  providerPaymentMethod: string;
  paidThrough: string | null;
  cancelAtCycleEnd: boolean;
  cancellationRequestedAt: string | null;
  cancellationScheduledAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type OrganizationSubscriptionHistoryDto = {
  id: string;
  razorpaySubscriptionId: string;
  razorpayPaymentId: string | null;
  plan: BillingPlanId;
  fromStatus: string | null;
  toStatus: string;
  source: string;
  event: string | null;
  amountSubunits: number;
  currency: string;
  createdAt: string;
};

export type OrganizationEntitlementProfileDto = {
  organizationId: string;
  plan: BillingPlanId | null;
  effectivePlan: BillingPlanId;
  subscriptionStatus: string | null;
  fallbackAccess: boolean;
  entitlements: BillingEntitlement[];
  limits: { maxBranches: number | null };
  usage: { branches: number };
  accessMode: "FULL" | "WARNING" | "READ_ONLY";
  canWrite: boolean;
  accessReason: string;
  trial: { status: string; endsAt: string | null } | null;
};

export type BillingOverview = {
  experience: BillingExperience;
  plans: BillingPlanDto[];
  current: OrganizationSubscriptionDto | null;
  history: OrganizationSubscriptionHistoryDto[];
  entitlements: OrganizationEntitlementProfileDto;
  billingModelVersion: "LEGACY" | "WORKSPACE_V2";
  trial: {
    status: string;
    source: string;
    organizationId: string | null;
    startedAt: string | null;
    endsAt: string | null;
    claimable: boolean;
  } | null;
  projection: {
    plan: BillingPlanId;
    quantity: number;
    unitAmount: number;
    monthlyTotal: number;
    nextChargeAt: string | null;
    discountedTotal: number;
    discountedCycles: number;
    normalRenewalTotal: number;
  };
  paymentMethod: string | null;
  invoices: Array<{
    id: string;
    status: string;
    amountSubunits: number;
    currency: string;
    paidAt: string | null;
  }>;
  scheduledChanges: Array<{
    id: string;
    type: string;
    status: string;
    effectiveAt: string | null;
    undoCutoffAt: string | null;
    toPlan: BillingPlanId | null;
    toQuantity: number | null;
    lastError: string | null;
  }>;
};

export type BillingOperationDto = {
  id: string;
  organizationId: string;
  type: string;
  queueStatus: string;
  operationStatus: "CHECKOUT_OPEN" | "VERIFYING" | "AWAITING_PROVIDER_CONFIRMATION" | "APPLIED" | "DECLINED" | "ABANDONED" | "FAILED" | "SCHEDULED";
  returnPath: string | null;
  confirmationDeadlineAt: string | null;
  failureCategory: string | null;
  failureCode: string | null;
  message: string | null;
  effectiveAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type BillingCheckoutPayload = {
  changeId: string;
  processingUrl: string;
  keyId: string;
  type: "subscription";
  subscriptionId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  method: { card: true; upi: false; netbanking: false; wallet: false };
  plan: Pick<BillingPlanDto, "id" | "name" | "shortName" | "amount" | "currency" | "period">;
  prefill: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes: Record<string, string>;
  subscription: OrganizationSubscriptionDto;
  operation: BillingOperationDto;
};

export type BillingVerificationResult = {
  verified: true;
  operation: BillingOperationDto;
  processingUrl: string;
  subscription: OrganizationSubscriptionDto;
};

export type BillingCancellationResult = {
  cancelled: boolean;
  scheduled: boolean;
  subscription: OrganizationSubscriptionDto;
};

export const billing = {
  getOverview(orgId: string): Promise<BillingOverview> {
    return apiClient.get(`/organizations/${orgId}/billing`);
  },

  createSubscription(orgId: string, plan: CheckoutBillingPlanId, returnPath?: string): Promise<BillingCheckoutPayload> {
    return apiClient.post(`/organizations/${orgId}/billing/subscription`, { plan, returnPath });
  },

  verifySubscription(
    orgId: string,
    payload: {
      razorpay_subscription_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
      changeId: string;
    }
  ): Promise<BillingVerificationResult> {
    return apiClient.post(`/organizations/${orgId}/billing/subscription/verify`, payload);
  },

  cancelSubscription(orgId: string): Promise<BillingCancellationResult> {
    return apiClient.post(`/organizations/${orgId}/billing/subscription/cancel`, null, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  },

  undoCancellation(orgId: string): Promise<{ undone: true }> {
    return apiClient.delete(`/organizations/${orgId}/billing/subscription/cancel`);
  },

  claimTrial(orgId: string) {
    return apiClient.post(`/organizations/${orgId}/billing/trial/claim`);
  },

  changePlan(orgId: string, plan: CheckoutBillingPlanId, returnPath?: string) {
    return apiClient.patch(`/organizations/${orgId}/billing/subscription`, { plan, returnPath }, {
      headers: { "Idempotency-Key": crypto.randomUUID() },
    });
  },

  undoChange(orgId: string, changeId: string) {
    return apiClient.delete(`/organizations/${orgId}/billing/mutations/${changeId}`);
  },

  getOperation(orgId: string, changeId: string): Promise<{ operation: BillingOperationDto; processingUrl: string }> {
    return apiClient.get(`/organizations/${orgId}/billing/mutations/${changeId}`);
  },

  reconcileOperation(orgId: string, changeId: string, paymentId?: string) {
    return apiClient.post(`/organizations/${orgId}/billing/mutations/${changeId}`, { paymentId });
  },

  retryOperation(orgId: string, changeId: string) {
    return apiClient.post(`/organizations/${orgId}/billing/mutations/${changeId}/retry`);
  },

  recordCheckoutEvent(
    orgId: string,
    changeId: string,
    event: "ABANDONED" | "DECLINED",
    details?: { failureCategory?: string; failureCode?: string }
  ) {
    return apiClient.post(`/organizations/${orgId}/billing/mutations/${changeId}/checkout-event`, { event, ...details });
  },
};
