import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { WhatsAppDispatcherService } from "@/services/whatsappDispatcher.service";

function authorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function invocationId(request: Request) {
  const evidence = request.headers.get("x-vercel-id") ?? randomUUID();
  return `dispatcher:${createHash("sha256").update(evidence, "utf8").digest("hex")}`;
}

async function handle(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json(await WhatsAppDispatcherService.run({
      invocationId: invocationId(request),
    }));
  } catch {
    return NextResponse.json({ error: "WhatsApp dispatch failed" }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
