import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("WhatsApp route authentication boundaries", () => {
  it("keeps the public webhook free of Clerk/session auth and delegates to signature verification", () => {
    const route = source("app/api/whatsapp/webhook/route.ts");
    expect(route).not.toMatch(/getSessionUser|auth\.protect|clerk/i);
    expect(route).toContain("WhatsAppWebhookService.handle(request)");
    expect(route).toContain('runtime = "nodejs"');
  });

  it("self-authenticates every organization-scoped WhatsApp route", () => {
    const routes = [
      "app/api/organizations/[orgId]/whatsapp/config/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/route.ts",
      "app/api/organizations/[orgId]/whatsapp/connection-intents/route.ts",
      "app/api/organizations/[orgId]/whatsapp/connection-intents/[intentId]/complete/route.ts",
      "app/api/organizations/[orgId]/whatsapp/branch-assignments/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/register/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/disconnect/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/templates/sync/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/managed-templates/install/route.ts",
    ];

    for (const path of routes) {
      const route = source(path);
      expect(route, path).toContain("getSessionUser");
      expect(route, path).toContain('status: 401');
    }
  });

  it("self-authenticates every branch-scoped WhatsApp route", () => {
    const routes = [
      "app/api/branches/[branchId]/whatsapp/settings/route.ts",
      "app/api/branches/[branchId]/whatsapp/delivery/enable/route.ts",
      "app/api/branches/[branchId]/whatsapp/delivery/disable/route.ts",
      "app/api/branches/[branchId]/whatsapp/automation/enable/route.ts",
      "app/api/branches/[branchId]/whatsapp/automation/disable/route.ts",
      "app/api/branches/[branchId]/whatsapp/recipients/route.ts",
      "app/api/branches/[branchId]/whatsapp/recipients/bulk/route.ts",
      "app/api/branches/[branchId]/whatsapp/recipients/[recipientId]/route.ts",
      "app/api/branches/[branchId]/whatsapp/recipients/student/[studentId]/route.ts",
      "app/api/branches/[branchId]/whatsapp/payment-reminders/preview/route.ts",
      "app/api/branches/[branchId]/whatsapp/payment-reminders/route.ts",
      "app/api/branches/[branchId]/whatsapp/messages/route.ts",
    ];

    for (const path of routes) {
      const route = source(path);
      expect(route, path).toContain("getSessionUser");
      expect(route, path).toContain("status: 401");
    }
  });

  it("requires the shared same-origin guard on every authenticated mutation route", () => {
    const mutationRoutes = [
      "app/api/organizations/[orgId]/whatsapp/connection-intents/route.ts",
      "app/api/organizations/[orgId]/whatsapp/connection-intents/[intentId]/complete/route.ts",
      "app/api/organizations/[orgId]/whatsapp/branch-assignments/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/register/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/disconnect/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/templates/sync/route.ts",
      "app/api/organizations/[orgId]/whatsapp/senders/[senderId]/managed-templates/install/route.ts",
      "app/api/branches/[branchId]/whatsapp/settings/route.ts",
      "app/api/branches/[branchId]/whatsapp/delivery/enable/route.ts",
      "app/api/branches/[branchId]/whatsapp/delivery/disable/route.ts",
      "app/api/branches/[branchId]/whatsapp/automation/enable/route.ts",
      "app/api/branches/[branchId]/whatsapp/automation/disable/route.ts",
      "app/api/branches/[branchId]/whatsapp/recipients/route.ts",
      "app/api/branches/[branchId]/whatsapp/recipients/bulk/route.ts",
      "app/api/branches/[branchId]/whatsapp/recipients/[recipientId]/route.ts",
      "app/api/branches/[branchId]/whatsapp/payment-reminders/preview/route.ts",
      "app/api/branches/[branchId]/whatsapp/payment-reminders/route.ts",
    ];

    for (const path of mutationRoutes) {
      expect(source(path), path).toContain("assertWhatsAppSameOriginRequest(request)");
    }
  });
});
