export const WORKSPACE_BILLING_FLAG = "WORKSPACE_BRANCH_BILLING_V2_ENABLED" as const;

export function isWorkspaceBillingEnabled() {
  return process.env[WORKSPACE_BILLING_FLAG]?.trim().toLowerCase() === "true";
}

export function isWorkspaceBillingEnabledFor(
  billingModelVersion: "LEGACY" | "WORKSPACE_V2"
) {
  return isWorkspaceBillingEnabled() && billingModelVersion === "WORKSPACE_V2";
}
