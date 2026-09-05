import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { assertRazorpayBillingWritesEnabled } from "@/lib/billingFeature";
import { BillingChangeInProgressError, BillingManualReviewRequiredError } from "@/lib/billingErrors";
import { getRazorpayMutationClient, RazorpayApiError, resolveRazorpayMode, type RazorpayApiClient, type RazorpaySubscription } from "@/lib/razorpay";
import type { OrganizationBillingChange, Prisma } from "@/app/generated/prisma/client";

type Command = {
  [M in "createSubscription" | "updateSubscription" | "cancelSubscription" | "cancelScheduledChanges"]:
    { method: M; args: Parameters<RazorpayApiClient[M]> }
}["createSubscription" | "updateSubscription" | "cancelSubscription" | "cancelScheduledChanges"];
type Purpose = "CREATE" | "MUTATE" | "UNDO_SCHEDULE" | "CANCEL_CANDIDATE" | "CANCEL_SOURCE" | "EXPIRE_INITIAL";
type Input = {
  organizationId: string;
  leaseToken: string;
  purpose: Purpose;
  command: Command;
} & ({ change: Pick<OrganizationBillingChange, "id" | "organizationId" | "attemptCount" | "processingStartedAt">; subscriptionId?: never }
  | { change?: never; subscriptionId: string; purpose: "EXPIRE_INITIAL" });

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([,v]) => v !== undefined).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,canonical(v)]));
  return value;
}
export function isDefinitelyRejectedBillingProviderError(error: unknown) {
  return error instanceof RazorpayApiError && error.status !== 408
    && ["AUTHENTICATION", "NOT_FOUND", "RATE_LIMIT", "REQUEST"].includes(error.kind);
}

/** The only SaaS subscription dispatch boundary. Intent admission commits before
 * the external call. Lease expiry never makes an admitted/unknown action replayable.
 * CONFIRMED means a durable provider response, not paid access or domain finalization.
 */
