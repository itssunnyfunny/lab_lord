import crypto from "node:crypto";

import type { SaasPlan } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  getRazorpayPlanCatalogClient,
  isRazorpayNotFoundError,
  normalizeCurrency,
  resolveRazorpayMode,
  toRazorpaySubunits,
  type RazorpayPlanCatalogApiClient,
  type RazorpayModeValue,
  type RazorpayPlan,
} from "@/lib/razorpay";

const DEFAULT_LEASE_MS = 2 * 60 * 1_000;
const DEFAULT_WAIT_MS = 15_000;
const DEFAULT_POLL_MS = 100;

export type RazorpayPlanCatalogDefinition = {
  plan: SaasPlan;
  name: string;
  description?: string;
  amount: number;
  currency: string;
  period: string;
  interval: number;
};

export type RazorpayPlanCatalogEntry = {
  id: string;
  providerMode: RazorpayModeValue;
  catalogKey: string;
  plan: SaasPlan;
  amount: number;
  amountSubunits: number;
  currency: string;
  period: string;
  interval: number;
  razorpayPlanId: string;
  active: boolean;
  lastProviderVerifiedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type NormalizedCatalogDefinition = RazorpayPlanCatalogDefinition & {
  providerMode: RazorpayModeValue;
  amountSubunits: number;
  catalogKey: string;
};

type ProvisioningSnapshot = {
  status: "PENDING" | "PROVISIONING" | "READY" | "FAILED";
  attemptCount: number;
  lastError: string | null;
};

type ProvisioningLease = {
  claimed: boolean;
  leaseToken: string;
  attemptCount: number;
};

export interface RazorpayPlanCatalogStore {
  findActive(input: NormalizedCatalogDefinition): Promise<RazorpayPlanCatalogEntry | null>;
  markVerified(id: string, verifiedAt: Date): Promise<RazorpayPlanCatalogEntry>;
  deactivate(id: string): Promise<void>;
  claimProvisioning(input: NormalizedCatalogDefinition & {
    leaseToken: string;
    now: Date;
    leaseUntil: Date;
  }): Promise<ProvisioningLease>;
  findProvisioning(catalogKey: string): Promise<ProvisioningSnapshot | null>;
  completeProvisioning(input: NormalizedCatalogDefinition & {
    leaseToken: string;
    razorpayPlanId: string;
    verifiedAt: Date;
  }): Promise<RazorpayPlanCatalogEntry>;
  failProvisioning(input: {
    catalogKey: string;
    leaseToken: string;
    error: string;
  }): Promise<void>;
}

export class RazorpayPlanCatalogBusyError extends Error {
  constructor() {
    super("Razorpay plan provisioning is already in progress; retry shortly");
    this.name = "RazorpayPlanCatalogBusyError";
  }
}

export class RazorpayPlanCatalogProvisioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RazorpayPlanCatalogProvisioningError";
  }
}

export function razorpayPlanCatalogKey(input: {
  providerMode: RazorpayModeValue;
  plan: SaasPlan;
  amountSubunits: number;
  currency: string;
  period: string;
  interval: number;
}) {
  return [
    "razorpay-plan",
    "v1",
    input.providerMode,
    input.plan,
    normalizeCurrency(input.currency),
    input.amountSubunits,
    input.period.trim().toLowerCase(),
    input.interval,
  ].join(":");
}

function normalizeDefinition(
  definition: RazorpayPlanCatalogDefinition,
  providerMode: RazorpayModeValue
): NormalizedCatalogDefinition {
  const currency = normalizeCurrency(definition.currency);
  const period = definition.period.trim().toLowerCase();
  if (!period) throw new Error("Razorpay plan period is required");
  if (!Number.isInteger(definition.interval) || definition.interval <= 0) {
    throw new Error("Razorpay plan interval must be a positive integer");
  }
  const amountSubunits = toRazorpaySubunits(definition.amount, currency);

  return {
    ...definition,
    providerMode,
    currency,
    period,
    amountSubunits,
    catalogKey: razorpayPlanCatalogKey({
      providerMode,
      plan: definition.plan,
      amountSubunits,
      currency,
      period,
      interval: definition.interval,
    }),
  };
}

