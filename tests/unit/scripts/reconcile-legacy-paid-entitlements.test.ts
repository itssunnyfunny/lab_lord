import { describe, expect, it } from "vitest";
import {
  legacyPaidEntitlementProposalConfirmation,
  runLegacyPaidEntitlementReconciliation,
} from "@/scripts/reconcile-legacy-paid-entitlements";

describe("legacy paid-entitlement command confirmation", () => {
  it("requires an explicit provider mode and organization scope before loading an environment", async () => {
    await expect(runLegacyPaidEntitlementReconciliation([], {})).rejects.toThrow(
      "--expect-razorpay-mode is required"
    );
    await expect(runLegacyPaidEntitlementReconciliation([
      "--expect-razorpay-mode=TEST",
    ], {})).rejects.toThrow("explicit --organization-ids allowlist");
  });

  it("requires the exact fresh proposal hash for apply", () => {
    expect(() => legacyPaidEntitlementProposalConfirmation(["--apply"], true))
      .toThrow("--apply requires --confirm-batch-proposal-hash");
    expect(legacyPaidEntitlementProposalConfirmation([
      `--confirm-batch-proposal-hash=${"a".repeat(64)}`,
    ], true)).toBe("a".repeat(64));
  });

  it("rejects malformed, duplicate, or dry-run confirmation hashes", () => {
    expect(() => legacyPaidEntitlementProposalConfirmation([
      "--confirm-batch-proposal-hash=short",
    ], true)).toThrow("complete SHA-256");
    expect(() => legacyPaidEntitlementProposalConfirmation([
      `--confirm-batch-proposal-hash=${"a".repeat(64)}`,
      `--confirm-batch-proposal-hash=${"b".repeat(64)}`,
    ], true)).toThrow("provided only once");
    expect(() => legacyPaidEntitlementProposalConfirmation([
      `--confirm-batch-proposal-hash=${"a".repeat(64)}`,
    ], false)).toThrow("accepted only with --apply");
  });
});
