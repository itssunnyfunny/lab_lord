export type WhatsAppProjectedStatus =
  | "SCHEDULED"
  | "CLAIMED"
  | "SUBMITTING"
  | "ACCEPTED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "CANCELLED"
  | "SUPPRESSED"
  | "UNKNOWN";

export type WhatsAppStatusProjection = Readonly<{
  status: WhatsAppProjectedStatus;
  providerStatusTimestamp: Date | null;
}>;

export type WhatsAppStatusEvent = Readonly<{
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
  providerTimestamp: Date | null;
  stableOrder?: string;
}>;

const SUCCESS_RANK: Readonly<Record<string, number>> = {
  ACCEPTED: 0,
  SENT: 1,
  DELIVERED: 2,
  READ: 3,
};

const LOCALLY_TERMINAL = new Set<WhatsAppProjectedStatus>([
  "CANCELLED",
  "SUPPRESSED",
]);

export function reduceWhatsAppStatusProjection(
  current: WhatsAppStatusProjection,
  event: WhatsAppStatusEvent
): WhatsAppStatusProjection {
  if (LOCALLY_TERMINAL.has(current.status)) return current;
  const currentTimestamp = current.providerStatusTimestamp?.getTime() ?? Number.NEGATIVE_INFINITY;
  const eventTimestamp = event.providerTimestamp?.getTime() ?? Number.NEGATIVE_INFINITY;

  if (eventTimestamp < currentTimestamp) return current;
  if (event.status === "FAILED") {
    // Meta can report a delivery failure after SENT. Once delivery (or read)
    // has been authoritatively observed, a conflicting failure must not
    // regress that successful terminal evidence.
    if ((SUCCESS_RANK[current.status] ?? -1) >= SUCCESS_RANK.DELIVERED) return current;
    return { status: "FAILED", providerStatusTimestamp: event.providerTimestamp };
  }
  // Provider timestamps order evidence, but they cannot make a later-arriving
  // lower success state erase stronger delivery evidence already observed.
  if ((SUCCESS_RANK[event.status] ?? -1) <= (SUCCESS_RANK[current.status] ?? -1)) {
    return current;
  }
  return { status: event.status, providerStatusTimestamp: event.providerTimestamp };
}

export function projectWhatsAppStatus(
  initial: WhatsAppStatusProjection,
  events: readonly WhatsAppStatusEvent[]
) {
  return [...events]
    .sort((left, right) => {
      const timestampDifference =
        (left.providerTimestamp?.getTime() ?? Number.NEGATIVE_INFINITY)
        - (right.providerTimestamp?.getTime() ?? Number.NEGATIVE_INFINITY);
      if (timestampDifference !== 0) return timestampDifference;
      const rankDifference = (SUCCESS_RANK[left.status] ?? -1) - (SUCCESS_RANK[right.status] ?? -1);
      if (rankDifference !== 0) return rankDifference;
      return (left.stableOrder ?? "").localeCompare(right.stableOrder ?? "");
    })
    .reduce(reduceWhatsAppStatusProjection, initial);
}
