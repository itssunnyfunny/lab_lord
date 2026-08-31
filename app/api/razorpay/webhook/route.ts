import { BillingService } from "@/services/billing.service";
import {
  RazorpayWebhookPayloadTooLargeError,
  readBoundedRazorpayWebhookBody,
} from "@/lib/razorpayWebhook";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const rawBody = await readBoundedRazorpayWebhookBody(req);
    const signature = req.headers.get("x-razorpay-signature");
    const eventId = req.headers.get("x-razorpay-event-id");
    const result = await BillingService.handleRazorpayWebhook(rawBody, signature, eventId);

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RazorpayWebhookPayloadTooLargeError) {
      return NextResponse.json({ error: error.message }, { status: 413 });
    }
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const status = message.includes("signature") || message.includes("collision") ? 400 : 500;

    console.error("[RAZORPAY_WEBHOOK_POST]", error);
    return NextResponse.json({ error: message }, { status });
  }
}
