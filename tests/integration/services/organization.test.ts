import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { OrganizationService } from "@/services/organization.service";
import { resetDatabase, disconnectDatabase } from "@/tests/setup/db";
import { createUser, createOrg, createBranch } from "@/tests/factories";
import { OrganizationAccessNotFoundError } from "@/lib/organizationErrors";

/**
 * INTEGRATION TESTS: OrganizationService
 *
 * Uses REAL test database.
 * Covers:
 * Organization creation is covered by canonical onboarding tests.
 * 2. getOrganizationsByUserId — scoped per user
 * 3. getOrganizationById — includes branches
 * 4. updateOrganization — name change, non-owner throws
 * 5. isOwner — true for owner, false for stranger
 */

describe("OrganizationService Integration", () => {
  afterAll(async () => { await disconnectDatabase(); });
  beforeEach(async () => { await resetDatabase(); });

  describe("getOrganizationForOwnerAccess", () => {
    it("returns the complete organization view to its owner", async () => {
      const owner = await createUser();
      const org = await createOrg({ ownerId: owner.id });
      await createBranch({ organizationId: org.id, name: "Owned Branch" });

      const found = await OrganizationService.getOrganizationForOwnerAccess(org.id, owner.id);

      expect(found.id).toBe(org.id);
      expect(found.branches).toHaveLength(1);
    });

    it("makes foreign and nonexistent organizations indistinguishable", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const org = await createOrg({ ownerId: owner.id });

      const [foreign, missing] = await Promise.all([
        OrganizationService.getOrganizationForOwnerAccess(org.id, stranger.id).catch(error => error),
        OrganizationService.getOrganizationForOwnerAccess("org_missing", stranger.id).catch(error => error),
      ]);

      expect(foreign).toBeInstanceOf(OrganizationAccessNotFoundError);
      expect(missing).toBeInstanceOf(OrganizationAccessNotFoundError);
      expect({ name: foreign.name, code: foreign.code, message: foreign.message }).toEqual({
        name: missing.name,
        code: missing.code,
        message: missing.message,
      });
    });
  });

  // ─── getOrganizationsByUserId ──────────────────────────────────────────────

  describe("getOrganizationsByUserId", () => {
    it("returns only orgs belonging to the requesting user", async () => {
      const user1 = await createUser();
      const user2 = await createUser();
      await createOrg({ ownerId: user1.id, name: "Org A" });
      await createOrg({ ownerId: user2.id, name: "Org B" });

      const orgs = await OrganizationService.getOrganizationsByUserId(user1.id);
      expect(orgs).toHaveLength(1);
      expect(orgs[0].name).toBe("Org A");
    });

    it("returns empty array when user has no orgs", async () => {
      const user = await createUser();
      const orgs = await OrganizationService.getOrganizationsByUserId(user.id);
      expect(orgs).toHaveLength(0);
    });
  });

  // ─── getOrganizationById ──────────────────────────────────────────────────

  describe("getOrganizationForOwnerAccess", () => {
    it("returns org with branches included", async () => {
      const user = await createUser();
      const org = await createOrg({ ownerId: user.id });
      await createBranch({ organizationId: org.id, name: "Branch One" });

      const found = await OrganizationService.getOrganizationForOwnerAccess(org.id, user.id);
      expect(found).not.toBeNull();
      expect(found!.branches).toHaveLength(1);
      expect(found!.branches[0].name).toBe("Branch One");
    });

    it("returns the same safe error for unknown and foreign organizations", async () => {
      const user = await createUser();
      const foreignOwner = await createUser();
      const foreign = await createOrg({ ownerId: foreignOwner.id });
      for (const id of ["nonexistent", foreign.id]) {
        await expect(OrganizationService.getOrganizationForOwnerAccess(id, user.id))
          .rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
      }
    });
  });

  // ─── updateOrganization ───────────────────────────────────────────────────

  describe("updateOrganization", () => {
    it("updates org name successfully", async () => {
      const user = await createUser();
      const org = await createOrg({ ownerId: user.id });

      const updated = await OrganizationService.updateOrganization(org.id, user.id, {
        name: "Renamed Academy",
      });

      expect(updated.name).toBe("Renamed Academy");
    });

    it("rejects foreign and nonexistent updates identically", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const org = await createOrg({ ownerId: owner.id });

      const [foreign, missing] = await Promise.all([
        OrganizationService.updateOrganization(org.id, stranger.id, { name: "Hijacked" })
          .catch(error => error),
        OrganizationService.updateOrganization("org_missing", stranger.id, { name: "Hijacked" })
          .catch(error => error),
      ]);

      expect(foreign).toBeInstanceOf(OrganizationAccessNotFoundError);
      expect(missing).toBeInstanceOf(OrganizationAccessNotFoundError);
      expect({ name: foreign.name, code: foreign.code, message: foreign.message }).toEqual({
        name: missing.name,
        code: missing.code,
        message: missing.message,
      });
    });

    it("updates persisted organization settings", async () => {
      const user = await createUser();
      const org = await createOrg({ ownerId: user.id });

      const updated = await OrganizationService.updateSettings(org.id, user.id, {
        name: "Settings Academy",
        businessType: "Library",
        legalName: "Settings Academy Pvt Ltd",
        contactEmail: "owner@example.com",
        contactPhone: "9999999999",
        address: "MG Road, Delhi",
        timezone: "Asia/Kolkata",
        currency: "inr",
        weekStartsOn: 1,
        paymentGraceDays: 5,
      });

      expect(updated.name).toBe("Settings Academy");
      expect(updated.legalName).toBe("Settings Academy Pvt Ltd");
      expect(updated.contactEmail).toBe("owner@example.com");
      expect(updated.contactPhone).toBe("+91 99999 99999");
      expect(updated.currency).toBe("INR");
      expect(updated.paymentGraceDays).toBe(5);
    });

    it("rejects invalid organization settings", async () => {
      const user = await createUser();
      const org = await createOrg({ ownerId: user.id });

      await expect(
        OrganizationService.updateSettings(org.id, user.id, {
          name: "Valid",
          unknownField: true,
        })
      ).rejects.toThrow(/Unknown settings field/i);

      await expect(
        OrganizationService.updateSettings(org.id, user.id, {
          name: "",
        })
      ).rejects.toThrow(/required/i);

      await expect(
        OrganizationService.updateSettings(org.id, user.id, {
          name: "Valid",
          paymentGraceDays: false as unknown as number,
        })
      ).rejects.toThrow(/whole number/i);

      await expect(
        OrganizationService.updateSettings(org.id, user.id, {
          name: "Valid",
          contactPhone: "",
        })
      ).rejects.toThrow(/contact phone is required/i);

      await expect(
        OrganizationService.updateSettings(org.id, user.id, {
          name: "Valid",
          contactPhone: "12345",
        })
      ).rejects.toThrow(/valid Indian mobile/i);
    });
  });

  // ─── isOwner ─────────────────────────────────────────────────────────────

  describe("isOwner", () => {
    it("returns true for the actual owner", async () => {
      const user = await createUser();
      const org = await createOrg({ ownerId: user.id });

      const result = await OrganizationService.isOwner(org.id, user.id);
      expect(result).toBe(true);
    });

    it("returns false for a stranger", async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const org = await createOrg({ ownerId: owner.id });

      const result = await OrganizationService.isOwner(org.id, stranger.id);
      expect(result).toBe(false);
    });
  });
});
