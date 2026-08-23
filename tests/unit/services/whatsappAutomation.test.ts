import { describe, expect, it } from "vitest";

import {
  assertWhatsAppAutomaticLimitAuthority,
  requiredManagedTemplateKeysForAutomation,
} from "@/services/whatsappAutomation.service";

describe("WhatsApp automation template requirements", () => {
  it("derives a deterministic minimum set from fixed stages and tone", () => {
    expect(requiredManagedTemplateKeysForAutomation({
      stages: ["PAST_DUE_PLUS_1", "FEE_DUE_MINUS_3", "PAYMENT_CONFIRMATION"],
      tone: "firm",
    })).toEqual([
      "FEE_RENEWAL_POLITE",
      "MULTI_STUDENT_COLLECTION_SUMMARY",
      "PAST_DUE_FIRM",
      "PAYMENT_CONFIRMATION",
    ]);
  });

  it("requires both truthful welcome variants", () => {
    expect(requiredManagedTemplateKeysForAutomation({ stages: ["WELCOME"], tone: "polite" }))
      .toEqual(["WELCOME_ALLOCATED", "WELCOME_GENERAL"]);
  });

  it("allows managers to reduce automatic limits but reserves every increase for the owner", () => {
    expect(() => assertWhatsAppAutomaticLimitAuthority({
      isOwner: false,
      currentDailyLimit: 20,
      currentCycleLimit: 3,
      nextDailyLimit: 10,
      nextCycleLimit: 2,
    })).not.toThrow();
    expect(() => assertWhatsAppAutomaticLimitAuthority({
      isOwner: false,
      currentDailyLimit: 20,
      currentCycleLimit: 3,
      nextDailyLimit: 21,
    })).toThrow("Only the organization owner can increase automatic message limits");
    expect(() => assertWhatsAppAutomaticLimitAuthority({
      isOwner: true,
      currentDailyLimit: 20,
      currentCycleLimit: 3,
      nextDailyLimit: 200,
      nextCycleLimit: 4,
    })).not.toThrow();
  });
});
