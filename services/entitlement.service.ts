import { prisma } from "@/lib/prisma";
import {
  getBillingPlan,
  type BillingEntitlement,
  type BillingPlanId,
} from "@/lib/billingPlans";
import type { Prisma } from "@/app/generated/prisma/client";
import { deriveWorkspaceBillingState, type BillingAccessMode } from "@/lib/billingState";
import { resolveRazorpayMode } from "@/lib/razorpay";
import { deriveAuthorizedReplacementOverride } from "@/services/billingReplacement.service";
import {
  BILLING_PAID_EVIDENCE_INCLUDE,
  resolveTrustedPaidThrough,
} from "@/services/billingPaidEvidence.service";

export class SubscriptionEntitlementError extends Error {
  readonly code = "SUBSCRIPTION_UPGRADE_REQUIRED";

  constructor(message: string) {
    super(`Unauthorized: ${message}`);
    this.name = "SubscriptionEntitlementError";
  }
}

export class BillingReadOnlyError extends Error {
  readonly code = "BILLING_READ_ONLY";

  constructor(message: string) {
    super(`Unauthorized: ${message}`);
    this.name = "BillingReadOnlyError";
  }
}

export type OrganizationEntitlementProfile = {
  organizationId: string;
  plan: BillingPlanId | null;
  effectivePlan: BillingPlanId;
  subscriptionStatus: string | null;
  fallbackAccess: boolean;
  entitlements: BillingEntitlement[];
  limits: { maxBranches: number | null };
  usage: { branches: number };
  accessMode: BillingAccessMode;
  canWrite: boolean;
  accessReason: string;
  trial: { status: string; endsAt: Date | null } | null;
};

