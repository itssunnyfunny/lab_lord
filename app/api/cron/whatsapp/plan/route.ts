import { NextResponse } from "next/server";

import { WhatsAppPlannerService } from "@/services/whatsappPlanner.service";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({ ok: true, ...await WhatsAppPlannerService.run() });
  } catch (error) {
    console.error(
      "[WHATSAPP_PLANNER_CRON]",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "WhatsApp planning failed" }, { status: 500 });
  }
}
