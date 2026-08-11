import { describe, expect, it } from "vitest";
import { BILLING_FEATURE_POLICIES } from "@/lib/billingPolicy";

describe("billing feature policy", () => {
  it("keeps supported AI tools without the retired insights surface", () => {
    expect(BILLING_FEATURE_POLICIES).not.toHaveProperty("AI_INSIGHTS");
    expect(BILLING_FEATURE_POLICIES).toHaveProperty("AI_REPORTS");
    expect(BILLING_FEATURE_POLICIES).toHaveProperty("AI_MESSAGES");
  });
});
