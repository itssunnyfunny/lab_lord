import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { WhatsAppMaintenanceService } from "@/services/whatsappMaintenance.service";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function invocationId(request: Request) {
  const evidence = request.headers.get("x-vercel-id")
    ?? randomUUID();
  return `maintenance:${createHash("sha256").update(evidence, "utf8").digest("hex")}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({
      ok: true,
      ...await WhatsAppMaintenanceService.run({ invocationId: invocationId(request) }),
    });
  } catch (error) {
    console.error(
      "[WHATSAPP_MAINTENANCE_CRON]",
      error instanceof Error ? error.name : "UnknownError"
    );
    return NextResponse.json({ error: "WhatsApp maintenance failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
