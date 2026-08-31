import { describe, expect, it } from "vitest";

import {
  canonicalizeWhatsAppReportMetrics,
  createWhatsAppReportSourceFingerprint,
  hashWhatsAppReportMetrics,
  WhatsAppBranchReportMetricsSchema,
  WhatsAppOrganizationReportMetricsSchema,
} from "@/lib/whatsappReportMetrics";

const common = {
  localReportDate: "2026-08-23",
  metricsAsOfAt: "2026-08-23T15:45:00.000Z",
  asOfLocalTime: "21:15",
  paymentsRecordedTodayCount: 3,
  paymentsRecordedTodayAmount: 12_000,
  newStudentsToday: 2,
  activeStudents: 50,
  usedShiftSlots: 40,
  totalShiftCapacity: 60,
  openDueCount: 5,
  openDueAmount: 7_500,
  overdueCount: 2,
  overdueAmount: 3_000,
  whatsAppAcceptedToday: 8,
  whatsAppDeliveredToday: 7,
  whatsAppFailedToday: 1,
  whatsAppUnknownToday: 0,
};

describe("WhatsApp report metric contracts", () => {
  it("accepts only aggregate branch and organization metrics", () => {
    expect(WhatsAppBranchReportMetricsSchema.parse({ branchName: "Central", ...common }))
      .toEqual({ branchName: "Central", ...common });
    expect(WhatsAppOrganizationReportMetricsSchema.parse({
      organizationName: "Lab Lords",
      branchCount: 2,
      ...common,
    }).branchCount).toBe(2);
    expect(() => WhatsAppBranchReportMetricsSchema.parse({
      branchName: "Central",
      studentName: "Direct identity is forbidden",
      ...common,
    })).toThrow();
    expect(() => WhatsAppBranchReportMetricsSchema.parse({
      branchName: "Central",
      ...common,
      metricsAsOfAt: "2026-08-23T21:15:00+05:30",
    })).toThrow("canonical UTC");
  });

  it("rejects internally inconsistent aggregates", () => {
    expect(() => WhatsAppBranchReportMetricsSchema.parse({
      branchName: "Central",
      ...common,
      usedShiftSlots: 61,
    })).toThrow("Used shift slots");
    expect(() => WhatsAppOrganizationReportMetricsSchema.parse({
      organizationName: "Lab Lords",
      branchCount: 2,
      ...common,
      overdueAmount: common.openDueAmount + 1,
    })).toThrow("Overdue totals");
  });

  it("hashes canonical metrics independently of object key order", () => {
    const first = { branchName: "Central", ...common };
    const second = Object.fromEntries(Object.entries(first).reverse());
    expect(canonicalizeWhatsAppReportMetrics(second)).toEqual(first);
    expect(hashWhatsAppReportMetrics(first)).toBe(hashWhatsAppReportMetrics(second));
    expect(hashWhatsAppReportMetrics(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds source fingerprints to scope, date, cutoff, metrics as-of, and version", () => {
    const base = {
      scope: "BRANCH" as const,
      scopeKey: "branch_1",
      localReportDate: "2026-08-23",
      scheduledCutoffAt: new Date("2026-08-23T15:30:00.000Z"),
      metricsAsOfAt: new Date("2026-08-23T15:45:00.000Z"),
    };
    const fingerprint = createWhatsAppReportSourceFingerprint(base);
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(createWhatsAppReportSourceFingerprint(base)).toBe(fingerprint);
    expect(createWhatsAppReportSourceFingerprint({
      ...base,
      scheduledCutoffAt: new Date("2026-08-23T15:31:00.000Z"),
    })).not.toBe(fingerprint);
    expect(createWhatsAppReportSourceFingerprint({
      ...base,
      metricsAsOfAt: new Date("2026-08-23T15:46:00.000Z"),
    })).not.toBe(fingerprint);
    expect(createWhatsAppReportSourceFingerprint({
      ...base,
      metricsVersion: 1,
    })).not.toBe(fingerprint);
  });
});
