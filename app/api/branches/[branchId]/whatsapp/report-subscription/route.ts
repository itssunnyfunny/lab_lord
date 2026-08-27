import {
  handleWhatsAppReportSubscriptionCreate,
  handleWhatsAppReportSubscriptionGet,
} from "@/lib/whatsappReportRoute";

export async function GET(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  const { branchId } = await context.params;
  return handleWhatsAppReportSubscriptionGet(request, { scope: "BRANCH", branchId });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ branchId: string }> }
) {
  const { branchId } = await context.params;
  return handleWhatsAppReportSubscriptionCreate(request, { scope: "BRANCH", branchId });
}
