import { handleWhatsAppReportQueueToday } from "@/lib/whatsappReportRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppReportQueueToday(request, {
    scope: "ORGANIZATION",
    organizationId: orgId,
  });
}