export async function executeBillingProviderAction(input: Input): Promise<RazorpaySubscription> {
  assertRazorpayBillingWritesEnabled(input.organizationId);
  const providerMode = resolveRazorpayMode();
  const request = canonical(input.command) as Prisma.InputJsonObject;
  const command = request as unknown as Command;
  const requestHash = createHash("sha256").update(JSON.stringify(request)).digest("hex");
  const actionKey = `${input.change?.id ?? input.subscriptionId}:${input.purpose}`;
  const reviewId = input.change ? input.change.id : input.subscriptionId;
  const dispatchToken = randomUUID();
  const action = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id=${input.organizationId} FOR UPDATE`;
    const owner = await tx.organization.findFirst({ where: {
      id: input.organizationId, billingMutationLeaseToken: input.leaseToken,
      billingMutationLeaseUntil: { gt: new Date() },
    } });
    if (!owner) throw new BillingChangeInProgressError(input.change?.id ?? null, "Billing dispatch ownership was lost");
    if (input.change) {
      const change = await tx.organizationBillingChange.findFirst({ where: {
        id: input.change.id, organizationId: input.organizationId, status: "PROCESSING",
        attemptCount: input.change.attemptCount, processingStartedAt: input.change.processingStartedAt,
      }, include: { organizationSubscription: true, replacementSubscription: true } });
      if (!change || input.change.organizationId !== input.organizationId) throw new BillingChangeInProgressError(input.change.id);
      const target = input.purpose === "CANCEL_CANDIDATE" ? change.replacementSubscription : change.organizationSubscription;
      if (input.purpose === "CREATE") {
        if (command.method !== "createSubscription" || change.authorizedProviderMode !== providerMode
          || command.args[0].plan_id !== change.authorizedRazorpayPlanId
          || command.args[0].quantity !== change.authorizedQuantity
          || command.args[0].total_count !== change.authorizedTotalCount
          || command.args[0].notes.billing_change_id !== change.id) {
          throw new BillingManualReviewRequiredError(change.id, "Create does not match the immutable commercial intent");
        }
      } else {
        if (command.method === "createSubscription" || !target || target.organizationId !== input.organizationId
          || target.providerMode !== providerMode || command.args[0] !== target.razorpaySubscriptionId
          || (input.purpose === "UNDO_SCHEDULE" && command.method !== "cancelScheduledChanges")
          || (["CANCEL_SOURCE","CANCEL_CANDIDATE"].includes(input.purpose) && command.method !== "cancelSubscription")
          || (input.purpose === "MUTATE" && !["updateSubscription","cancelSubscription"].includes(command.method))) {
          throw new BillingManualReviewRequiredError(change.id, "Action does not match its tenant-bound subscription");
        }
        if (command.method === "updateSubscription" && (change.authorizedProviderMode !== providerMode
          || (command.args[1].plan_id !== undefined && command.args[1].plan_id !== change.authorizedRazorpayPlanId)
          || (command.args[1].quantity !== undefined && command.args[1].quantity !== change.authorizedQuantity))) {
          throw new BillingManualReviewRequiredError(change.id, "Update does not match the immutable commercial intent");
        }
      }
    } else {
      const subscription = await tx.organizationSubscription.findFirst({ where: {
        id: input.subscriptionId, organizationId: input.organizationId, providerMode,
      } });
      if (!subscription || command.method !== "cancelSubscription"
        || command.args[0] !== subscription.razorpaySubscriptionId
        || command.args[1].cancel_at_cycle_end !== false) throw new Error("Invalid authorization-expiry action");
    }
    const existing = await tx.billingProviderAction.findUnique({ where: { organizationId_actionKey: { organizationId: input.organizationId, actionKey } } });
    if (existing) {
      if (existing.requestHash !== requestHash || existing.providerMode !== providerMode) throw new BillingManualReviewRequiredError(reviewId, "Provider action intent changed");
      if (existing.status === "CONFIRMED") return existing;
      if (existing.status !== "REJECTED") throw new BillingManualReviewRequiredError(reviewId, "An earlier provider action requires read-only reconciliation; it cannot be replayed");
    }
    const conflict = await tx.billingProviderAction.findFirst({ where: {
      organizationId: input.organizationId, status: { in: ["ADMITTED", "UNKNOWN"] },
    } });
    if (conflict) throw new BillingManualReviewRequiredError(conflict.changeId ?? conflict.id, "Another provider action has an unresolved outcome");
    return existing
      ? tx.billingProviderAction.update({ where: { id: existing.id }, data: {
        status: "ADMITTED", dispatchToken, admittedAt: new Date(), failureKind: null,
      } })
      : tx.billingProviderAction.create({ data: {
        organizationId: input.organizationId, changeId: input.change?.id, actionKey,
        providerMode, purpose: input.purpose, requestHash, request, status: "ADMITTED", dispatchToken,
      } });
  });
  if (action.status === "CONFIRMED") return action.response as unknown as RazorpaySubscription;

  let response: RazorpaySubscription;
  try {
    const adapter = getRazorpayMutationClient();
    const command = action.request as unknown as Command;
    switch (command.method) {
      case "createSubscription": response = await adapter.createSubscription(...command.args); break;
      case "updateSubscription": response = await adapter.updateSubscription(...command.args); break;
      case "cancelSubscription": response = await adapter.cancelSubscription(...command.args); break;
      case "cancelScheduledChanges": response = await adapter.cancelScheduledChanges(...command.args); break;
    }
  } catch (error) {
    await prisma.billingProviderAction.updateMany({ where: { id: action.id, dispatchToken, status: "ADMITTED" }, data: {
      status: isDefinitelyRejectedBillingProviderError(error) ? "REJECTED" : "UNKNOWN",
      failureKind: error instanceof RazorpayApiError ? error.kind : "UNKNOWN",
    } });
    throw error;
  }
  // Only this immutable action's token can publish its response. This cannot
  // finalize a subscription, release organization ownership or grant access.
  const saved = await prisma.billingProviderAction.updateMany({ where: {
    id: action.id, dispatchToken, status: "ADMITTED",
  }, data: { status: "CONFIRMED", response: JSON.parse(JSON.stringify(response)) as Prisma.InputJsonValue, respondedAt: new Date() } });
  if (saved.count !== 1) throw new BillingManualReviewRequiredError(reviewId, "Provider response requires read-only reconciliation");
  return response;
}

/** Called only inside a domain finalizer after its exact provider-evidence and
 * ownership checks. A different action on the same change is never resolved. */
export async function confirmReconciledBillingProviderAction(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; identity: string; purpose: Purpose; provider: RazorpaySubscription },
) {
  const action = await tx.billingProviderAction.findUnique({ where: { organizationId_actionKey: {
    organizationId: input.organizationId, actionKey: `${input.identity}:${input.purpose}`,
  } } });
  if (!action || !["ADMITTED", "UNKNOWN"].includes(action.status)) return;
  const request = action.request as unknown as Command;
  if (action.providerMode !== resolveRazorpayMode()
    || !input.provider.id
    || (request.method !== "createSubscription" && request.args[0] !== input.provider.id)
    || (request.method === "createSubscription" && (request.args[0].plan_id !== input.provider.plan_id
      || request.args[0].quantity !== input.provider.quantity))) {
    throw new BillingManualReviewRequiredError(action.changeId ?? action.id, "Reconciliation does not match the admitted action");
  }
  await tx.billingProviderAction.updateMany({ where: { id: action.id, dispatchToken: action.dispatchToken, status: action.status }, data: {
    status: "CONFIRMED", response: JSON.parse(JSON.stringify(input.provider)) as Prisma.InputJsonValue,
    respondedAt: new Date(), failureKind: null,
  } });
}

export async function getConfirmedBillingProviderResponse(organizationId: string, identity: string, purpose: Purpose) {
  const action = await prisma.billingProviderAction.findUnique({ where: { organizationId_actionKey: {
    organizationId, actionKey: `${identity}:${purpose}`,
  } } });
  return action?.status === "CONFIRMED" && action.providerMode === resolveRazorpayMode()
    ? action.response as unknown as RazorpaySubscription : null;
}
