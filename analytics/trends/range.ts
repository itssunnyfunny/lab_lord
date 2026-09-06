export const MAX_TREND_POINTS = 31;

export function assertTrendRange(from: Date, to: Date) {
  if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
    throw new Error("Invalid trend date range");
  }
  // Match the daily cursor used by the trend helpers, including local DST.
  const limit = new Date(from);
  limit.setDate(limit.getDate() + MAX_TREND_POINTS);
  if (to >= limit) throw new Error("Trend ranges support at most 31 daily points");
}

export function parseTrendDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.exec(value);
  if (!match) throw new Error("Invalid date format");
  const [, year, month, day] = match;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(calendar.getTime())
    || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
    || value.includes("T24:")) throw new Error("Invalid date format");
  return date;
}
