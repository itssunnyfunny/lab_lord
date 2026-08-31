import { handleWhatsAppReportSubscriptionReissue } from "@/lib/whatsappReportRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  const { branchId } = await context.params;
  return handleWhatsAppReportSubscriptionReissue(request, { scope: "BRANCH", branchId });
}
