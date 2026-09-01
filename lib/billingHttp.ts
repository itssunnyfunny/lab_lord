import { BillingWritesDisabledError } from "@/lib/billingFeature";
import {
  BillingChangeInProgressError,
  BillingManualReviewRequiredError,
  BillingResourceNotFoundError,
  BillingValidationError,
} from "@/lib/billingErrors";
import {
  OrganizationAccessNotFoundError,
  OrganizationValidationError,
} from "@/lib/organizationErrors";
import { RazorpayApiError, RazorpayConfigurationError } from "@/lib/razorpay";
import {
  BillingReadOnlyError,
  SubscriptionEntitlementError,
} from "@/services/entitlement.service";
import {
  RazorpayPlanCatalogBusyError,
  RazorpayPlanCatalogProvisioningError,
} from "@/services/razorpayPlanCatalog.service";

export function billingHttpStatus(error: unknown, fallbackStatus = 400) {
  if (error instanceof OrganizationAccessNotFoundError) return 404;
  if (error instanceof BillingResourceNotFoundError) return 404;
  if (error instanceof BillingValidationError || error instanceof OrganizationValidationError) return 400;
  if (error instanceof BillingChangeInProgressError) return 409;
  if (error instanceof BillingManualReviewRequiredError) return 409;
  if (error instanceof BillingReadOnlyError || error instanceof SubscriptionEntitlementError) return 403;
  if (
    error instanceof BillingWritesDisabledError
    || error instanceof RazorpayConfigurationError
    || error instanceof RazorpayPlanCatalogBusyError
    || error instanceof RazorpayPlanCatalogProvisioningError
  ) return 503;
  if (error instanceof RazorpayApiError) return 502;
  return fallbackStatus;
}
