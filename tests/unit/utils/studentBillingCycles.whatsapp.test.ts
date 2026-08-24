import { describe, expect, it } from "vitest";
import { format } from "date-fns";

import { upcomingCyclesBetween } from "@/utils/studentBillingCycles";

describe("prospective billing cycles for WhatsApp planning", () => {
  it.each([
    ["2026-01-29T00:00:00Z", "2026-02-28"],
    ["2026-01-30T00:00:00Z", "2026-02-28"],
    ["2026-01-31T00:00:00Z", "2026-02-28"],
    ["2024-01-31T00:00:00Z", "2024-02-29"],
    ["2026-12-31T00:00:00Z", "2027-01-31"],
  ])("preserves anniversary rules for %s", (joinedAt, expectedDueDate) => {
    const due = new Date(`${expectedDueDate}T00:00:00Z`);
    expect(upcomingCyclesBetween(new Date(joinedAt), due, due)).toHaveLength(1);
    expect(format(upcomingCyclesBetween(new Date(joinedAt), due, due)[0]!.dueDate, "yyyy-MM-dd"))
      .toBe(expectedDueDate);
  });

  it("honors billingStartAt and never persists future payment truth", () => {
    const cycles = upcomingCyclesBetween(
      new Date("2026-01-15T00:00:00Z"),
      new Date("2026-02-01T00:00:00Z"),
      new Date("2026-05-31T00:00:00Z"),
      new Date("2026-03-01T00:00:00Z")
    );
    expect(cycles.map(cycle => format(cycle.dueDate, "yyyy-MM-dd"))).toEqual([
      "2026-04-15",
      "2026-05-15",
    ]);
  });
});
