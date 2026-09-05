import { describe, expect, it } from "vitest";
import { validateShiftDrafts } from "@/lib/formValidation";
import { normalizeImportRow, parsePaymentMethod } from "@/importing/utils/row-normalizer";
import { validateImportPayment } from "@/importing/validators/import-payment.validator";

describe("full-day and payment input boundaries", () => {
  it.each([[null, null], ["00:00", "00:00"]])("rejects overlapping full-day creation %s/%s", (startTime, endTime) => {
    expect(validateShiftDrafts([{ name: "All day", startTime, endTime, price: 100 },
      { name: "Morning", startTime: "06:00", endTime: "10:00", price: 100 }]).ok).toBe(false);
    expect(validateShiftDrafts([{ name: "All day", startTime, endTime, price: 100 }]).ok).toBe(true);
  });
  it.each(["cashless", "not cash", "bankruptcy", "cheque", "UPI maybe"])("reports unsupported explicit method %s", method => {
    expect(parsePaymentMethod(method)).toBeUndefined();
    const result = normalizeImportRow({ Method: method }, [{ sourceColumn: "Method", targetField: "payment.method", confidence: 100 }]);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "INVALID_PAYMENT_METHOD", severity: "error" }));
    const checked = validateImportPayment({ payment: { method } } as never,
      { columnMappings: [], entityTypesDetected: [] } as never);
    expect(checked.issues).toContainEqual(expect.objectContaining({ code: "INVALID_PAYMENT_METHOD", severity: "error" }));
  });
  it.each([["BANK_TRANSFER", "BANK_TRANSFER"], ["Google Pay", "UPI"], [" Cash ", "CASH"]])("supports exact alias %s", (value, method) => {
    expect(parsePaymentMethod(value)).toBe(method);
  });
});
