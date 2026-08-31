import { handleWhatsAppReportSubscriptionRevoke } from "@/lib/whatsappReportRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  const { branchId } = await context.params;
  return handleWhatsAppReportSubscriptionRevoke(request, { scope: "BRANCH", branchId });
}
