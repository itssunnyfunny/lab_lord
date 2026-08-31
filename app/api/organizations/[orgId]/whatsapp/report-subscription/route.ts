import {
  handleWhatsAppReportSubscriptionCreate,
  handleWhatsAppReportSubscriptionGet,
} from "@/lib/whatsappReportRoute";

export async function GET(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppReportSubscriptionGet(request, {
    scope: "ORGANIZATION",
    organizationId: orgId,
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppReportSubscriptionCreate(request, {
    scope: "ORGANIZATION",
    organizationId: orgId,
  });
}
