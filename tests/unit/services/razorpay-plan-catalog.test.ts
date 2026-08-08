import { describe, expect, it, vi } from "vitest";

import {
  RazorpayApiError,
  type RazorpayPlan,
  type RazorpayPlanCatalogApiClient,
} from "@/lib/razorpay";
import {
  ensureRazorpayPlanCatalogEntry,
  razorpayPlanCatalogKey,
  type RazorpayPlanCatalogEntry,
  type RazorpayPlanCatalogStore,
} from "@/services/razorpayPlanCatalog.service";

const basicDefinition = {
  plan: "BASIC" as const,
  name: "Lab Lords Basic Monthly",
  description: "Basic per-branch subscription",
  amount: 299,
  currency: "INR",
  period: "monthly",
  interval: 1,
};

function providerPlan(id: string, catalogKey?: string): RazorpayPlan {
  return {
    id,
    entity: "plan" as const,
    interval: 1,
    period: "monthly",
    item: { amount: 29_900, currency: "INR", name: basicDefinition.name },
    notes: catalogKey ? { catalog_key: catalogKey } : null,
  };
}

function fakeRazorpay(): RazorpayPlanCatalogApiClient {
  return {
    createOrder: vi.fn(async () => { throw new Error("unused"); }),
    fetchPayment: vi.fn(async () => { throw new Error("unused"); }),
    fetchOrderPayments: vi.fn(async () => { throw new Error("unused"); }),
    capturePayment: vi.fn(async () => { throw new Error("unused"); }),
    createPlan: vi.fn(async () => providerPlan("plan_created")),
    fetchPlan: vi.fn(async id => providerPlan(id)),
    listPlans: vi.fn(async () => ({ entity: "collection" as const, count: 0, items: [] })),
    createSubscription: vi.fn(async () => { throw new Error("unused"); }),
    fetchSubscription: vi.fn(async () => { throw new Error("unused"); }),
    updateSubscription: vi.fn(async () => { throw new Error("unused"); }),
    cancelScheduledChanges: vi.fn(async () => { throw new Error("unused"); }),
    fetchSubscriptionInvoices: vi.fn(async () => { throw new Error("unused"); }),
    cancelSubscription: vi.fn(async () => { throw new Error("unused"); }),
  };
}

function fakeStore(initial: RazorpayPlanCatalogEntry[] = []) {
  const entries = [...initial];
  let attemptCount = 0;
  let provisioning: { status: "PENDING" | "PROVISIONING" | "READY" | "FAILED"; lastError: string | null } | null = null;
  const calls: string[] = [];

  const store: RazorpayPlanCatalogStore = {
    async findActive(input) {
      calls.push("db:find");
      return entries.find(entry => entry.providerMode === input.providerMode
        && entry.plan === input.plan
        && entry.amountSubunits === input.amountSubunits
        && entry.active) ?? null;
    },
    async markVerified(id, verifiedAt) {
      calls.push("db:verified");
      const entry = entries.find(candidate => candidate.id === id)!;
      entry.lastProviderVerifiedAt = verifiedAt;
      return entry;
    },
    async deactivate(id) {
      calls.push("db:deactivate");
      const entry = entries.find(candidate => candidate.id === id);
      if (entry) entry.active = false;
    },
    async claimProvisioning(input) {
      calls.push("db:claim");
      const claimed = provisioning?.status !== "PROVISIONING";
      if (claimed) {
        attemptCount += 1;
        provisioning = { status: "PROVISIONING", lastError: null };
      }
      return { claimed, leaseToken: input.leaseToken, attemptCount };
    },
    async findProvisioning() {
      return provisioning ? { ...provisioning, attemptCount } : null;
    },
    async completeProvisioning(input) {
      calls.push("db:complete");
      entries.forEach(entry => {
        if (entry.providerMode === input.providerMode && entry.plan === input.plan) entry.active = false;
      });
      const entry: RazorpayPlanCatalogEntry = {
        id: `mapping_${entries.length + 1}`,
        providerMode: input.providerMode,
        catalogKey: input.catalogKey,
        plan: input.plan,
        amount: input.amount,
        amountSubunits: input.amountSubunits,
        currency: input.currency,
        period: input.period,
        interval: input.interval,
        razorpayPlanId: input.razorpayPlanId,
        active: true,
        lastProviderVerifiedAt: input.verifiedAt,
        createdAt: input.verifiedAt,
        updatedAt: input.verifiedAt,
      };
      entries.push(entry);
      provisioning = { status: "READY", lastError: null };
      return entry;
    },
    async failProvisioning(input) {
      calls.push("db:fail");
      provisioning = { status: "FAILED", lastError: input.error };
    },
  };

  return { store, calls, entries, setAttemptCount: (value: number) => { attemptCount = value; } };
}

