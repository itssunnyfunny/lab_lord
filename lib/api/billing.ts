import { apiClient } from "./core";
import type { BillingEntitlement, BillingPlanId } from "@/lib/billingPlans";

export type BillingPlanDto = {
  id: BillingPlanId;
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
  status: string;
  razorpaySubscriptionId: string;
  currentStart: string | null;
  currentEnd: string | null;
  chargeAt: string | null;
  endedAt: string | null;
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
  subscriptionStatus: string | null;
  grandfathered: boolean;
  entitlements: BillingEntitlement[];
  limits: { maxBranches: number | null };
  usage: { branches: number };
};

export type BillingOverview = {
  plans: BillingPlanDto[];
  current: OrganizationSubscriptionDto | null;
  history: OrganizationSubscriptionHistoryDto[];
  entitlements: OrganizationEntitlementProfileDto;
};

export type BillingCheckoutPayload = {
  keyId: string;
  type: "subscription";
  subscriptionId: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  plan: Pick<BillingPlanDto, "id" | "name" | "shortName" | "amount" | "currency" | "period">;
  prefill: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes: Record<string, string>;
  subscription: OrganizationSubscriptionDto;
};

export type BillingVerificationResult = {
  verified: true;
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

  createSubscription(orgId: string, plan: BillingPlanId): Promise<BillingCheckoutPayload> {
    return apiClient.post(`/organizations/${orgId}/billing/subscription`, { plan });
  },

  verifySubscription(
    orgId: string,
    payload: {
      razorpay_subscription_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
    }
  ): Promise<BillingVerificationResult> {
    return apiClient.post(`/organizations/${orgId}/billing/subscription/verify`, payload);
  },

  cancelSubscription(orgId: string, cancelAtCycleEnd: boolean): Promise<BillingCancellationResult> {
    return apiClient.post(`/organizations/${orgId}/billing/subscription/cancel`, { cancelAtCycleEnd });
  },
};
