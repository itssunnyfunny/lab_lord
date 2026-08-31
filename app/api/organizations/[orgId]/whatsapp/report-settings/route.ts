import {
  handleWhatsAppOrganizationReportSettingsGet,
  handleWhatsAppOrganizationReportSettingsPatch,
} from "@/lib/whatsappReportRoute";

export async function GET(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppOrganizationReportSettingsGet(request, orgId);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ orgId: string }> }
) {
  const { orgId } = await context.params;
  return handleWhatsAppOrganizationReportSettingsPatch(request, orgId);
}
