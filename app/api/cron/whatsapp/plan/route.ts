import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { WhatsAppPlannerService } from "@/services/whatsappPlanner.service";

function invocationId(request: Request) {
  const evidence = request.headers.get("x-vercel-id") ?? randomUUID();
  return `collection-planner:${createHash("sha256").update(evidence, "utf8").digest("hex")}`;
}

async function handle(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({
      ok: true,
      ...await WhatsAppPlannerService.run({ invocationId: invocationId(request) }),
    });
  } catch (error) {
    console.error(
      "[WHATSAPP_PLANNER_CRON]",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "WhatsApp planning failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
