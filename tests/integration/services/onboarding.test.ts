import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { OnboardingService } from "@/services/onboarding.service";
import { resetDatabase, disconnectDatabase, testPrisma } from "@/tests/setup/db";
import { createUser } from "@/tests/factories";

/**
 * INTEGRATION TESTS: OnboardingService
 *
 * Uses REAL test database.
 * Covers:
 * 1. createNetwork — atomically creates org + branch
 * 2. Default shifts are created
 * 3. Seats are created when seatCount supplied
 * 4. User is added as MANAGER on the branch
 * 5. Calling twice creates 2 independent networks (documents no-idempotency contract)
 */

describe("OnboardingService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => {
    vi.stubEnv("WORKSPACE_BRANCH_BILLING_V2_ENABLED", "true");
    await resetDatabase();
  });
  afterEach(() => vi.unstubAllEnvs());

  const baseParams = (userId: string) => ({
    userId,
    selectedPostTrialPlan: "BASIC" as const,
    ownerPhone: "9876543210",
    orgData: { name: "Bright Academy" },
    branchData: { name: "Main Hall", city: "Delhi", defaultFee: 1200 },
  });

  // ─── createNetwork ────────────────────────────────────────────────────────

  describe("createNetwork", () => {
    it("rejects creation while V2 onboarding is held without writing a legacy workspace", async () => {
      const user = await createUser();
      vi.stubEnv("WORKSPACE_BRANCH_BILLING_V2_ENABLED", "false");
      await expect(OnboardingService.createNetwork(baseParams(user.id))).rejects.toThrow(/temporarily unavailable/i);
      expect(await testPrisma.organization.count()).toBe(0);
      expect(await testPrisma.branch.count()).toBe(0);
    });

    it("creates org and branch atomically — correct ownership chain", async () => {
      const user = await createUser();
      const { org, branch } = await OnboardingService.createNetwork(baseParams(user.id));

      expect(org.ownerId).toBe(user.id);
      expect(branch.organizationId).toBe(org.id);
      expect(org.name).toBe("Bright Academy");
      expect(org.selectedPostTrialPlan).toBe("BASIC");
      expect(org.billingModelVersion).toBe("WORKSPACE_V2");
      const trial = await testPrisma.ownerTrialGrant.findUnique({ where: { ownerId: user.id } });
      expect(trial?.organizationId).toBe(org.id);
      expect(trial?.status).toBe("ACTIVE");
      expect(branch.name).toBe("Main Hall");
      expect(org.contactPhone).toBe("+91 98765 43210");
      expect(branch.contactPhone).toBe("+91 98765 43210");
      await expect(testPrisma.user.findUnique({ where: { id: user.id }, select: { phone: true } })).resolves.toEqual({
        phone: "+91 98765 43210",
      });
    });

    it("requires an owner phone", async () => {
      const user = await createUser();
      await expect(
        OnboardingService.createNetwork({
          ...baseParams(user.id),
          ownerPhone: "",
        })
      ).rejects.toThrow(/owner phone is required/i);
    });

    it("rejects a manipulated or legacy post-trial plan", async () => {
      const user = await createUser();
      await expect(OnboardingService.createNetwork({
        ...baseParams(user.id),
        selectedPostTrialPlan: "AGENT_CONTROL" as "BASIC",
      })).rejects.toThrow("Choose Basic or Standard");

      expect(await testPrisma.organization.count({ where: { ownerId: user.id } })).toBe(0);
    });

    it("creates default shifts on the new branch", async () => {
      const user = await createUser();
      const { branch } = await OnboardingService.createNetwork(baseParams(user.id));

      const shifts = await testPrisma.shift.findMany({
        where: { branchId: branch.id },
        orderBy: { startTime: "asc" },
      });
      expect(shifts.map(shift => ({
        name: shift.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
      }))).toEqual([
        { name: "Morning", startTime: "06:00", endTime: "09:59" },
        { name: "Afternoon", startTime: "10:00", endTime: "15:59" },
        { name: "Evening", startTime: "16:00", endTime: "21:59" },
      ]);

      const fullTime = await testPrisma.multiShift.findUnique({
        where: { branchId_name: { branchId: branch.id, name: "Full Time" } },
        include: { components: { include: { shift: true }, orderBy: { order: "asc" } } },
      });
      expect(fullTime?.components.map(component => component.shift.name)).toEqual(["Morning", "Afternoon", "Evening"]);
    });

    it("skips the default Full Time multi-shift when disabled", async () => {
      const user = await createUser();
      const { branch } = await OnboardingService.createNetwork({
        ...baseParams(user.id),
        includeFullTimeMultiShift: false,
      });

      const fullTimeCount = await testPrisma.multiShift.count({
        where: { branchId: branch.id, name: "Full Time" },
      });
      expect(fullTimeCount).toBe(0);
    });

    it("creates correct number of seats when seatCount is supplied", async () => {
      const user = await createUser();
      const { branch } = await OnboardingService.createNetwork({
        ...baseParams(user.id),
        seatCount: 10,
      });

      const seatCount = await testPrisma.seat.count({ where: { branchId: branch.id } });
      expect(seatCount).toBe(10);
    });

    it("creates custom numbered seats when seatNumbering is supplied", async () => {
      const user = await createUser();
      const { branch } = await OnboardingService.createNetwork({
        ...baseParams(user.id),
        seatCount: 4,
        seatNumbering: {
          mode: "RANGE",
          ranges: [
            { prefix: "A", start: 1, end: 2, separator: "" },
            { prefix: "B", start: 1, end: 2, separator: "" },
          ],
        },
      });

      const seats = await testPrisma.seat.findMany({ where: { branchId: branch.id } });
      expect(seats.map(seat => seat.label).sort()).toEqual(["A1", "A2", "B1", "B2"]);
    });

    it("adds the user as MANAGER on the new branch", async () => {
      const user = await createUser();
      const { branch } = await OnboardingService.createNetwork(baseParams(user.id));

      const staffRecord = await testPrisma.staff.findFirst({
        where: { userId: user.id, branchId: branch.id },
      });
      expect(staffRecord).not.toBeNull();
      expect(staffRecord!.role).toBe("MANAGER");
    });

    it("calling twice creates 2 separate networks — no dedup (expected contract)", async () => {
      /**
       * OnboardingService.createNetwork has NO idempotency guard.
       * Calling it twice for the same user produces two distinct orgs + branches.
       * This test documents that contract explicitly.
       * If idempotency is ever added to the service, this test should be updated first.
       */
      const user = await createUser();
      const result1 = await OnboardingService.createNetwork(baseParams(user.id));
      const result2 = await OnboardingService.createNetwork(baseParams(user.id));

      // Two separate org + branch pairs must exist
      expect(result1.org.id).not.toBe(result2.org.id);
      expect(result1.branch.id).not.toBe(result2.branch.id);

      const orgCount = await testPrisma.organization.count({ where: { ownerId: user.id } });
      expect(orgCount).toBe(2);
    });

    it("creates custom shifts when shifts array is supplied", async () => {
      const user = await createUser();
      const { branch } = await OnboardingService.createNetwork({
        ...baseParams(user.id),
        shifts: [
          { name: "Custom Morning", startTime: "07:00", endTime: "12:00", price: 800 },
          { name: "Custom Evening", startTime: "16:00", endTime: "21:00", price: 1000 },
        ],
      });

      const shifts = await testPrisma.shift.findMany({ where: { branchId: branch.id } });
      expect(shifts).toHaveLength(2);
      expect(shifts.map(s => s.name)).toContain("Custom Morning");
      expect(shifts.map(s => s.name)).toContain("Custom Evening");
    });

    it("creates editable multi-shift bundles from selected onboarding primary shifts", async () => {
      const user = await createUser();
      const { branch } = await OnboardingService.createNetwork({
        ...baseParams(user.id),
        shifts: [
          { name: "Morning", startTime: "06:00", endTime: "09:59", price: 800 },
          { name: "Midday", startTime: "10:00", endTime: "13:59", price: 900 },
          { name: "Afternoon", startTime: "14:00", endTime: "17:59", price: 1000 },
          { name: "Evening", startTime: "18:00", endTime: "21:59", price: 1100 },
        ],
        multiShifts: [
          { name: "Day Pass", price: 1700, componentShiftNames: ["Morning", "Midday"] },
          { name: "Full Day", price: 3600, componentShiftNames: ["Morning", "Midday", "Afternoon", "Evening"] },
        ],
      });

      const multiShifts = await testPrisma.multiShift.findMany({
        where: { branchId: branch.id },
        include: { components: { include: { shift: true }, orderBy: { order: "asc" } } },
        orderBy: { name: "asc" },
      });

      expect(multiShifts).toHaveLength(2);
      expect(multiShifts.map(multiShift => ({
        name: multiShift.name,
        price: multiShift.price,
        components: multiShift.components.map(component => component.shift.name),
      }))).toEqual([
        { name: "Day Pass", price: 1700, components: ["Morning", "Midday"] },
        { name: "Full Day", price: 3600, components: ["Morning", "Midday", "Afternoon", "Evening"] },
      ]);
    });
  });
});
