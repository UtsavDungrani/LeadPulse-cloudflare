/**
 * Runs a compiled query and assembles the answer.
 *
 * Everything numeric happens here, in TypeScript, against documents Mongo
 * returned. The language model is not in this file and never sees a chance to
 * do arithmetic - which is how hallucinated figures are prevented structurally
 * rather than by asking a prompt nicely.
 */
import type { Document } from "mongodb";
import type { DataSource } from "../db/types";
import {
  compileQuery,
  compileRankingQuery,
  needsRanking,
  MAX_GROUPS,
  type CompiledPart,
  type DimensionRestriction,
} from "./compile";
import type { DimensionId } from "./fields";
import { formatValue, metric, type MetricDef, type MetricUnit } from "./metrics";
import {
  fmtDay,
  previousPeriod,
  samePeriodLastYear,
  type DateRange,
  type Grain,
} from "./dates";
import type { QueryIntent } from "./intent";

export const UNKNOWN = "(unknown)";

export interface ResultRow {
  /** Bucket start as `YYYY-MM-DD`, or null when the grain is `total`. */
  period: string | null;
  /** Dimension id -> display label. */
  dims: Record<string, string>;
  value: number | null;
  formatted: string;
  /** Raw counts behind the number: `n`, `won`, `spend`, ... */
  support: Record<string, number | null>;
  /** Populated when `compareTo` is set. */
  comparison?: {
    value: number | null;
    formatted: string;
    /** Absolute change. Null when either side is null. */
    delta: number | null;
    /** `value / comparison` - the multiple the manifest records incidents in. */
    ratio: number | null;
  };
}

export interface ResultSet {
  intent: QueryIntent;
  metric: { id: string; label: string; unit: MetricUnit; higherIsBetter: boolean };
  grain: Grain;
  dimensions: readonly DimensionId[];
  range: DateRange;
  comparisonRange: DateRange | null;
  rows: ResultRow[];
  /** Whole-range roll-up, ignoring the grain. Always exactly one row. */
  total: ResultRow | null;
  meta: {
    /** Every pipeline that ran, verbatim. This is the audit trail. */
    queries: { name: string; collection: string; pipeline: Document[] }[];
    ms: number;
    rowCount: number;
    truncated: boolean;
    notes: string[];
  };
}

type GroupDoc = Document & { _id: Document | null };

/** Support keys that stand in for "how much of this was there", best first. */
const VOLUME_KEYS = ["n", "leads", "spend_leads", "spend", "won", "measured"] as const;

function dimLabel(dim: DimensionId, raw: unknown, repNames: Map<string, string>): string {
  if (raw === null || raw === undefined || raw === "") return UNKNOWN;
  const s = typeof raw === "boolean" ? (raw ? "yes" : "no") : String(raw);
  if (dim === "owner_id") {
    const name = repNames.get(s);
    return name ? `${s} · ${name}` : s;
  }
  return s;
}

function rowKey(period: string | null, dims: Record<string, string>, order: readonly DimensionId[]): string {
  return [period ?? "", ...order.map((d) => dims[d] ?? "")].join("\u0000");
}

function periodOf(id: Document | null): string | null {
  const p = (id as Document | null)?.period;
  if (!p) return null;
  return p instanceof Date ? fmtDay(p) : fmtDay(new Date(String(p)));
}

