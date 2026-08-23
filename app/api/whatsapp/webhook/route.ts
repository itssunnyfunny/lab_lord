import { NextResponse } from "next/server";
import { safeWhatsAppError } from "@/lib/whatsappHttp";
import {
  verifyMetaWebhookChallenge,
  WhatsAppWebhookService,
} from "@/services/whatsappWebhook.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const challenge = verifyMetaWebhookChallenge({
      mode: params.get("hub.mode"),
      token: params.get("hub.verify_token"),
      challenge: params.get("hub.challenge"),
    });
    if (challenge == null) return new Response("Not found", { status: 404 });
    return new Response(challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
export async function POST(request: Request) {
  try {
    return NextResponse.json(await WhatsAppWebhookService.handle(request));
  } catch (error) {
    const safe = safeWhatsAppError(error);
    return NextResponse.json(
      { error: safe.message, code: safe.code },
      { status: safe.status }
    );
  }
}
