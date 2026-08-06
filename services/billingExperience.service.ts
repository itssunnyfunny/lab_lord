import { prisma } from "@/lib/prisma";
import { getBillingPlan } from "@/lib/billingPlans";
import { deriveWorkspaceBillingState } from "@/lib/billingState";
import type { BillingExperience, BillingExperienceOperation } from "@/types/billingExperience";
import type { OrganizationBillingChange } from "@/app/generated/prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_OPERATION_STATUSES = [
  "CHECKOUT_OPEN",
  "VERIFYING",
  "AWAITING_PROVIDER_CONFIRMATION",
] as const;
const TERMINAL_OPERATION_FAILURES = ["DECLINED", "ABANDONED", "FAILED"] as const;

function isCustomerVisibleOperationFailure(change: OrganizationBillingChange | null) {
  if (!change || !TERMINAL_OPERATION_FAILURES.includes(
    change.operationStatus as typeof TERMINAL_OPERATION_FAILURES[number]
  )) {
    return false;
  }
  if (change.operationStatus !== "ABANDONED") return true;

  // ABANDONED is also the persisted operation state for an intentional undo,
  // superseded change, or discarded pending branch. Only an actual Checkout
  // dismissal is a customer-facing payment outcome.
  return change.type === "SUBSCRIPTION_AUTHORIZATION"
    && change.failureCategory === "CHECKOUT_ABANDONED";
}

function experiencePlan(plan: string | null | undefined) {
  if (plan === "PRO") return "STANDARD" as const;
  if (plan === "BASIC") return "BASIC" as const;
  return "NONE" as const;
}

function selectedPlan(subscription: {
  plan: string;
  providerPaymentMethod: string;
  status: string;
} | null) {
  if (!subscription || subscription.providerPaymentMethod !== "CARD") return null;
  if (["CREATED", "EXPIRED", "CANCELLED", "COMPLETED"].includes(subscription.status)) return null;
  const plan = experiencePlan(subscription.plan);
  return plan === "STANDARD" || plan === "BASIC" ? plan : null;
}

function serializeOperation(change: OrganizationBillingChange): BillingExperienceOperation {
  return {
    id: change.id,
    type: change.type,
    status: change.operationStatus,
    returnPath: change.returnPath,
    confirmationDeadlineAt: change.confirmationDeadlineAt?.toISOString() ?? null,
    effectiveAt: change.effectiveAt?.toISOString() ?? null,
    failureCategory: change.failureCategory,
    failureCode: change.failureCode,
    providerPaymentId: change.providerPaymentId,
    branchId: change.branchId,
    toPlan: change.toPlan === "PRO" ? "STANDARD" : change.toPlan === "BASIC" ? "BASIC" : null,
    toQuantity: change.toQuantity,
    lastError: change.lastError,
  };
}

function customerPresentation(input: {
  trialActive: boolean;
  effectivePlan: "BASIC" | "STANDARD" | "STANDARD_TRIAL" | "NONE";
  providerStatus: string | null;
  operationStatus: string | null;
  operationFailureVisible: boolean;
  postTrialPlanSelected: boolean;
}) {
  if (input.operationStatus === "VERIFYING" || input.operationStatus === "AWAITING_PROVIDER_CONFIRMATION") {
    return { state: "CONFIRMING" as const, message: "Your payment is being confirmed. Existing access remains unchanged." };
  }
  if (input.operationStatus === "ABANDONED" && input.operationFailureVisible) {
    return { state: "PAYMENT_NOT_COMPLETED" as const, message: input.trialActive ? "Payment was not completed. Your Standard trial continues." : "Payment was not completed. Your current plan remains unchanged." };
  }
  if (input.operationStatus === "DECLINED") {
    return { state: "PAYMENT_DECLINED" as const, message: "The card authorization was declined. Check the card details or try another supported card." };
  }
  if (input.operationStatus === "FAILED") {
    return { state: "PAYMENT_FAILED" as const, message: "We could not complete the billing change. Your confirmed plan and quantity remain unchanged." };
  }
  if (input.trialActive) return { state: "TRIAL_ACTIVE" as const, message: "Your no-card Standard trial is active." };
  if (input.providerStatus === "PENDING") return { state: "PAYMENT_RETRYING" as const, message: "Your renewal payment is being retried. Access remains available." };
  if (input.providerStatus === "HALTED") return { state: "PAYMENT_HALTED" as const, message: "Payment retries are exhausted. Update your card to restore full access after payment confirmation." };
  if (input.effectivePlan === "STANDARD") return { state: "STANDARD_ACTIVE" as const, message: "Standard is active for this workspace." };
  if (input.effectivePlan === "BASIC") return { state: "BASIC_ACTIVE" as const, message: "Basic is active for this workspace." };
  if (["CANCELLED", "COMPLETED", "EXPIRED"].includes(input.providerStatus ?? "")) return { state: "ACCESS_ENDED" as const, message: "The paid access period has ended. Your data is preserved." };
  return {
    state: "AUTHORIZATION_REQUIRED" as const,
    message: input.postTrialPlanSelected
      ? "Authorize the selected plan to activate billing for this workspace."
      : "Choose a plan and authorize a card to activate billing for this workspace.",
  };
}

