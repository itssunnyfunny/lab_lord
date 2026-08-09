import { describe, expect, it, vi } from "vitest";
import {
  isBillingOperationTerminal,
  preferProviderConfirmedOperation,
  reconcileWithCooldown,
  type ProcessingReconcileGate,
} from "@/app/org/[orgId]/billing/processing/[changeId]/page";
import type { BillingOperationDto } from "@/lib/api/billing";

function operation(
  operationStatus: BillingOperationDto["operationStatus"]
): BillingOperationDto {
  return {
    id: "change_123",
    organizationId: "org_123",
    type: "SUBSCRIPTION_AUTHORIZATION",
    queueStatus: operationStatus === "APPLIED" ? "APPLIED" : "AWAITING_PAYMENT",
    operationStatus,
    returnPath: "/org/org_123/settings#billing",
    confirmationDeadlineAt: null,
    failureCategory: null,
    failureCode: null,
    providerPaymentId: null,
    message: null,
    effectiveAt: null,
    createdAt: "2026-08-07T10:00:00.000Z",
    updatedAt: "2026-08-07T10:00:00.000Z",
  };
}

function gate(): ProcessingReconcileGate {
  return { key: "", nextAllowedAt: 0, inFlight: null };
}

describe("billing processing reconciliation", () => {
  it("keeps provider-confirmed success when a stale failure arrives later", () => {
    const applied = operation("APPLIED");
    const failed = operation("FAILED");

    expect(preferProviderConfirmedOperation(failed, applied)).toBe(applied);
    expect(preferProviderConfirmedOperation(applied, failed)).toBe(applied);
  });

  it("treats all success and failure outcomes as terminal", () => {
    expect(["APPLIED", "SCHEDULED", "ABANDONED", "DECLINED", "FAILED"]
      .every(status => isBillingOperationTerminal(status as BillingOperationDto["operationStatus"])))
      .toBe(true);
    expect(isBillingOperationTerminal("VERIFYING")).toBe(false);
    expect(isBillingOperationTerminal("AWAITING_PROVIDER_CONFIRMATION")).toBe(false);
  });

  it("does not let a stale verifying response replace a terminal decline", () => {
    const declined = operation("DECLINED");
    const verifying = operation("VERIFYING");

    expect(preferProviderConfirmedOperation(declined, verifying)).toBe(declined);
    expect(preferProviderConfirmedOperation(declined, operation("APPLIED")).operationStatus).toBe("APPLIED");
  });

  it("limits reconciliation to one request per ten-second window", async () => {
    const reconcile = vi.fn().mockResolvedValue(undefined);
    const state = gate();

    await reconcileWithCooldown(state, "org_123:change_123", reconcile, 1_000);
    await reconcileWithCooldown(state, "org_123:change_123", reconcile, 5_000);
    await reconcileWithCooldown(state, "org_123:change_123", reconcile, 11_000);

    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight reconciliation instead of starting a duplicate", async () => {
    let complete: (() => void) | undefined;
    const reconcile = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
    const state = gate();

    const first = reconcileWithCooldown(state, "org_123:change_123", reconcile, 1_000);
    const duplicate = reconcileWithCooldown(state, "org_123:change_123", reconcile, 1_000);
    await Promise.resolve();

    expect(reconcile).toHaveBeenCalledOnce();
    complete?.();
    await Promise.all([first, duplicate]);
  });
});
