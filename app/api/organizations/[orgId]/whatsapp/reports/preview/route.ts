import { handleWhatsAppReportPreview } from "@/lib/whatsappReportRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppReportPreview(request, {
    scope: "ORGANIZATION",
    organizationId: orgId,
  });
}
