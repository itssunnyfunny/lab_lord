import { BillingWritesDisabledError } from "@/lib/billingFeature";
import { BillingChangeInProgressError } from "@/lib/billingErrors";
import { RazorpayApiError, RazorpayConfigurationError } from "@/lib/razorpay";
import {
  RazorpayPlanCatalogBusyError,
  RazorpayPlanCatalogProvisioningError,
} from "@/services/razorpayPlanCatalog.service";

export function billingHttpStatus(error: unknown, fallbackStatus = 400) {
  if (error instanceof BillingChangeInProgressError) return 409;
  if (
    error instanceof BillingWritesDisabledError
    || error instanceof RazorpayConfigurationError
    || error instanceof RazorpayPlanCatalogBusyError
    || error instanceof RazorpayPlanCatalogProvisioningError
  ) return 503;
  if (error instanceof RazorpayApiError) return 502;

  const message = error instanceof Error ? error.message : "";
  if (/provider mode.+(?:match|cannot)|Razorpay credentials/i.test(message)) return 503;
  if (/Unauthorized|does not belong/i.test(message)) return 403;
  if (/not found/i.test(message)) return 404;
  return fallbackStatus;
}