function numeric(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function volumeOf(support: Record<string, number | null>): number {
  for (const k of VOLUME_KEYS) {
    const v = support[k];
    if (typeof v === "number") return v;
  }
  return 0;
}

async function runPart(ds: DataSource, part: CompiledPart): Promise<GroupDoc[]> {
  return (await ds.aggregate(part.collection, part.pipeline)) as GroupDoc[];
}

/**
 * Turns raw grouped documents into rows. For `cac` the two parts are joined
 * here on the group key - spend on one side, conversions on the other.
 */
function assembleRows(
  m: MetricDef,
  dimensions: readonly DimensionId[],
  parts: { name: string; docs: GroupDoc[] }[],
  repNames: Map<string, string>,
): ResultRow[] {
  const merged = new Map<string, { period: string | null; dims: Record<string, string>; acc: Record<string, number | null> }>();

  for (const part of parts) {
    for (const doc of part.docs) {
      const period = periodOf(doc._id);
      const dims: Record<string, string> = {};
      dimensions.forEach((d, i) => {
        dims[d] = dimLabel(d, (doc._id as Document | null)?.[`d${i}`], repNames);
      });
      const key = rowKey(period, dims, dimensions);
      const entry = merged.get(key) ?? { period, dims, acc: {} };
      for (const [k, v] of Object.entries(doc)) {
        if (k === "_id") continue;
        entry.acc[k] = numeric(v);
      }
      merged.set(key, entry);
    }
  }

  const supportKeys = new Set<string>(m.support);
  return [...merged.values()].map(({ period, dims, acc }) => {
    const value = m.compute(acc);
    const support: Record<string, number | null> = {};
    for (const k of Object.keys(acc)) if (supportKeys.has(k) || m.engine === "cac") support[k] = acc[k] ?? null;
    return { period, dims, value, formatted: formatValue(value, m.unit), support };
  });
}

async function repNameMap(ds: DataSource, needed: boolean): Promise<Map<string, string>> {
  if (!needed) return new Map();
  const docs = await ds.aggregate("reps", [{ $project: { name: 1 } }]);
  return new Map(docs.map((d) => [String(d._id), String(d.name)]));
}

async function runOnce(
  ds: DataSource,
  intent: QueryIntent,
  range: DateRange,
  repNames: Map<string, string>,
  opts: { grain?: Grain; restrictTo?: DimensionRestriction } = {},
): Promise<{ rows: ResultRow[]; queries: ResultSet["meta"]["queries"]; truncated: boolean }> {
  const m = metric(intent.metric);
  const compiled = compileQuery(intent, range, opts);
  const results = await Promise.all(
    compiled.parts.map(async (p) => ({ name: p.name, docs: await runPart(ds, p) })),
  );
  const truncated = results.some((r) => r.docs.length >= MAX_GROUPS);
  return {
    rows: assembleRows(m, compiled.dimensions, results, repNames),
    queries: compiled.parts.map((p) => ({ name: p.name, collection: p.collection, pipeline: p.pipeline })),
    truncated,
  };
}

/**
 * Execute an intent end to end: rank, query, compare, roll up.
 */
export async function execute(ds: DataSource, intent: QueryIntent): Promise<ResultSet> {
  const t0 = Date.now();
  const m = metric(intent.metric);
  const notes: string[] = [];
  const queries: ResultSet["meta"]["queries"] = [];
  let truncated = false;

  const repNames = await repNameMap(ds, intent.dimensions.includes("owner_id"));

  // Pass 1 - decide which dimension members make the cut, on the real metric.
  let restrictTo: DimensionRestriction | undefined;
  if (needsRanking(intent)) {
    const ranking = compileRankingQuery(intent, intent.dateRange);
    const rankResults = await Promise.all(
      ranking.parts.map(async (p) => ({ name: p.name, docs: await runPart(ds, p) })),
    );
    queries.push(
      ...ranking.parts.map((p) => ({ name: `rank:${p.name}`, collection: p.collection, pipeline: p.pipeline })),
    );
    const ranked = assembleRows(m, ranking.dimensions, rankResults, repNames)
      // A time-series chart should show the segments that carry the volume, not
      // a three-lead segment that happens to sit at 100%.
      .sort((a, b) => volumeOf(b.support) - volumeOf(a.support))
      .slice(0, intent.limit);

    if (ranked.length > 0) {
      restrictTo = {};
      for (const d of intent.dimensions) {
        const raw = new Set<string | null>();
        for (const r of ranked) {
          const label = r.dims[d];
          raw.add(label === undefined || label === UNKNOWN ? null : stripRepName(d, label));
        }
        restrictTo[d] = [...raw];
      }
    }
    if (ranked.length === intent.limit) {
      notes.push(`Showing the top ${intent.limit} by volume; other segments are omitted.`);
    }
  }

  // Pass 2 - the query the user actually asked for.
  const main = await runOnce(ds, intent, intent.dateRange, repNames, { restrictTo });
  queries.push(...main.queries);
  truncated ||= main.truncated;

  const rows = main.rows;
  rows.sort(compareRows(intent.grain, intent.dimensions));

  // Whole-range roll-up with no dimensions: one honest headline number the
  // narrator can lead with, even when the grain is fine or the top-N cut off
  // part of the population.
  const totalRun = await runOnce(ds, { ...intent, dimensions: [] }, intent.dateRange, repNames, {
    grain: "total",
  });
  const total = totalRun.rows[0] ?? null;
  queries.push(...totalRun.queries.map((q) => ({ ...q, name: `total:${q.name}` })));

  // Comparison window.
  let comparisonRange: DateRange | null = null;
  if (intent.compareTo !== "none") {
    comparisonRange =
      intent.compareTo === "previous_period"
        ? previousPeriod(intent.dateRange)
        : samePeriodLastYear(intent.dateRange);
    const prior = await runOnce(ds, intent, comparisonRange, repNames, { restrictTo });
    queries.push(...prior.queries.map((q) => ({ ...q, name: `compare:${q.name}` })));
    truncated ||= prior.truncated;
    attachComparison(rows, prior.rows, intent.grain, intent.dimensions);
    if (total) {
      const priorTotal = (
        await runOnce(ds, { ...intent, dimensions: [] }, comparisonRange, repNames, { grain: "total" })
      ).rows[0];
      if (priorTotal) attachComparison([total], [priorTotal], "total", []);
    }
  }

  notes.push(
    m.engine === "spend" || m.engine === "cac"
      ? "Bucketed by spend date; paid channels only."
      : "Bucketed by lead creation date, so a lead counts in the period it arrived.",
  );
  if (truncated) notes.push(`Result truncated at ${MAX_GROUPS} groups - narrow the date range or drop a dimension.`);

  return {
    intent,
    metric: { id: m.id, label: m.label, unit: m.unit, higherIsBetter: m.higherIsBetter },
    grain: intent.grain,
    dimensions: intent.dimensions,
    range: intent.dateRange,
    comparisonRange,
    rows,
    total,
    meta: { queries, ms: Date.now() - t0, rowCount: rows.length, truncated, notes },
  };
}

/** `REP007 · Aarti Deshpande` -> `REP007`, so the restriction matches stored values. */
function stripRepName(dim: DimensionId, label: string): string {
  if (dim !== "owner_id") return label;
  const [id] = label.split(" · ");
  return id ?? label;
}

function compareRows(grain: Grain, dimensions: readonly DimensionId[]) {
  return (a: ResultRow, b: ResultRow): number => {
    if (grain === "total") {
      // Descending by value, nulls last. Works for "best" and "worst" alike:
      // highest conversion rate and highest breach rate are both the top row.
      if (a.value === null && b.value === null) return 0;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return b.value - a.value;
    }
    const pa = a.period ?? "";
    const pb = b.period ?? "";
    if (pa !== pb) return pa < pb ? -1 : 1;
    for (const d of dimensions) {
      const da = a.dims[d] ?? "";
      const db = b.dims[d] ?? "";
      if (da !== db) return da < db ? -1 : 1;
    }
    return 0;
  };
}

/**
 * Join the comparison window onto the base rows.
 *
 * For a time series the two windows have different dates, so they are aligned
 * by position within each series - bucket 1 against bucket 1 - rather than by
 * date, which would never match.
 */
function attachComparison(
  rows: ResultRow[],
  priorRows: ResultRow[],
  grain: Grain,
  dimensions: readonly DimensionId[],
): void {
  const seriesKey = (r: ResultRow) => dimensions.map((d) => r.dims[d] ?? "").join("\u0000");

  if (grain === "total") {
    const byKey = new Map(priorRows.map((r) => [seriesKey(r), r]));
    for (const r of rows) applyComparison(r, byKey.get(seriesKey(r)));
    return;
  }

  const priorBySeries = new Map<string, ResultRow[]>();
  for (const r of [...priorRows].sort((a, b) => (a.period ?? "") < (b.period ?? "") ? -1 : 1)) {
    const k = seriesKey(r);
    priorBySeries.set(k, [...(priorBySeries.get(k) ?? []), r]);
  }
  const index = new Map<string, number>();
  for (const r of rows) {
    const k = seriesKey(r);
    const i = index.get(k) ?? 0;
    index.set(k, i + 1);
    applyComparison(r, priorBySeries.get(k)?.[i]);
  }
}

function applyComparison(row: ResultRow, prior: ResultRow | undefined): void {
  const pv = prior?.value ?? null;
  row.comparison = {
    value: pv,
    formatted: prior?.formatted ?? "n/a",
    delta: row.value !== null && pv !== null ? row.value - pv : null,
    ratio: row.value !== null && pv !== null && pv !== 0 ? row.value / pv : null,
  };
}

/** Compact rows for the narration prompt - the model sees numbers, never docs. */
export function toNarrationTable(result: ResultSet, maxRows = 60): Record<string, unknown>[] {
  return result.rows.slice(0, maxRows).map((r) => {
    const out: Record<string, unknown> = {};
    if (r.period) out.period = r.period;
    for (const [k, v] of Object.entries(r.dims)) out[k] = v;
    out[result.metric.id] = r.formatted;
    for (const [k, v] of Object.entries(r.support)) if (v !== null) out[k] = v;
    if (r.comparison) {
      out.prior = r.comparison.formatted;
      if (r.comparison.ratio !== null) out.ratio = Number(r.comparison.ratio.toFixed(3));
    }
    return out;
  });
}

/** Every figure the narrator is allowed to state, for the numeric-fidelity eval. */
export function allowedFigures(result: ResultSet): string[] {
  const out = new Set<string>();
  const push = (r: ResultRow | null) => {
    if (!r) return;
    out.add(r.formatted);
    if (r.comparison) out.add(r.comparison.formatted);
    for (const v of Object.values(r.support)) if (v !== null) out.add(String(v));
  };
  result.rows.forEach(push);
  push(result.total);
  out.delete("n/a");
  return [...out];
}
