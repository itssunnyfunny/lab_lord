import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { OrganizationService } from "@/services/organization.service";
import { prisma } from "@/lib/prisma";

export async function GET(request: Request, context: { params: Promise<{ orgId: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { orgId } = await context.params;
  try {
    await OrganizationService.getOrganizationForOwnerAccess(orgId, user.id);
    const cursor = new URL(request.url).searchParams.get("cursor");
    const invoices = await prisma.organizationSubscriptionInvoice.findMany({
      where: { organizationId: orgId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 21,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = invoices.length > 20;
    const items = invoices.slice(0, 20);
    return NextResponse.json({ items, nextCursor: hasMore ? items.at(-1)?.id ?? null : null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load invoices";
    return NextResponse.json({ error: message }, { status: /Unauthorized/.test(message) ? 403 : 404 });
  }
}
