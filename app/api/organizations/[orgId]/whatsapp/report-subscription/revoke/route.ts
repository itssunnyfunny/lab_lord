import { handleWhatsAppReportSubscriptionRevoke } from "@/lib/whatsappReportRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppReportSubscriptionRevoke(request, {
    scope: "ORGANIZATION",
    organizationId: orgId,
  });
}
