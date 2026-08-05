import { BillingService } from "@/services/billing.service";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature");
    const eventId = req.headers.get("x-razorpay-event-id");
    const result = await BillingService.handleRazorpayWebhook(rawBody, signature, eventId);

    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = message.includes("signature") || message.includes("collision") ? 400 : 500;

    console.error("[RAZORPAY_WEBHOOK_POST]", error);
    return NextResponse.json({ error: message }, { status });
  }
}
