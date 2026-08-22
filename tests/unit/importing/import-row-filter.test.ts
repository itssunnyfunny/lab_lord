import { describe, expect, it } from "vitest";
import { rowWhereForFilter } from "@/importing/services/import-session.service";

describe("import session row issue filtering", () => {
    it("combines a paginated attention filter with an exact issue or warning code", () => {
        expect(rowWhereForFilter("session_1", "attention", 120, "INVALID_PHONE")).toEqual({
            importSessionId: "session_1",
            rowNumber: { gt: 120 },
            status: { in: ["WARNING", "NEEDS_REVIEW", "BLOCKED", "DUPLICATE", "CONFLICT", "FAILED"] },
            AND: [{
                OR: [
                    { issues: { array_contains: [{ code: "INVALID_PHONE" }] } },
                    { warnings: { array_contains: [{ code: "INVALID_PHONE" }] } },
                ],
            }],
        });
    });
});
