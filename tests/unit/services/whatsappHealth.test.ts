import { describe, expect, it } from "vitest";

import {
  WHATSAPP_HEALTH_BATCH_LIMIT,
  WHATSAPP_HEALTH_ELIGIBLE_SENDER_STATUSES,
  WHATSAPP_HEALTH_PROVIDER_READ_METHODS,
} from "@/services/whatsappHealth.service";

describe("WhatsApp health provider boundary", () => {
  it("exposes only the four reviewed provider read methods", () => {
    expect(WHATSAPP_HEALTH_PROVIDER_READ_METHODS).toEqual([
      "fetchWaba",
      "fetchPhoneNumber",
      "listSubscribedApps",
      "listMessageTemplates",
    ]);
    expect(WHATSAPP_HEALTH_PROVIDER_READ_METHODS).not.toEqual(expect.arrayContaining([
      "registerPhoneNumber",
      "subscribeAppToWaba",
      "createManagedUtilityTemplate",
      "sendApprovedUtilityTemplate",
      "assignSystemUserToWaba",
    ]));
    expect(WHATSAPP_HEALTH_BATCH_LIMIT).toBe(10);
  });

  it("cannot complete owner-controlled sender onboarding", () => {
    expect(WHATSAPP_HEALTH_ELIGIBLE_SENDER_STATUSES).toEqual([
      "ACTIVE",
      "RESTRICTED",
    ]);
    expect(WHATSAPP_HEALTH_ELIGIBLE_SENDER_STATUSES).not.toEqual(
      expect.arrayContaining(["PENDING", "NEEDS_REGISTRATION", "ERROR"])
    );
  });
});
