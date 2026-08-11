import { describe, expect, it } from "vitest";
import { resolveBranchBillingAction } from "@/lib/api/branches";

describe("branch billing mutation response", () => {
  it.each(["NONE", "PROCESSING", "CHECKOUT_REQUIRED"] as const)(
    "preserves the explicit %s action",
    action => {
      expect(resolveBranchBillingAction({ action })).toBe(action);
    }
  );

  it("adopts additive checkout payloads before every route is upgraded", () => {
    expect(resolveBranchBillingAction({ checkout: {} as never })).toBe("CHECKOUT_REQUIRED");
  });

  it("keeps legacy processing responses usable", () => {
    expect(resolveBranchBillingAction({ processingUrl: "/billing/processing/change_1" })).toBe("PROCESSING");
    expect(resolveBranchBillingAction({})).toBe("NONE");
  });
});
