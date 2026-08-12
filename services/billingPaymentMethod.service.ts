import type { ProviderPaymentMethod } from "@/app/generated/prisma/client";

export function normalizeProviderPaymentMethod(
  value: string | ProviderPaymentMethod | null | undefined
): ProviderPaymentMethod {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "card") return "CARD";
  if (normalized === "upi") return "UPI";
  if (normalized === "emandate" || normalized === "netbanking") return "EMANDATE";
  return "UNKNOWN";
}

export function isSupportedProviderPaymentMethod(
  method: ProviderPaymentMethod
): method is Exclude<ProviderPaymentMethod, "UNKNOWN"> {
  return method === "CARD" || method === "UPI" || method === "EMANDATE";
}
