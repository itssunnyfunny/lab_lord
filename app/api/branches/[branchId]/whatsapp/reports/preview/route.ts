import { handleWhatsAppReportPreview } from "@/lib/whatsappReportRoute";

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  const { branchId } = await context.params;
  return handleWhatsAppReportPreview(request, { scope: "BRANCH", branchId });
}
