import { NextResponse } from "next/server";
import { WhatsAppDispatcherService } from "@/services/whatsappDispatcher.service";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await WhatsAppDispatcherService.run());
  } catch {
    return NextResponse.json({ error: "WhatsApp dispatch failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
