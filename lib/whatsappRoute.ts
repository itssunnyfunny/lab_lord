import { NextResponse } from "next/server";
import { checkRateLimit, getRequestRateLimitKey } from "@/lib/rateLimit";

export function whatsAppRateLimitResponse(
  request: Request,
  namespace: string,
  actorId: string,
  options: { limit: number; windowMs: number } = { limit: 10, windowMs: 60_000 }
) {
  const result = checkRateLimit(
    getRequestRateLimitKey(request, `whatsapp:${namespace}`, actorId),
    options
  );
  if (result.allowed) return null;
  return NextResponse.json(
    { error: "Too many WhatsApp requests", code: "WHATSAPP_RATE_LIMITED" },
    { status: 429, headers: { "Retry-After": String(result.retryAfter) } }
  );
}
