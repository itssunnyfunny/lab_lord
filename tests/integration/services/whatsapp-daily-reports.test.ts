import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { scheduleWhatsAppReportForLocalDate } from "@/lib/whatsappSchedule";
import { loadOrCreateWhatsAppReportSnapshotInTransaction } from "@/services/whatsappReport.service";
import { createBranch, createOrg, createUser } from "@/tests/factories";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

describe("WhatsApp daily report snapshot identity", () => {
  beforeEach(resetDatabase);
  afterAll(disconnectDatabase);

  it("shares a same-cutoff snapshot and persists distinct snapshots for distinct cutoffs", async () => {
    const owner = await createUser({ id: "daily-report-snapshot-owner" });
    const organization = await createOrg({
      id: "daily-report-snapshot-org",
      ownerId: owner.id,
      name: "Daily Report Snapshot Org",
    });
    const branch = await createBranch({
      id: "daily-report-snapshot-branch",
      organizationId: organization.id,
      name: "Daily Report Snapshot Branch",
    });
    const sender = await testPrisma.whatsAppSender.create({
      data: {
        organizationId: organization.id,
        provider: "META_CLOUD",
        providerMode: "TEST",
        wabaId: "daily-report-snapshot-waba",
        phoneNumberId: "daily-report-snapshot-phone",
        displayPhoneNumber: "+91 98765 43210",
        status: "ACTIVE",
      },
    });
    const subscribers = await Promise.all([
      owner,
      await createUser({ id: "daily-report-snapshot-staff-one" }),
      await createUser({ id: "daily-report-snapshot-staff-two" }),
    ].map(async (user, index) => {
      const phoneE164 = `+9198765432${10 + index}`;
      const consent = await testPrisma.whatsAppConsent.create({
        data: {
          senderId: sender.id,
          phoneE164,
          consentType: "OWNER_REPORT",
          status: "OPTED_IN",
          source: "OWNER_CONFIGURATION",
          policyVersion: "owner-report-v1",
          grantedAt: new Date("2026-08-20T10:00:00.000Z"),
          recordedByUserId: user.id,
        },
      });
      return testPrisma.whatsAppReportSubscription.create({
        data: {
          organizationId: organization.id,
          branchId: branch.id,
          scope: "BRANCH",
          scopeKey: branch.id,
          senderId: sender.id,
          userId: user.id,
          consentId: consent.id,
          phoneE164,
          language: "en_IN",
          sendTimeLocal: index < 2 ? "21:00" : "21:30",
          status: "ACTIVE",
          activatedAt: new Date("2026-08-20T10:00:00.000Z"),
        },
      });
    }));
    const scope = {
      scope: "BRANCH" as const,
      scopeKey: branch.id,
      branchId: branch.id,
      organizationId: organization.id,
      timeZone: "Asia/Kolkata",
      ownerId: owner.id,
    };
    const localReportDate = "2026-08-23";
    const reportDate = { year: 2026, month: 8, day: 23 };
    const firstCutoff = scheduleWhatsAppReportForLocalDate({
      localDate: reportDate,
      sendTimeLocal: subscribers[0].sendTimeLocal,
      timeZone: scope.timeZone,
    });
    const firstMetricsAsOf = new Date("2026-08-23T15:35:00.000Z");
    const laterSameCutoffAsOf = new Date("2026-08-23T15:40:00.000Z");
    const sameCutoff = scheduleWhatsAppReportForLocalDate({
      localDate: reportDate,
      sendTimeLocal: subscribers[1].sendTimeLocal,
      timeZone: scope.timeZone,
    });
    const secondCutoff = scheduleWhatsAppReportForLocalDate({
      localDate: reportDate,
      sendTimeLocal: subscribers[2].sendTimeLocal,
      timeZone: scope.timeZone,
    });
    const secondMetricsAsOf = new Date("2026-08-23T16:05:00.000Z");

    const first = await testPrisma.$transaction(tx =>
      loadOrCreateWhatsAppReportSnapshotInTransaction({
        tx,
        scope,
        localReportDate,
        scheduledCutoffAt: firstCutoff,
        metricsAsOfAt: firstMetricsAsOf,
      })
    );
    const shared = await testPrisma.$transaction(tx =>
      loadOrCreateWhatsAppReportSnapshotInTransaction({
        tx,
        scope,
        localReportDate,
        scheduledCutoffAt: sameCutoff,
        metricsAsOfAt: laterSameCutoffAsOf,
      })
    );
    const differentCutoff = await testPrisma.$transaction(tx =>
      loadOrCreateWhatsAppReportSnapshotInTransaction({
        tx,
        scope,
        localReportDate,
        scheduledCutoffAt: secondCutoff,
        metricsAsOfAt: secondMetricsAsOf,
      })
    );

    expect(sameCutoff).toEqual(firstCutoff);
    expect(shared.snapshot.id).toBe(first.snapshot.id);
    expect(shared.snapshot.metricsAsOfAt).toEqual(firstMetricsAsOf);
    expect(shared.metrics.metricsAsOfAt).toBe(firstMetricsAsOf.toISOString());
    expect(differentCutoff.snapshot.id).not.toBe(first.snapshot.id);
    expect(differentCutoff.snapshot.metricsAsOfAt).toEqual(secondMetricsAsOf);
    expect(differentCutoff.metrics.metricsAsOfAt).toBe(secondMetricsAsOf.toISOString());

    const persisted = await testPrisma.whatsAppDailyReportSnapshot.findMany({
      where: {
        scope: "BRANCH",
        scopeKey: branch.id,
        localReportDate,
      },
      orderBy: { scheduledCutoffAt: "asc" },
    });
    expect(persisted).toHaveLength(2);
    expect(persisted.map(snapshot => ({
      scheduledCutoffAt: snapshot.scheduledCutoffAt.toISOString(),
      metricsAsOfAt: snapshot.metricsAsOfAt.toISOString(),
      generatedAt: snapshot.generatedAt.toISOString(),
    }))).toEqual([
      {
        scheduledCutoffAt: firstCutoff.toISOString(),
        metricsAsOfAt: firstMetricsAsOf.toISOString(),
        generatedAt: firstMetricsAsOf.toISOString(),
      },
      {
        scheduledCutoffAt: secondCutoff.toISOString(),
        metricsAsOfAt: secondMetricsAsOf.toISOString(),
        generatedAt: secondMetricsAsOf.toISOString(),
      },
    ]);
  });
});
