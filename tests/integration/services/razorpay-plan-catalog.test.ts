import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  setRazorpayClientForTests,
  type RazorpayPlan,
  type RazorpayPlanCatalogApiClient,
} from "@/lib/razorpay";
import { ensureRazorpayPlanCatalogEntry } from "@/services/razorpayPlanCatalog.service";
import { disconnectDatabase, resetDatabase, testPrisma } from "@/tests/setup/db";

const basicDefinition = {
  plan: "BASIC" as const,
  name: "Lab Lords Basic Monthly",
  amount: 299,
  currency: "INR",
  period: "monthly",
  interval: 1,
};

function fakeRazorpay(): RazorpayPlanCatalogApiClient {
  let created = 0;
  const providerPlans = new Map<string, RazorpayPlan>();
  return {
    createOrder: vi.fn(async () => { throw new Error("unused"); }),
    fetchPayment: vi.fn(async () => { throw new Error("unused"); }),
    fetchOrderPayments: vi.fn(async () => { throw new Error("unused"); }),
    capturePayment: vi.fn(async () => { throw new Error("unused"); }),
    createPlan: vi.fn(async input => {
      created += 1;
      const plan: RazorpayPlan = {
        id: `plan_catalog_${created}`,
        entity: "plan",
        period: input.period,
        interval: input.interval,
        item: input.item,
        notes: input.notes,
      };
      providerPlans.set(plan.id, plan);
      return plan;
    }),
    fetchPlan: vi.fn(async planId => {
      const plan = providerPlans.get(planId);
      if (!plan) throw new Error(`Provider plan ${planId} was not created`);
      return plan;
    }),
    listPlans: vi.fn(async () => ({
      entity: "collection" as const,
      count: providerPlans.size,
      items: [...providerPlans.values()],
    })),
    createSubscription: vi.fn(async () => { throw new Error("unused"); }),
    fetchSubscription: vi.fn(async () => { throw new Error("unused"); }),
    updateSubscription: vi.fn(async () => { throw new Error("unused"); }),
    cancelScheduledChanges: vi.fn(async () => { throw new Error("unused"); }),
    fetchSubscriptionInvoices: vi.fn(async () => { throw new Error("unused"); }),
    cancelSubscription: vi.fn(async () => { throw new Error("unused"); }),
  };
}

describe("Razorpay plan catalog persistence", () => {
  beforeEach(async () => {
    await resetDatabase();
    vi.stubEnv("RAZORPAY_MODE", "TEST");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_test_catalog");
    vi.stubEnv("VERCEL_ENV", "preview");
  });

  afterEach(() => {
    setRazorpayClientForTests(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await disconnectDatabase();
  });

  it("persists a ready Test catalog entry after provider creation", async () => {
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);

    const mapping = await ensureRazorpayPlanCatalogEntry(basicDefinition);

    expect(mapping).toMatchObject({
      providerMode: "TEST",
      plan: "BASIC",
      amountSubunits: 29_900,
      razorpayPlanId: "plan_catalog_1",
      active: true,
    });
    await expect(testPrisma.razorpayPlanProvisioning.findUnique({
      where: { catalogKey: mapping.catalogKey },
    })).resolves.toMatchObject({
      providerMode: "TEST",
      status: "READY",
      attemptCount: 1,
      razorpayPlanId: "plan_catalog_1",
      leaseToken: null,
      leaseUntil: null,
    });
  });

  it("stores Test and Live catalog entries independently", async () => {
    const razorpay = fakeRazorpay();
    setRazorpayClientForTests(razorpay);
    const testMapping = await ensureRazorpayPlanCatalogEntry(basicDefinition);

    vi.stubEnv("RAZORPAY_MODE", "LIVE");
    vi.stubEnv("RAZORPAY_KEY_ID", "rzp_live_catalog");
    vi.stubEnv("VERCEL_ENV", "production");
    const liveMapping = await ensureRazorpayPlanCatalogEntry(basicDefinition);

    expect(testMapping.catalogKey).not.toBe(liveMapping.catalogKey);
    expect(liveMapping.providerMode).toBe("LIVE");
    await expect(testPrisma.saasRazorpayPlan.findMany({
      where: { plan: "BASIC", active: true },
      orderBy: { providerMode: "asc" },
    })).resolves.toMatchObject([
      { providerMode: "TEST", razorpayPlanId: "plan_catalog_1" },
      { providerMode: "LIVE", razorpayPlanId: "plan_catalog_2" },
    ]);
  });

  it("serializes active mapping swaps across concurrent price catalog keys", async () => {
    const razorpay = fakeRazorpay();
    let started = 0;
    let releaseBoth!: () => void;
    const bothProviderPlansStarted = new Promise<void>(resolve => {
      releaseBoth = resolve;
    });
    vi.mocked(razorpay.createPlan).mockImplementation(async input => {
      started += 1;
      if (started === 2) releaseBoth();
      await bothProviderPlansStarted;
      return {
        id: `plan_concurrent_${input.item.amount}`,
        entity: "plan",
        period: input.period,
        interval: input.interval,
        item: input.item,
        notes: input.notes,
      };
    });
    setRazorpayClientForTests(razorpay);

    const replacementDefinition = { ...basicDefinition, amount: 399 };
    const [first, replacement] = await Promise.all([
      ensureRazorpayPlanCatalogEntry(basicDefinition),
      ensureRazorpayPlanCatalogEntry(replacementDefinition),
    ]);

    expect(first.catalogKey).not.toBe(replacement.catalogKey);
    expect(razorpay.createPlan).toHaveBeenCalledTimes(2);
    const mappings = await testPrisma.saasRazorpayPlan.findMany({
      where: { providerMode: "TEST", plan: "BASIC" },
      orderBy: { amountSubunits: "asc" },
    });
    expect(mappings).toHaveLength(2);
    expect(mappings.filter(mapping => mapping.active)).toHaveLength(1);
  });

  it("has one database-resident rollout identity and a partial active-plan constraint", async () => {
    await expect(testPrisma.billingDatabaseIdentity.findMany())
      .resolves.toMatchObject([{ id: 1 }]);

    const indexes = await testPrisma.$queryRaw<Array<{ indexDefinition: string }>>`
      SELECT indexdef AS "indexDefinition"
      FROM pg_indexes
      WHERE schemaname = current_schema()
        AND indexname = 'SaasRazorpayPlan_one_active_per_mode_plan_key'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.indexDefinition).toMatch(/UNIQUE.+WHERE \(active = true\)/i);
  });
});