export class EntitlementService {
  static async getOrganizationProfile(
    organizationId: string,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ): Promise<OrganizationEntitlementProfile> {
    const organization = await client.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        billingModelVersion: true,
        subscription: { include: BILLING_PAID_EVIDENCE_INCLUDE },
        pendingSubscriptionReplacement: {
          select: {
            id: true,
            providerMode: true,
            plan: true,
            quantity: true,
            status: true,
            providerPaymentMethod: true,
            replacementBillingChange: {
              select: {
                type: true,
                status: true,
                failureCategory: true,
                organizationSubscriptionId: true,
                replacementSubscriptionId: true,
                effectiveAt: true,
                accessGrantedAt: true,
                accessRevokedAt: true,
                accessGraceEndsAt: true,
              },
            },
          },
        },
        ownerTrialGrant: {
          select: { status: true, trialEndsAt: true },
        },
        _count: {
          select: {
            branches: { where: { billingStatus: { not: "ARCHIVED" } } },
          },
        },
      },
    });
    if (!organization) throw new Error("Organization not found");
    const now = new Date();
    const subscription = organization.subscription
      && organization.subscription.providerMode === resolveRazorpayMode()
      ? organization.subscription
      : null;
    const pendingReplacement = organization.pendingSubscriptionReplacement
      && organization.pendingSubscriptionReplacement.providerMode === resolveRazorpayMode()
      ? organization.pendingSubscriptionReplacement
      : null;
    const replacementChange = pendingReplacement?.replacementBillingChange;
    const replacementOverride = subscription && pendingReplacement && replacementChange
      ? deriveAuthorizedReplacementOverride({
          changeType: replacementChange.type,
          changeStatus: replacementChange.status,
          failureCategory: replacementChange.failureCategory,
          sourceSubscriptionId: subscription.id,
          changeSourceSubscriptionId: replacementChange.organizationSubscriptionId,
          candidateSubscriptionId: pendingReplacement.id,
          changeCandidateSubscriptionId: replacementChange.replacementSubscriptionId,
          sourcePlan: subscription.plan,
          sourceQuantity: subscription.quantity,
          candidatePlan: pendingReplacement.plan,
          candidateQuantity: pendingReplacement.quantity,
          candidateStatus: pendingReplacement.status,
          candidatePaymentMethod: pendingReplacement.providerPaymentMethod,
          accessGrantedAt: replacementChange.accessGrantedAt,
          accessRevokedAt: replacementChange.accessRevokedAt,
          effectiveAt: replacementChange.effectiveAt,
          accessGraceEndsAt: replacementChange.accessGraceEndsAt,
          now,
        })
      : null;
    const authorizedReplacement = replacementOverride
      && getBillingPlan(replacementOverride.plan as BillingPlanId)
      ? { ...replacementOverride, plan: replacementOverride.plan as BillingPlanId }
      : null;
    const trustedPaidThrough = resolveTrustedPaidThrough(subscription, now);

    if (organization.billingModelVersion === "WORKSPACE_V2") {
      const state = deriveWorkspaceBillingState({
        now,
        trial: organization.ownerTrialGrant
          ? {
              status: organization.ownerTrialGrant.status,
              endsAt: organization.ownerTrialGrant.trialEndsAt,
            }
          : null,
        subscription: subscription
          ? {
              status: subscription.status,
              plan: subscription.plan as BillingPlanId,
              paidThrough: trustedPaidThrough,
            }
          : null,
        authorizedReplacement,
      });
      const entitledPlanId = state.source === "NONE"
        ? "BASIC"
        : state.effectivePlan ?? "BASIC";
      const selectedPlan = getBillingPlan(entitledPlanId);
      if (!selectedPlan) throw new Error("Subscription plan configuration is missing");

      return {
        organizationId,
        plan: subscription?.plan as BillingPlanId | undefined ?? null,
        effectivePlan: selectedPlan.id,
        subscriptionStatus: subscription?.status ?? null,
        fallbackAccess: state.source === "NONE",
        entitlements: [...selectedPlan.entitlements],
        limits: { maxBranches: null },
        usage: { branches: organization._count.branches },
        accessMode: state.accessMode,
        canWrite: state.canWrite,
        accessReason: state.reason,
        trial: organization.ownerTrialGrant
          ? {
              status: organization.ownerTrialGrant.status,
              endsAt: organization.ownerTrialGrant.trialEndsAt,
            }
          : null,
      };
    }

    if (!subscription) {
      const basicPlan = getBillingPlan("BASIC");
      if (!basicPlan) throw new Error("Basic subscription plan configuration is missing");
      return {
        organizationId,
        plan: null,
        effectivePlan: "BASIC",
        subscriptionStatus: null,
        fallbackAccess: true,
        entitlements: [...basicPlan.entitlements],
        limits: { ...basicPlan.limits },
        usage: { branches: organization._count.branches },
        accessMode: "FULL",
        canWrite: true,
        accessReason: "Legacy Basic fallback access",
        trial: null,
      };
    }

    const selectedPlan = getBillingPlan(subscription.plan);
    const entitledPlan = trustedPaidThrough ? selectedPlan : getBillingPlan("BASIC");
    if (!entitledPlan) throw new Error("Subscription plan configuration is missing");

    return {
      organizationId,
      plan: subscription.plan as BillingPlanId,
      effectivePlan: entitledPlan.id,
      subscriptionStatus: subscription.status,
      fallbackAccess: entitledPlan.id !== selectedPlan?.id,
      entitlements: [...entitledPlan.entitlements],
      limits: { ...entitledPlan.limits },
      usage: { branches: organization._count.branches },
      accessMode: "FULL",
      canWrite: true,
      accessReason: trustedPaidThrough
        ? "Provider-confirmed legacy paid period is active"
        : "Legacy Basic fallback; paid settlement evidence is unavailable",
      trial: null,
    };
  }

  static async assertOrganizationEntitlement(
    organizationId: string,
    entitlement: BillingEntitlement,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ) {
    const profile = await this.getOrganizationProfile(organizationId, client);
    if (!profile.entitlements.includes(entitlement)) {
      throw new SubscriptionEntitlementError(
        `${entitlement.replaceAll("_", " ").toLowerCase()} requires an upgraded subscription plan`
      );
    }
    return profile;
  }

  static async assertBranchEntitlement(
    branchId: string,
    entitlement: BillingEntitlement,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ) {
    const branch = await client.branch.findUnique({
      where: { id: branchId },
      select: { organizationId: true },
    });
    if (!branch) throw new Error("Branch not found");
    return this.assertOrganizationEntitlement(branch.organizationId, entitlement, client);
  }

  static async assertCanCreateBranch(
    organizationId: string,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ) {
    const profile = await this.getOrganizationProfile(organizationId, client);
    if (!profile.canWrite) {
      throw new BillingReadOnlyError(profile.accessReason);
    }
    const maxBranches = profile.limits.maxBranches;
    if (maxBranches !== null && profile.usage.branches >= maxBranches) {
      throw new SubscriptionEntitlementError(
        `Your current subscription supports up to ${maxBranches} ${maxBranches === 1 ? "branch" : "branches"}`
      );
    }
    return profile;
  }

  static async assertOrganizationWritable(
    organizationId: string,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ) {
    const profile = await this.getOrganizationProfile(organizationId, client);
    if (!profile.canWrite) throw new BillingReadOnlyError(profile.accessReason);
    return profile;
  }

  static async assertBranchWritable(
    branchId: string,
    client: Prisma.TransactionClient | typeof prisma = prisma
  ) {
    const branch = await client.branch.findUnique({
      where: { id: branchId },
      select: { organizationId: true, billingStatus: true },
    });
    if (!branch) throw new Error("Branch not found");
    if (branch.billingStatus === "ARCHIVED") {
      throw new BillingReadOnlyError("This branch is archived");
    }
    if (branch.billingStatus === "PENDING_ACTIVATION") {
      throw new BillingReadOnlyError("This branch is awaiting provider-confirmed billing activation");
    }
    if (branch.billingStatus === "REMOVAL_SCHEDULED") {
      throw new BillingReadOnlyError("This branch is read-only while removal is scheduled");
    }
    return this.assertOrganizationWritable(branch.organizationId, client);
  }
}
