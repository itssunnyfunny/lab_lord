import {
  RazorpayApiError,
  type RazorpayApiClient,
  type RazorpaySubscription,
} from "@/lib/razorpay";
import type {
  BillingModelVersion,
  RazorpayMode,
  SaasPlan,
} from "@/app/generated/prisma/client";

export const INITIAL_PROVISIONING_INTENT_VERSION = 1 as const;
export const INITIAL_PROVISIONING_PROCESSING_CODE = "SUBSCRIPTION_CREATE_PROCESSING";
export const INITIAL_PROVISIONING_OUTCOME_UNKNOWN_CODE = "SUBSCRIPTION_CREATE_OUTCOME_UNKNOWN";
export const INITIAL_PROVISIONING_MULTIPLE_MATCHES_CODE = "SUBSCRIPTION_CREATE_MULTIPLE_MATCHES";
export const INITIAL_PROVISIONING_UNSAFE_MATCH_CODE = "SUBSCRIPTION_CREATE_UNSAFE_MATCH";
export const INITIAL_PROVISIONING_NO_MATCH_CODE = "SUBSCRIPTION_CREATE_NO_MATCH";
export const INITIAL_PROVISIONING_LIST_FAILED_CODE = "SUBSCRIPTION_CREATE_RECONCILIATION_FAILED";
export const INITIAL_PROVISIONING_PROVIDER_REJECTED_CODE = "SUBSCRIPTION_CREATE_PROVIDER_REJECTED";
export const INITIAL_PROVISIONING_MALFORMED_RESPONSE_CODE = "SUBSCRIPTION_CREATE_MALFORMED_RESPONSE";
export const INITIAL_PROVISIONING_LOCAL_FINALIZATION_CODE = "SUBSCRIPTION_CREATE_LOCAL_FINALIZATION_FAILED";
export const INITIAL_PROVISIONING_MODE_MISMATCH_CODE = "SUBSCRIPTION_CREATE_MODE_MISMATCH";

export type InitialProvisioningTuple = {
  changeId: string;
  organizationId: string;
  providerMode: RazorpayMode;
  billingModelVersion: BillingModelVersion;
  plan: SaasPlan;
  providerPlanId: string;
  quantity: number;
  providerOfferId: string | null;
  startAt: number | null;
  expireAt: number;
  totalCount: number;
};

export type InitialProvisioningDiscovery =
  | { kind: "UNAVAILABLE" }
  | { kind: "NO_MATCH" }
  | { kind: "ONE_SAFE_CREATED"; subscription: RazorpaySubscription }
  | { kind: "MULTIPLE_MATCHES"; subscriptions: RazorpaySubscription[] }
  | { kind: "UNSAFE_MATCH"; subscription: RazorpaySubscription };

function normalizedOptionalId(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function encodedOptionalId(value: string | null) {
  return value ?? "none";
}

function encodedStartAt(value: number | null) {
  return value == null ? "immediate" : String(value);
}

export function initialProvisioningNotes(intent: InitialProvisioningTuple) {
  return {
    app: "lab_lords",
    billing_type: "saas_subscription",
    organization_id: intent.organizationId,
    provider_mode: intent.providerMode,
    billing_change_id: intent.changeId,
    billing_model_version: intent.billingModelVersion,
    plan: intent.plan,
    provider_plan_id: intent.providerPlanId,
    quantity: String(intent.quantity),
    offer_id: encodedOptionalId(intent.providerOfferId),
    start_at: encodedStartAt(intent.startAt),
    expire_at: String(intent.expireAt),
    total_count: String(intent.totalCount),
  };
}

export function isSameInitialProvisioningIntent(
  provider: RazorpaySubscription,
  intent: InitialProvisioningTuple
) {
  const expectedNotes = initialProvisioningNotes(intent);
  const notes = provider.notes;
  if (!notes) return false;
  for (const [key, value] of Object.entries(expectedNotes)) {
    if (notes[key] !== value) return false;
  }

  return provider.entity === "subscription"
    && typeof provider.id === "string"
    && provider.id.length > 0
    && provider.plan_id === intent.providerPlanId
    && provider.total_count === intent.totalCount
    && provider.quantity === intent.quantity
    && normalizedOptionalId(provider.offer_id) === intent.providerOfferId
    && provider.expire_by === intent.expireAt
    && (intent.startAt == null || provider.start_at === intent.startAt);
}

export function classifyInitialProvisioningMatches(
  matches: RazorpaySubscription[],
  intent: InitialProvisioningTuple
): InitialProvisioningDiscovery {
  const exact = matches.filter(subscription => isSameInitialProvisioningIntent(subscription, intent));
  if (exact.length === 0) return { kind: "NO_MATCH" };
  if (exact.length > 1) return { kind: "MULTIPLE_MATCHES", subscriptions: exact };
  const subscription = exact[0];
  if (isUnchargedCreatedInitialProvisioning(subscription)) {
    return { kind: "ONE_SAFE_CREATED", subscription };
  }
  return { kind: "UNSAFE_MATCH", subscription };
}

export function isUnchargedCreatedInitialProvisioning(
  subscription: RazorpaySubscription
) {
  return subscription.status.toLowerCase() === "created"
    && Number.isSafeInteger(subscription.paid_count)
    && subscription.paid_count === 0;
}

export async function discoverInitialProvisioning(
  razorpay: Pick<RazorpayApiClient, "listSubscriptions">,
  intent: InitialProvisioningTuple
): Promise<InitialProvisioningDiscovery> {
  if (!razorpay.listSubscriptions) return { kind: "UNAVAILABLE" };
  const matches: RazorpaySubscription[] = [];
  for (let skip = 0; ; skip += 100) {
    const page = await razorpay.listSubscriptions({ count: 100, skip });
    matches.push(...page.items.filter(subscription =>
      isSameInitialProvisioningIntent(subscription, intent)
    ));
    if (page.items.length < 100) break;
  }
  return classifyInitialProvisioningMatches(matches, intent);
}

export function isDefinitelyRejectedInitialProvisioningError(error: unknown) {
  return error instanceof RazorpayApiError
    && error.status !== 408
    && ["AUTHENTICATION", "NOT_FOUND", "RATE_LIMIT", "REQUEST"].includes(error.kind);
}
