import { describe, expect, it } from "vitest";
import {
    decodeDateIdCursor,
    encodeDateIdCursor,
    pageFromRows,
    PaginationInputError,
    parsePageLimit,
} from "@/lib/cursorPagination";

describe("cursor pagination", () => {
    it("uses 50 by default and rejects unsafe limits", () => {
        expect(parsePageLimit(null)).toBe(50);
        expect(parsePageLimit("100")).toBe(100);
        for (const value of ["0", "101", "1.5", "nope"]) {
            expect(() => parsePageLimit(value)).toThrow(PaginationInputError);
        }
    });

    it("round-trips an opaque date/id cursor", () => {
        const encoded = encodeDateIdCursor({ sort: "2026-08-08T10:00:00.000Z", id: "row_1" });
        expect(encoded).not.toContain("row_1");
        expect(decodeDateIdCursor(encoded)).toEqual({
            sort: new Date("2026-08-08T10:00:00.000Z"),
            id: "row_1",
        });
    });

    it("rejects malformed cursors", () => {
        expect(() => decodeDateIdCursor("not-a-cursor")).toThrow(PaginationInputError);
    });

    it("returns one look-ahead row as a next cursor", () => {
        const rows = [1, 2, 3].map(id => ({ id: `row_${id}`, createdAt: new Date(`2026-08-0${id}T00:00:00.000Z`) }));
        const page = pageFromRows(rows, 2, 9, row => ({ sort: row.createdAt, id: row.id }));
        expect(page.items.map(item => item.id)).toEqual(["row_1", "row_2"]);
        expect(page.total).toBe(9);
        expect(decodeDateIdCursor(page.nextCursor)?.id).toBe("row_2");
    });
});
