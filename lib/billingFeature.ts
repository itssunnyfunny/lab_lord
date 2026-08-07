export const WORKSPACE_BILLING_FLAG = "WORKSPACE_BRANCH_BILLING_V2_ENABLED" as const;
export const RAZORPAY_BILLING_WRITES_FLAG = "RAZORPAY_BILLING_WRITES_ENABLED" as const;

export class BillingWritesDisabledError extends Error {
  readonly code = "BILLING_WRITES_DISABLED";

  constructor() {
    super("Subscription billing changes are temporarily unavailable while payment setup is being verified");
    this.name = "BillingWritesDisabledError";
  }
}

export function isWorkspaceBillingEnabled() {
  return process.env[WORKSPACE_BILLING_FLAG]?.trim().toLowerCase() === "true";
}

export function isWorkspaceBillingEnabledFor(
  billingModelVersion: "LEGACY" | "WORKSPACE_V2"
) {
  return isWorkspaceBillingEnabled() && billingModelVersion === "WORKSPACE_V2";
}

function configuredCanaryOrganizations() {
  return new Set(
    (process.env.RAZORPAY_LIVE_CANARY_ORG_IDS ?? "")
      .split(",")
      .map(value => value.trim())
      .filter(Boolean)
  );
}

function isLiveProductionCanaryEnvironment() {
  return process.env.VERCEL_ENV?.trim().toLowerCase() === "production"
    && process.env.RAZORPAY_MODE?.trim().toUpperCase() === "LIVE"
    && process.env.RAZORPAY_KEY_ID?.trim().startsWith("rzp_live_");
}

export function areRazorpayBillingWritesEnabled(organizationId?: string) {
  const configured = process.env[RAZORPAY_BILLING_WRITES_FLAG]?.trim().toLowerCase();
  if (configured === "true") return true;
  if (
    organizationId
    && isLiveProductionCanaryEnvironment()
    && configuredCanaryOrganizations().has(organizationId)
  ) return true;

  // Tests exercise provider behavior with an injected fake client. Deployed
  // environments and local development remain fail-closed unless explicitly
  // enabled.
  return configured == null && process.env.NODE_ENV === "test";
}

export function assertRazorpayBillingWritesEnabled(organizationId?: string) {
  if (!areRazorpayBillingWritesEnabled(organizationId)) {
    throw new BillingWritesDisabledError();
  }
}