export class BillingExperienceService {
  static async getBillingExperience(organizationId: string, userId: string, branchId?: string) {
    const now = new Date();
    const organization = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        subscription: true,
        ownerTrialGrant: true,
        branches: {
          where: { billingStatus: { not: "ARCHIVED" } },
          select: { id: true },
        },
      },
    });
    if (!organization) throw new Error("Organization not found");
    const isOwner = organization.ownerId === userId;
    if (!isOwner) {
      const membership = await prisma.staff.findFirst({
        where: { userId, branch: { organizationId } },
        select: { id: true },
      });
      if (!membership) throw new Error("Unauthorized");
    }

    const branch = branchId
      ? await prisma.branch.findFirst({
          where: { id: branchId, organizationId },
          select: { id: true, name: true, billingStatus: true },
        })
      : null;
    if (branchId && !branch) throw new Error("Branch not found");

    const [latestOperation, scheduledChanges] = await Promise.all([
      prisma.organizationBillingChange.findFirst({
        where: { organizationId },
        orderBy: { sequence: "desc" },
      }),
      prisma.organizationBillingChange.findMany({
        where: { organizationId, operationStatus: "SCHEDULED" },
        orderBy: { sequence: "asc" },
      }),
    ]);

    const trialActive = organization.ownerTrialGrant?.status === "ACTIVE"
      && organization.ownerTrialGrant.trialEndsAt != null
      && organization.ownerTrialGrant.trialEndsAt > now;
    const state = organization.billingModelVersion === "WORKSPACE_V2"
      ? deriveWorkspaceBillingState({
          now,
          trial: organization.ownerTrialGrant
            ? { status: organization.ownerTrialGrant.status, endsAt: organization.ownerTrialGrant.trialEndsAt }
            : null,
          subscription: organization.subscription
            ? { status: organization.subscription.status, plan: organization.subscription.plan, paidThrough: organization.subscription.paidThrough }
            : null,
        })
      : {
          accessMode: "FULL" as const,
          canWrite: true,
          effectivePlan: organization.subscription?.plan ?? "BASIC",
          source: "PAID" as const,
          reason: "Legacy workspace access",
        };

    const effectivePlan = trialActive
      ? "STANDARD_TRIAL" as const
      : state.source === "NONE" && organization.billingModelVersion === "WORKSPACE_V2"
        ? "NONE" as const
        : experiencePlan(state.effectivePlan);
    const entitlementPlan = effectivePlan === "STANDARD" || effectivePlan === "STANDARD_TRIAL" ? "PRO" : "BASIC";
    const entitlements = getBillingPlan(entitlementPlan)?.entitlements ?? [];
    const providerPostTrialPlan = selectedPlan(organization.subscription);
    const postTrialPlan = providerPostTrialPlan
      ?? (organization.selectedPostTrialPlan === "PRO"
        ? "STANDARD" as const
        : organization.selectedPostTrialPlan === "BASIC"
          ? "BASIC" as const
          : null);
    const projectedPlanId = postTrialPlan === "STANDARD"
      ? "PRO"
      : postTrialPlan === "BASIC"
        ? "BASIC"
        : null;
    const projectedUnitAmount = projectedPlanId ? getBillingPlan(projectedPlanId)?.amount ?? 0 : 0;
    const currentUnitAmount = organization.subscription?.amount ?? 0;
    const confirmedQuantity = organization.subscription?.quantity ?? 0;
    const projectedQuantity = organization.branches.length;
    const activeOperation = latestOperation
      && ACTIVE_OPERATION_STATUSES.includes(latestOperation.operationStatus as typeof ACTIVE_OPERATION_STATUSES[number])
      ? latestOperation
      : null;
    const authorizationStatus = ["VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"].includes(activeOperation?.operationStatus ?? "")
      ? "VERIFYING" as const
      : providerPostTrialPlan
        ? "AUTHORIZED" as const
        : "NOT_AUTHORIZED" as const;
    const presentation = customerPresentation({
      trialActive,
      effectivePlan,
      providerStatus: organization.subscription?.status ?? null,
      operationStatus: latestOperation?.operationStatus ?? null,
      operationFailureVisible: isCustomerVisibleOperationFailure(latestOperation),
      postTrialPlanSelected: postTrialPlan != null,
    });

    const latestFailed = isCustomerVisibleOperationFailure(latestOperation);
    const paymentAction = activeOperation?.operationStatus === "CHECKOUT_OPEN"
      ? "CONTINUE_CHECKOUT" as const
      : ["VERIFYING", "AWAITING_PROVIDER_CONFIRMATION"].includes(activeOperation?.operationStatus ?? "")
        ? "WAIT_FOR_CONFIRMATION" as const
        : ["PENDING", "HALTED"].includes(organization.subscription?.status ?? "")
          ? "UPDATE_CARD" as const
          : latestFailed && latestOperation?.type === "SUBSCRIPTION_AUTHORIZATION"
            ? "RETRY_AUTHORIZATION" as const
            : latestFailed
              ? "RETRY_BILLING_CHANGE" as const
            : trialActive && !providerPostTrialPlan
              ? postTrialPlan
                ? "AUTHORIZE_CARD" as const
                : "CHOOSE_PLAN" as const
              : state.accessMode === "READ_ONLY"
                ? postTrialPlan
                  ? "AUTHORIZE_CARD" as const
                  : "CHOOSE_PLAN" as const
                : "NONE" as const;

    const result: BillingExperience = {
      organizationId,
      accessMode: state.accessMode,
      effectivePlan,
      selectedPostTrialPlan: postTrialPlan,
      providerStatus: organization.subscription?.status ?? null,
      customerState: presentation.state,
      customerMessage: presentation.message,
      trialEndsAt: organization.ownerTrialGrant?.trialEndsAt?.toISOString() ?? null,
      trialDaysRemaining: trialActive && organization.ownerTrialGrant?.trialEndsAt
        ? Math.max(1, Math.ceil((organization.ownerTrialGrant.trialEndsAt.getTime() - now.getTime()) / DAY_MS))
        : null,
      paidThrough: organization.subscription?.paidThrough?.toISOString() ?? null,
      confirmedQuantity,
      projectedQuantity,
      currentUnitAmount,
      currentMonthlyTotal: currentUnitAmount * confirmedQuantity,
      projectedUnitAmount,
      projectedMonthlyTotal: projectedUnitAmount * projectedQuantity,
      authorizationStatus,
      planFeeDueToday: trialActive || (organization.subscription?.paidThrough?.getTime() ?? 0) > now.getTime()
        ? 0
        : projectedUnitAmount * projectedQuantity,
      nextChargeAt: authorizationStatus === "AUTHORIZED"
        ? organization.subscription?.chargeAt?.toISOString() ?? null
        : null,
      paymentAction,
      entitlements: [...entitlements],
      latestOperation: latestOperation ? serializeOperation(latestOperation) : null,
      activeOperation: activeOperation ? serializeOperation(activeOperation) : null,
      scheduledChanges: scheduledChanges.map(serializeOperation),
      branch: branch ? { ...branch } : null,
      viewer: { isOwner, canManageBilling: isOwner },
    };
    return result;
  }

  static async getForBranch(branchId: string, userId: string) {
    const branch = await prisma.branch.findUnique({ where: { id: branchId }, select: { organizationId: true } });
    if (!branch) throw new Error("Branch not found");
    return this.getBillingExperience(branch.organizationId, userId, branchId);
  }
}
