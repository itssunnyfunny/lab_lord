import { handleWhatsAppReportSubscriptionPause } from "@/lib/whatsappReportRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppReportSubscriptionPause(request, {
    scope: "ORGANIZATION",
    organizationId: orgId,
  });
}
