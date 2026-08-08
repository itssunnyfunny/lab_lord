export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export class PaginationInputError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PaginationInputError";
    }
}

export type DateIdCursor = {
    sort: Date;
    id: string;
};

type EncodedCursor = {
    v: 1;
    sort: string;
    id: string;
};

export function parsePageLimit(value: string | null | undefined) {
    if (value == null || value === "") return DEFAULT_PAGE_SIZE;
    if (!/^\d+$/.test(value)) throw new PaginationInputError("limit must be a positive integer");
    const limit = Number(value);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
        throw new PaginationInputError(`limit must be between 1 and ${MAX_PAGE_SIZE}`);
    }
    return limit;
}

export function encodeDateIdCursor(cursor: { sort: Date | string; id: string }) {
    const sort = cursor.sort instanceof Date ? cursor.sort : new Date(cursor.sort);
    if (!cursor.id || !Number.isFinite(sort.getTime())) {
        throw new PaginationInputError("Cannot encode an invalid cursor");
    }
    const payload: EncodedCursor = { v: 1, sort: sort.toISOString(), id: cursor.id };
    return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeDateIdCursor(value: string | null | undefined): DateIdCursor | null {
    if (!value) return null;
    if (value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
        throw new PaginationInputError("cursor is invalid");
    }

    try {
        const payload = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<EncodedCursor>;
        const sort = typeof payload.sort === "string" ? new Date(payload.sort) : new Date(Number.NaN);
        if (payload.v !== 1 || typeof payload.id !== "string" || !payload.id || !Number.isFinite(sort.getTime())) {
            throw new Error("invalid payload");
        }
        return { sort, id: payload.id };
    } catch {
        throw new PaginationInputError("cursor is invalid");
    }
}

export function pageFromRows<T>(
    rows: T[],
    limit: number,
    total: number,
    getCursor: (row: T) => { sort: Date | string; id: string }
) {
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = hasMore ? items.at(-1) : undefined;
    return {
        items,
        nextCursor: last ? encodeDateIdCursor(getCursor(last)) : null,
        total,
    };
}
