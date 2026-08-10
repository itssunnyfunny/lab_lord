import type { BillingEntitlement } from "@/lib/billingPlans";

export type BillingExperiencePlan = "BASIC" | "STANDARD" | "STANDARD_TRIAL" | "NONE";
export type SelectedPostTrialPlan = "BASIC" | "STANDARD" | null;
export type BillingExperienceAccessMode = "FULL" | "WARNING" | "READ_ONLY";

// Neutral UI names temporarily alias the legacy wire values. The values can
// move with backend emitters and exhaustive consumers in a later migration.
export const BILLING_PAYMENT_ACTION = {
  UPDATE_PAYMENT_METHOD: "UPDATE_CARD",
  AUTHORIZE_PAYMENT_METHOD: "AUTHORIZE_CARD",
} as const;

export type BillingPaymentAction =
  | "NONE"
  | "CHOOSE_PLAN"
  | "CONTINUE_CHECKOUT"
  | "WAIT_FOR_CONFIRMATION"
  | "RETRY_AUTHORIZATION"
  | "RETRY_BILLING_CHANGE"
  | "UPDATE_CARD"
  | "AUTHORIZE_CARD";

export type BillingAuthorizationStatus =
  | "NOT_AUTHORIZED"
  | "VERIFYING"
  | "AUTHORIZED";

export type BillingCustomerState =
  | "TRIAL_ACTIVE"
  | "BASIC_ACTIVE"
  | "STANDARD_ACTIVE"
  | "PAYMENT_RETRYING"
  | "PAYMENT_HALTED"
  | "CONFIRMING"
  | "PAYMENT_NOT_COMPLETED"
  | "PAYMENT_DECLINED"
  | "PAYMENT_FAILED"
  | "ACCESS_ENDED"
  | "AUTHORIZATION_REQUIRED";

export type BillingExperienceOperation = {
  id: string;
  type: string;
  status: string;
  returnPath: string | null;
  confirmationDeadlineAt: string | null;
  effectiveAt: string | null;
  failureCategory: string | null;
  failureCode: string | null;
  providerPaymentId: string | null;
  branchId: string | null;
  toPlan: "BASIC" | "STANDARD" | null;
  toQuantity: number | null;
  lastError: string | null;
};

export type BillingExperience = {
  organizationId: string;
  accessMode: BillingExperienceAccessMode;
  effectivePlan: BillingExperiencePlan;
  selectedPostTrialPlan: SelectedPostTrialPlan;
  providerStatus: string | null;
  customerState: BillingCustomerState;
  customerMessage: string;
  trialEndsAt: string | null;
  trialDaysRemaining: number | null;
  paidThrough: string | null;
  confirmedQuantity: number;
  projectedQuantity: number;
  currentUnitAmount: number;
  currentMonthlyTotal: number;
  projectedUnitAmount: number;
  projectedMonthlyTotal: number;
  authorizationStatus: BillingAuthorizationStatus;
  planFeeDueToday: number;
  nextChargeAt: string | null;
  paymentAction: BillingPaymentAction;
  entitlements: BillingEntitlement[];
  latestOperation: BillingExperienceOperation | null;
  activeOperation: BillingExperienceOperation | null;
  scheduledChanges: BillingExperienceOperation[];
  branch: {
    id: string;
    name: string;
    billingStatus: "ACTIVE" | "PENDING_ACTIVATION" | "REMOVAL_SCHEDULED" | "ARCHIVED";
  } | null;
  viewer: {
    isOwner: boolean;
    canManageBilling: boolean;
  };
};
