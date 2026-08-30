import {
  resolveTrustedPaidThrough,
  type BillingPaidEvidenceSubscription,
} from "@/services/billingPaidEvidence.service";

/** Prevents a legacy-to-V2 rollout from carrying unbacked paid access forward. */
export function assertWorkspaceRolloutPaidEvidence(
  subscription: BillingPaidEvidenceSubscription,
  now: Date = new Date()
) {
  const trustedPaidThrough = resolveTrustedPaidThrough(subscription, now);
  if (subscription.paidThrough && !trustedPaidThrough) {
    throw new Error("stored paidThrough is not backed by exact settlement evidence");
  }
  if (["ACTIVE", "PENDING"].includes(subscription.status) && !trustedPaidThrough) {
    throw new Error("active paid access requires exact provider settlement evidence");
  }
  return trustedPaidThrough;
}