function existingEntry(mode: "TEST" | "LIVE" = "TEST"): RazorpayPlanCatalogEntry {
  const now = new Date("2026-08-07T00:00:00.000Z");
  return {
    id: "mapping_existing",
    providerMode: mode,
    catalogKey: razorpayPlanCatalogKey({
      providerMode: mode,
      plan: "BASIC",
      amountSubunits: 29_900,
      currency: "INR",
      period: "monthly",
      interval: 1,
    }),
    plan: "BASIC",
    amount: 299,
    amountSubunits: 29_900,
    currency: "INR",
    period: "monthly",
    interval: 1,
    razorpayPlanId: "plan_existing",
    active: true,
    lastProviderVerifiedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

const testEnvironment = {
  RAZORPAY_MODE: "TEST",
  RAZORPAY_KEY_ID: "rzp_test_catalog",
  VERCEL_ENV: "preview",
};

describe("Razorpay provider-scoped plan catalog", () => {
  it("includes provider mode and immutable price details in the deterministic key", () => {
    const testKey = existingEntry("TEST").catalogKey;
    const liveKey = existingEntry("LIVE").catalogKey;
    expect(testKey).toBe("razorpay-plan:v1:TEST:BASIC:INR:29900:monthly:1");
    expect(liveKey).not.toBe(testKey);
  });

  it("fetches and validates a same-mode provider plan before reusing it", async () => {
    const state = fakeStore([existingEntry()]);
    const razorpay = fakeRazorpay();

    await expect(ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
    })).resolves.toMatchObject({ razorpayPlanId: "plan_existing", providerMode: "TEST" });

    expect(razorpay.fetchPlan).toHaveBeenCalledWith("plan_existing");
    expect(razorpay.createPlan).not.toHaveBeenCalled();
  });

  it("reprovisions only after a confirmed provider 404", async () => {
    const state = fakeStore([existingEntry()]);
    const razorpay = fakeRazorpay();
    vi.mocked(razorpay.fetchPlan).mockRejectedValueOnce(
      new RazorpayApiError("not found", { kind: "NOT_FOUND", status: 404 })
    );

    await expect(ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
    })).resolves.toMatchObject({ razorpayPlanId: "plan_created", providerMode: "TEST" });

    expect(state.entries[0].active).toBe(false);
    expect(razorpay.createPlan).toHaveBeenCalledTimes(1);
    expect(state.calls).toEqual([
      "db:find",
      "db:deactivate",
      "db:claim",
      "db:complete",
    ]);
  });

  it.each([
    new RazorpayApiError("bad credentials", { kind: "AUTHENTICATION", status: 401 }),
    new RazorpayApiError("rate limited", { kind: "RATE_LIMIT", status: 429 }),
    new RazorpayApiError("network unavailable", { kind: "NETWORK" }),
  ])("fails closed instead of replacing a mapping for %s", async providerError => {
    const state = fakeStore([existingEntry()]);
    const razorpay = fakeRazorpay();
    vi.mocked(razorpay.fetchPlan).mockRejectedValueOnce(providerError);

    await expect(ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
    })).rejects.toBe(providerError);

    expect(state.entries[0].active).toBe(true);
    expect(razorpay.createPlan).not.toHaveBeenCalled();
  });

  it("recovers a provider plan by catalog note after an interrupted earlier attempt", async () => {
    const state = fakeStore();
    state.setAttemptCount(1);
    const razorpay = fakeRazorpay();
    const catalogKey = existingEntry().catalogKey;
    vi.mocked(razorpay.listPlans).mockResolvedValueOnce({
      entity: "collection",
      count: 1,
      items: [providerPlan("plan_recovered", catalogKey)],
    });

    await expect(ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
    })).resolves.toMatchObject({ razorpayPlanId: "plan_recovered" });

    expect(razorpay.listPlans).toHaveBeenCalledWith({ count: 100, skip: 0 });
    expect(razorpay.createPlan).not.toHaveBeenCalled();
  });

  it("scans subsequent provider pages before creating a replacement orphan", async () => {
    const state = fakeStore();
    state.setAttemptCount(1);
    const razorpay = fakeRazorpay();
    const catalogKey = existingEntry().catalogKey;
    vi.mocked(razorpay.listPlans)
      .mockResolvedValueOnce({
        entity: "collection",
        count: 100,
        items: Array.from({ length: 100 }, (_, index) => providerPlan(`plan_other_${index}`)),
      })
      .mockResolvedValueOnce({
        entity: "collection",
        count: 1,
        items: [providerPlan("plan_recovered_page_2", catalogKey)],
      });

    await expect(ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
    })).resolves.toMatchObject({ razorpayPlanId: "plan_recovered_page_2" });

    expect(razorpay.listPlans).toHaveBeenNthCalledWith(1, { count: 100, skip: 0 });
    expect(razorpay.listPlans).toHaveBeenNthCalledWith(2, { count: 100, skip: 100 });
    expect(razorpay.createPlan).not.toHaveBeenCalled();
  });

  it("keeps provider calls outside the catalog store lease/finalization operations", async () => {
    const state = fakeStore();
    const razorpay = fakeRazorpay();
    vi.mocked(razorpay.createPlan).mockImplementationOnce(async input => {
      state.calls.push("provider:create");
      return providerPlan("plan_created", input.notes.catalog_key);
    });

    await ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
    });

    expect(state.calls).toEqual([
      "db:find",
      "db:claim",
      "provider:create",
      "db:complete",
    ]);
  });

  it("serializes concurrent provisioning callers onto one provider plan", async () => {
    const state = fakeStore();
    const razorpay = fakeRazorpay();
    let releaseProvider!: (value: RazorpayPlan) => void;
    vi.mocked(razorpay.createPlan).mockImplementationOnce(() => new Promise(resolve => {
      releaseProvider = resolve;
    }));

    const first = ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
      pollMilliseconds: 1,
      waitMilliseconds: 1_000,
    });
    await vi.waitFor(() => expect(razorpay.createPlan).toHaveBeenCalledTimes(1));

    const second = ensureRazorpayPlanCatalogEntry(basicDefinition, {
      environment: testEnvironment,
      store: state.store,
      razorpay,
      pollMilliseconds: 1,
      waitMilliseconds: 1_000,
    });
    releaseProvider(providerPlan("plan_concurrent"));

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.razorpayPlanId).toBe("plan_concurrent");
    expect(secondResult.razorpayPlanId).toBe("plan_concurrent");
    expect(razorpay.createPlan).toHaveBeenCalledTimes(1);
  });
});
