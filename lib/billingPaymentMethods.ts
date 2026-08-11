export const SUPPORTED_RECURRING_PAYMENT_METHODS = ["CARD", "UPI", "EMANDATE"] as const;

export type SupportedRecurringPaymentMethod = typeof SUPPORTED_RECURRING_PAYMENT_METHODS[number];
export type ProviderPaymentMethodValue = SupportedRecurringPaymentMethod | "UNKNOWN";

export const PROVIDER_PAYMENT_METHOD_LABELS: Record<ProviderPaymentMethodValue, string> = {
  CARD: "Card",
  UPI: "UPI AutoPay",
  EMANDATE: "eMandate",
  UNKNOWN: "Payment method",
};

export function getProviderPaymentMethodLabel(method: string | null | undefined) {
  const normalized = method?.trim().toUpperCase() as ProviderPaymentMethodValue | undefined;
  return normalized && normalized in PROVIDER_PAYMENT_METHOD_LABELS
    ? PROVIDER_PAYMENT_METHOD_LABELS[normalized]
    : PROVIDER_PAYMENT_METHOD_LABELS.UNKNOWN;
}

export function isSupportedRecurringPaymentMethod(
  method: string | null | undefined
): method is SupportedRecurringPaymentMethod {
  return SUPPORTED_RECURRING_PAYMENT_METHODS.includes(method as SupportedRecurringPaymentMethod);
}