function providerPlanMatches(plan: RazorpayPlan, expected: NormalizedCatalogDefinition) {
  return plan.entity === "plan"
    && plan.interval === expected.interval
    && plan.period.trim().toLowerCase() === expected.period
    && plan.item?.amount === expected.amountSubunits
    && typeof plan.item?.currency === "string"
    && normalizeCurrency(plan.item.currency) === expected.currency;
}

function safeProvisioningError(error: unknown) {
  const message = error instanceof Error ? error.message : "Razorpay plan provisioning failed";
  return message.slice(0, 1_000);
}

const prismaCatalogStore: RazorpayPlanCatalogStore = {
  async findActive(input) {
    return prisma.saasRazorpayPlan.findFirst({
      where: {
        providerMode: input.providerMode,
        catalogKey: input.catalogKey,
        plan: input.plan,
        amount: input.amount,
        amountSubunits: input.amountSubunits,
        currency: input.currency,
        period: input.period,
        interval: input.interval,
        active: true,
      },
      orderBy: { createdAt: "desc" },
    });
  },

  async markVerified(id, verifiedAt) {
    return prisma.saasRazorpayPlan.update({
      where: { id },
      data: { lastProviderVerifiedAt: verifiedAt },
    });
  },

  async deactivate(id) {
    await prisma.saasRazorpayPlan.updateMany({
      where: { id, active: true },
      data: { active: false },
    });
  },

  async claimProvisioning(input) {
    await prisma.razorpayPlanProvisioning.upsert({
      where: { catalogKey: input.catalogKey },
      create: {
        catalogKey: input.catalogKey,
        providerMode: input.providerMode,
        plan: input.plan,
        amount: input.amount,
        amountSubunits: input.amountSubunits,
        currency: input.currency,
        period: input.period,
        interval: input.interval,
      },
      update: {
        providerMode: input.providerMode,
        plan: input.plan,
        amount: input.amount,
        amountSubunits: input.amountSubunits,
        currency: input.currency,
        period: input.period,
        interval: input.interval,
      },
    });

    const claimed = await prisma.razorpayPlanProvisioning.updateMany({
      where: {
        catalogKey: input.catalogKey,
        OR: [
          { status: { not: "PROVISIONING" } },
          { leaseUntil: null },
          { leaseUntil: { lte: input.now } },
        ],
      },
      data: {
        status: "PROVISIONING",
        leaseToken: input.leaseToken,
        leaseUntil: input.leaseUntil,
        attemptCount: { increment: 1 },
        lastError: null,
      },
    });
    const snapshot = await prisma.razorpayPlanProvisioning.findUniqueOrThrow({
      where: { catalogKey: input.catalogKey },
      select: { attemptCount: true },
    });
    return {
      claimed: claimed.count === 1,
      leaseToken: input.leaseToken,
      attemptCount: snapshot.attemptCount,
    };
  },

  async findProvisioning(catalogKey) {
    return prisma.razorpayPlanProvisioning.findUnique({
      where: { catalogKey },
      select: { status: true, attemptCount: true, lastError: true },
    });
  },

  async completeProvisioning(input) {
    return prisma.$transaction(async tx => {
      // Provisioning leases are scoped to an immutable catalog key. Price
      // replacements have different keys, so serialize the final active-map
      // swap separately by provider mode and logical SaaS plan.
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(
          hashtext(${`lab-lords:razorpay-plan-active:${input.providerMode}:${input.plan}`})
        )::text AS locked
      `;

      // The mode/plan lock can wait behind another price activation. Re-lock
      // and verify this catalog lease afterwards so an expired lease cannot
      // finalize or overwrite a newer claimant.
      const [lease] = await tx.$queryRaw<Array<{
        status: string;
        leaseToken: string | null;
      }>>`
        SELECT "status"::text AS "status", "leaseToken" AS "leaseToken"
        FROM "RazorpayPlanProvisioning"
        WHERE "catalogKey" = ${input.catalogKey}
        FOR UPDATE
      `;
      if (lease?.status !== "PROVISIONING" || lease.leaseToken !== input.leaseToken) {
        throw new RazorpayPlanCatalogBusyError();
      }

      const providerIdOwner = await tx.saasRazorpayPlan.findUnique({
        where: { razorpayPlanId: input.razorpayPlanId },
      });
      if (providerIdOwner && (
        providerIdOwner.providerMode !== input.providerMode
        || providerIdOwner.plan !== input.plan
      )) {
        throw new RazorpayPlanCatalogProvisioningError(
          "Razorpay plan ID is already assigned to another provider catalog entry"
        );
      }

      await tx.saasRazorpayPlan.updateMany({
        where: {
          providerMode: input.providerMode,
          plan: input.plan,
          active: true,
          ...(providerIdOwner ? { id: { not: providerIdOwner.id } } : {}),
        },
        data: { active: false },
      });

      const mapping = providerIdOwner
        ? await tx.saasRazorpayPlan.update({
            where: { id: providerIdOwner.id },
            data: {
              catalogKey: input.catalogKey,
              amount: input.amount,
              amountSubunits: input.amountSubunits,
              currency: input.currency,
              period: input.period,
              interval: input.interval,
              active: true,
              lastProviderVerifiedAt: input.verifiedAt,
            },
          })
        : await tx.saasRazorpayPlan.create({
            data: {
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
            },
          });

      await tx.razorpayPlanProvisioning.update({
        where: { catalogKey: input.catalogKey },
        data: {
          status: "READY",
          leaseToken: null,
          leaseUntil: null,
          razorpayPlanId: input.razorpayPlanId,
          lastError: null,
        },
      });
      return mapping;
    });
  },

  async failProvisioning(input) {
    await prisma.razorpayPlanProvisioning.updateMany({
      where: {
        catalogKey: input.catalogKey,
        status: "PROVISIONING",
        leaseToken: input.leaseToken,
      },
      data: {
        status: "FAILED",
        leaseToken: null,
        leaseUntil: null,
        lastError: input.error,
      },
    });
  },
};

export type EnsureRazorpayPlanCatalogOptions = {
  environment?: Readonly<Record<string, string | undefined>>;
  razorpay?: Pick<RazorpayPlanCatalogApiClient, "createPlan" | "fetchPlan" | "listPlans">;
  store?: RazorpayPlanCatalogStore;
  now?: () => Date;
  randomUUID?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  leaseMilliseconds?: number;
  waitMilliseconds?: number;
  pollMilliseconds?: number;
};

async function verifyActiveMapping(
  mapping: RazorpayPlanCatalogEntry,
  expected: NormalizedCatalogDefinition,
  razorpay: Pick<RazorpayPlanCatalogApiClient, "createPlan" | "fetchPlan" | "listPlans">,
  store: RazorpayPlanCatalogStore,
  verifiedAt: Date
) {
  try {
    const providerPlan = await razorpay.fetchPlan(mapping.razorpayPlanId);
    if (!providerPlanMatches(providerPlan, expected)) {
      await store.deactivate(mapping.id);
      return null;
    }
    return store.markVerified(mapping.id, verifiedAt);
  } catch (error) {
    if (!isRazorpayNotFoundError(error)) throw error;
    await store.deactivate(mapping.id);
    return null;
  }
}

async function waitForProvisioning(
  expected: NormalizedCatalogDefinition,
  input: {
    razorpay: Pick<RazorpayPlanCatalogApiClient, "createPlan" | "fetchPlan" | "listPlans">;
    store: RazorpayPlanCatalogStore;
    now: () => Date;
    sleep: (milliseconds: number) => Promise<void>;
    waitMilliseconds: number;
    pollMilliseconds: number;
  }
) {
  const deadline = input.now().getTime() + input.waitMilliseconds;
  while (input.now().getTime() < deadline) {
    await input.sleep(input.pollMilliseconds);
    const mapping = await input.store.findActive(expected);
    if (mapping) {
      const verified = await verifyActiveMapping(
        mapping,
        expected,
        input.razorpay,
        input.store,
        input.now()
      );
      if (verified) return verified;
    }

    const provisioning = await input.store.findProvisioning(expected.catalogKey);
    if (provisioning?.status === "FAILED") {
      throw new RazorpayPlanCatalogProvisioningError(
        provisioning.lastError || "Razorpay plan provisioning failed"
      );
    }
  }
  throw new RazorpayPlanCatalogBusyError();
}

async function findProviderPlanByCatalogKey(
  razorpay: Pick<RazorpayPlanCatalogApiClient, "createPlan" | "fetchPlan" | "listPlans">,
  expected: NormalizedCatalogDefinition
) {
  let skip = 0;
  for (;;) {
    const page = await razorpay.listPlans({ count: 100, skip });
    const match = page.items.find(candidate =>
      candidate.notes?.catalog_key === expected.catalogKey
      && providerPlanMatches(candidate, expected)
    );
    if (match) return match;
    if (page.items.length < 100) return undefined;
    skip += page.items.length;
    if (skip >= 10_000) {
      throw new RazorpayPlanCatalogProvisioningError(
        "Razorpay plan catalog exceeds the safe orphan-recovery scan limit"
      );
    }
  }
}

/**
 * Resolves an immutable provider plan for the configured Razorpay mode.
 * Provider reads and writes deliberately occur between store calls, never in
 * the short database transactions used to claim or finalize a lease.
 */
export async function ensureRazorpayPlanCatalogEntry(
  definition: RazorpayPlanCatalogDefinition,
  options: EnsureRazorpayPlanCatalogOptions = {}
): Promise<RazorpayPlanCatalogEntry> {
  const now = options.now ?? (() => new Date());
  const store = options.store ?? prismaCatalogStore;
  const razorpay = options.razorpay ?? getRazorpayPlanCatalogClient();
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const providerMode = resolveRazorpayMode(options.environment ?? process.env);
  const expected = normalizeDefinition(definition, providerMode);

  const current = await store.findActive(expected);
  if (current) {
    const verified = await verifyActiveMapping(current, expected, razorpay, store, now());
    if (verified) return verified;
  }

  const leaseToken = (options.randomUUID ?? crypto.randomUUID)();
  const claimedAt = now();
  const lease = await store.claimProvisioning({
    ...expected,
    leaseToken,
    now: claimedAt,
    leaseUntil: new Date(claimedAt.getTime() + (options.leaseMilliseconds ?? DEFAULT_LEASE_MS)),
  });

  if (!lease.claimed) {
    return waitForProvisioning(expected, {
      razorpay,
      store,
      now,
      sleep,
      waitMilliseconds: options.waitMilliseconds ?? DEFAULT_WAIT_MS,
      pollMilliseconds: options.pollMilliseconds ?? DEFAULT_POLL_MS,
    });
  }

  try {
    let providerPlan: RazorpayPlan | undefined;
    if (lease.attemptCount > 1) {
      providerPlan = await findProviderPlanByCatalogKey(razorpay, expected);
    }

    if (!providerPlan) {
      providerPlan = await razorpay.createPlan({
        period: expected.period,
        interval: expected.interval,
        item: {
          name: expected.name,
          amount: expected.amountSubunits,
          currency: expected.currency,
          description: expected.description,
        },
        notes: {
          app: "lab_lords",
          billing_type: "saas_plan",
          provider_mode: expected.providerMode,
          plan: expected.plan,
          catalog_key: expected.catalogKey,
        },
      });
    }

    if (!providerPlanMatches(providerPlan, expected)) {
      throw new RazorpayPlanCatalogProvisioningError(
        "Razorpay returned a plan that does not match the requested catalog entry"
      );
    }

    return await store.completeProvisioning({
      ...expected,
      leaseToken,
      razorpayPlanId: providerPlan.id,
      verifiedAt: now(),
    });
  } catch (error) {
    await store.failProvisioning({
      catalogKey: expected.catalogKey,
      leaseToken,
      error: safeProvisioningError(error),
    });
    throw error;
  }
}
