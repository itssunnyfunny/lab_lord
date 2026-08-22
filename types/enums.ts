export {
  ImportCommitStatus,
  ImportQuestionStatus,
  ImportRowStatus,
  ImportSessionStatus,
  ImportSourceType,
  PaymentMethod,
  PaymentResolutionEventSource,
  PaymentStatus,
  PaymentType,
  SaasPlan,
  SaasSubscriptionHistorySource,
  SaasSubscriptionStatus,
  StaffPermissionAction,
  StaffRole,
  StudentStatus,
} from "@/app/generated/prisma/enums";

export const DUE_RESOLUTIONS = ["KEEP", "PAID", "WAIVED"] as const;

export type DueResolution = typeof DUE_RESOLUTIONS[number];

export function isDueResolution(value: unknown): value is DueResolution {
  return typeof value === "string"
    && (DUE_RESOLUTIONS as readonly string[]).includes(value);
}
