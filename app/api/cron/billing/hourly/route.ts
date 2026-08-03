import { NextResponse } from "next/server";
import { BillingDeadlineService } from "@/services/billingDeadline.service";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret || request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    return NextResponse.json({ ok: true, ...await BillingDeadlineService.run() });
  } catch (error) {
    console.error("[WORKSPACE_BILLING_HOURLY_CRON]", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Workspace billing cron failed" },
      { status: 500 }
    );
  }
}
