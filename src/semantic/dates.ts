/**
 * Date arithmetic for the semantic layer.
 *
 * Everything here is UTC. The foundry wrote UTC instants and Mongo stores UTC,
 * so introducing a local timezone anywhere would silently shift bucket
 * boundaries and make "last week" mean different things in two places.
 *
 * Weeks start on **Monday**. Mongo's `$dateTrunc` defaults to Sunday, so the
 * compiler always passes `startOfWeek` explicitly - the default is a trap you
 * only notice when a weekly chart is off by one bucket.
 */

export type Grain = "total" | "day" | "week" | "month" | "quarter";

/** Inclusive on both ends, `YYYY-MM-DD`. */
export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
export const START_OF_WEEK = "monday" as const;

export function isIsoDay(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

export function toDay(s: string): Date {
  if (!isIsoDay(s)) throw new RangeError(`not a YYYY-MM-DD date: ${JSON.stringify(s)}`);
  return new Date(`${s}T00:00:00.000Z`);
}

export function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Half-open instant bounds for an inclusive day range: `[start, endExclusive)`.
 * Half-open is what `$match` wants - an inclusive `$lte` on a day boundary
 * drops everything that happened after midnight on the final day.
 */
export function rangeBounds(r: DateRange): { start: Date; endExclusive: Date } {
  const start = toDay(r.from);
  const endExclusive = new Date(toDay(r.to).getTime() + DAY_MS);
  if (endExclusive <= start) throw new RangeError(`empty date range: ${r.from}..${r.to}`);
  return { start, endExclusive };
}

export function rangeDays(r: DateRange): number {
  return Math.round((toDay(r.to).getTime() - toDay(r.from).getTime()) / DAY_MS) + 1;
}

/**
 * The window immediately before `r`, of identical length. Used for
 * `compareTo: "previous_period"`. Length-matched rather than
 * calendar-matched: comparing a 31-day month against a 28-day one produces a
 * "decline" that is really just February.
 */
export function previousPeriod(r: DateRange): DateRange {
  const n = rangeDays(r);
  const to = new Date(toDay(r.from).getTime() - DAY_MS);
  const from = new Date(to.getTime() - (n - 1) * DAY_MS);
  return { from: fmtDay(from), to: fmtDay(to) };
}

/** Same calendar dates, one year earlier. Feb 29 clamps to Feb 28. */
export function samePeriodLastYear(r: DateRange): DateRange {
  return { from: shiftYear(r.from), to: shiftYear(r.to) };
}

function shiftYear(day: string): string {
  const d = toDay(day);
  const y = d.getUTCFullYear() - 1;
  const m = d.getUTCMonth();
  const dom = Math.min(d.getUTCDate(), daysInMonth(y, m));
  return fmtDay(new Date(Date.UTC(y, m, dom)));
}

function daysInMonth(year: number, monthIdx: number): number {
  return new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();
}

export function shiftDays(day: string, n: number): string {
  return fmtDay(new Date(toDay(day).getTime() + n * DAY_MS));
}

function startOfWeekMonday(d: Date): Date {
  // getUTCDay(): 0=Sun..6=Sat. Monday-based offset: Sun counts as 6 days in.
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * DAY_MS);
}

/**
 * Named windows the intent generator can reference instead of doing calendar
 * arithmetic itself. Handing the model a cheat-sheet of resolved dates removes
 * the single largest source of wrong answers: an LLM that is right about
 * "last month" conceptually and wrong about which days that was.
 */
export function calendarAnchors(today: Date): Record<string, DateRange> {
  const t = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();

  const thisWeekStart = startOfWeekMonday(t);
  const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * DAY_MS);
  const qStartMonth = Math.floor(m / 3) * 3;
  const lastQEnd = new Date(Date.UTC(y, qStartMonth, 0));
  const lastQStart = new Date(Date.UTC(lastQEnd.getUTCFullYear(), lastQEnd.getUTCMonth() - 2, 1));

  const mk = (from: Date, to: Date): DateRange => ({ from: fmtDay(from), to: fmtDay(to) });

  return {
    today: mk(t, t),
    yesterday: mk(new Date(t.getTime() - DAY_MS), new Date(t.getTime() - DAY_MS)),
    this_week: mk(thisWeekStart, t),
    last_week: mk(lastWeekStart, new Date(thisWeekStart.getTime() - DAY_MS)),
    this_month: mk(new Date(Date.UTC(y, m, 1)), t),
    last_month: mk(new Date(Date.UTC(y, m - 1, 1)), new Date(Date.UTC(y, m, 0))),
    this_quarter: mk(new Date(Date.UTC(y, qStartMonth, 1)), t),
    last_quarter: mk(lastQStart, lastQEnd),
    last_7_days: mk(new Date(t.getTime() - 6 * DAY_MS), t),
    last_30_days: mk(new Date(t.getTime() - 29 * DAY_MS), t),
    last_90_days: mk(new Date(t.getTime() - 89 * DAY_MS), t),
    year_to_date: mk(new Date(Date.UTC(y, 0, 1)), t),
  };
}
