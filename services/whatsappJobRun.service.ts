import type {
  Prisma,
  WhatsAppJobRunStatus,
  WhatsAppJobType,
  WhatsAppProviderMode,
} from "@/app/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { WhatsAppValidationError } from "@/lib/whatsappHttp";

type PrismaClient = Prisma.TransactionClient | typeof prisma;

const INVOCATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const COUNT_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,47}$/;
const FORBIDDEN_COUNT_KEY_PATTERN = /(?:amount|cost|price|micros|minor|paise|rupees|phone|secret|token|rendered|ids?$)/i;
const MAX_JOB_COUNT = 2_147_483_647;
const MAX_JOB_COUNT_KEYS = 40;

export type WhatsAppJobCounts = Readonly<Record<string, number>>;

export function sanitizeWhatsAppJobCounts(
  input: Readonly<Record<string, unknown>>
): Prisma.InputJsonObject {
  const entries = Object.entries(input);
  if (entries.length > MAX_JOB_COUNT_KEYS) throw new WhatsAppValidationError();
  const counts: Record<string, number> = {};
  for (const [key, value] of entries) {
    if (
      !COUNT_KEY_PATTERN.test(key)
      || FORBIDDEN_COUNT_KEY_PATTERN.test(key)
      || typeof value !== "number"
      || !Number.isSafeInteger(value)
      || value < 0
      || value > MAX_JOB_COUNT
    ) throw new WhatsAppValidationError();
    counts[key] = value;
  }
  return counts as Prisma.InputJsonObject;
}

function assertInvocationId(value: string) {
  if (!INVOCATION_ID_PATTERN.test(value)) throw new WhatsAppValidationError();
  return value;
}

function assertSafeErrorCode(value: string | null | undefined) {
  if (value === undefined || value === null) return null;
  if (!/^[A-Z0-9][A-Z0-9._:-]{0,127}$/.test(value)) {
    throw new WhatsAppValidationError();
  }
  return value;
}

export class WhatsAppJobRunService {
  static async start(input: {
    jobType: WhatsAppJobType;
    invocationId: string;
    providerMode?: WhatsAppProviderMode | null;
    counts?: WhatsAppJobCounts;
    now?: Date;
    client?: PrismaClient;
  }) {
    const client = input.client ?? prisma;
    const invocationId = assertInvocationId(input.invocationId);
    const counts = sanitizeWhatsAppJobCounts(input.counts ?? {});
    const now = input.now ?? new Date();
    const providerMode = input.providerMode ?? null;
    const existing = await client.whatsAppJobRun.findUnique({
      where: { invocationId },
    });
    if (existing) {
      if (existing.jobType !== input.jobType || existing.providerMode !== providerMode) {
        throw new WhatsAppValidationError();
      }
      return { created: false as const, run: existing };
    }
    try {
      const run = await client.whatsAppJobRun.create({
        data: {
          jobType: input.jobType,
          invocationId,
          providerMode,
          status: "RUNNING",
          startedAt: now,
          counts,
        },
      });
      return { created: true as const, run };
    } catch (error) {
      const raced = await client.whatsAppJobRun.findUnique({
        where: { invocationId },
      });
      if (!raced) throw error;
      if (raced.jobType !== input.jobType || raced.providerMode !== providerMode) {
        throw new WhatsAppValidationError();
      }
      return { created: false as const, run: raced };
    }
  }

  static async finish(input: {
    runId: string;
    status: Exclude<WhatsAppJobRunStatus, "RUNNING">;
    counts: WhatsAppJobCounts;
    safeErrorCode?: string | null;
    now?: Date;
    client?: PrismaClient;
  }) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.runId)) {
      throw new WhatsAppValidationError();
    }
    if (!(["SUCCEEDED", "PARTIAL", "FAILED", "HELD"] as const).includes(input.status)) {
      throw new WhatsAppValidationError();
    }
    const client = input.client ?? prisma;
    const now = input.now ?? new Date();
    const current = await client.whatsAppJobRun.findUnique({ where: { id: input.runId } });
    if (!current) throw new WhatsAppValidationError();
    if (current.status !== "RUNNING") return { changed: false as const, run: current };
    const duration = Math.max(0, now.getTime() - current.startedAt.getTime());
    const durationMs = Math.min(MAX_JOB_COUNT, Number.isSafeInteger(duration) ? duration : MAX_JOB_COUNT);
    const updated = await client.whatsAppJobRun.updateMany({
      where: { id: current.id, status: "RUNNING" },
      data: {
        status: input.status,
        finishedAt: now,
        durationMs,
        counts: sanitizeWhatsAppJobCounts(input.counts),
        safeErrorCode: assertSafeErrorCode(input.safeErrorCode),
      },
    });
    const run = await client.whatsAppJobRun.findUnique({ where: { id: current.id } });
    if (!run) throw new WhatsAppValidationError();
    return { changed: updated.count === 1, run };
  }
}
