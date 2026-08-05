import { afterEach, describe, expect, it } from "vitest";
import {
  isWorkspaceBillingEnabled,
  isWorkspaceBillingEnabledFor,
  WORKSPACE_BILLING_FLAG,
} from "@/lib/billingFeature";

const original = process.env[WORKSPACE_BILLING_FLAG];

afterEach(() => {
  if (original === undefined) delete process.env[WORKSPACE_BILLING_FLAG];
  else process.env[WORKSPACE_BILLING_FLAG] = original;
});

describe("workspace billing feature flag", () => {
  it("is disabled by default", () => {
    delete process.env[WORKSPACE_BILLING_FLAG];
    expect(isWorkspaceBillingEnabled()).toBe(false);
  });

  it("requires both the server flag and an upgraded organization", () => {
    process.env[WORKSPACE_BILLING_FLAG] = "true";
    expect(isWorkspaceBillingEnabledFor("LEGACY")).toBe(false);
    expect(isWorkspaceBillingEnabledFor("WORKSPACE_V2")).toBe(true);
  });
});
