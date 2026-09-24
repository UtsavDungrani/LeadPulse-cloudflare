/**
 * Prompt construction for the two model calls.
 *
 * Call 1 turns a question into a `QueryIntent`. Call 2 turns computed numbers
 * into prose. Nothing in between, and no arithmetic in either.
 *
 * The catalogue below is generated from the registries rather than written by
 * hand, so adding a metric or a dimension updates the prompt automatically. A
 * hand-maintained copy would be wrong within a week.
 */
import { DIMENSION_IDS, FIELDS, FIELD_IDS, FILTER_OPS, type FieldId } from "../semantic/fields";
import { METRICS, METRIC_IDS, type MetricId } from "../semantic/metrics";
import { GRAINS, COMPARE_MODES, type QueryIntent } from "../semantic/intent";
import { calendarAnchors, type DateRange } from "../semantic/dates";
import type { ResultSet } from "../semantic/execute";
import { toNarrationTable } from "../semantic/execute";
import type { ChartType } from "../semantic/chart";

export interface PromptContext {
  /** "Now" for relative-date resolution. */
  today: Date;
  /** The span the data actually covers; questions outside it cannot be answered. */
  dataWindow: DateRange;
  /** The last intent this session ran, so follow-ups can patch rather than re-guess. */
  previousIntent: QueryIntent | null;
}

function metricCatalogue(): string {
  return METRIC_IDS.map((id) => {
    const m = METRICS[id as MetricId];
    return `- ${id} (${m.unit}): ${m.description}`;
  }).join("\n");
}

function dimensionCatalogue(): string {
  return DIMENSION_IDS.map((id) => {
    const f = FIELDS[id];
    const values = "values" in f && f.values ? ` Values: ${f.values.join(", ")}.` : "";
    return `- ${id}: ${f.description}${values}`;
  }).join("\n");
}

function filterCatalogue(): string {
  return FIELD_IDS.map((id) => {
    const f = FIELDS[id as FieldId];
    return `- ${id} (${f.type})`;
  }).join("\n");
}

function anchorCatalogue(today: Date): string {
  const anchors = calendarAnchors(today);
  return Object.entries(anchors)
    .map(([name, r]) => `- ${name}: ${r.from} to ${r.to}`)
    .join("\n");
}

export function intentSystemPrompt(ctx: PromptContext): string {
  return `You are the query planner for a revenue-operations analyst working a lead pipeline.

Your only job is to turn a question into a QueryIntent by calling \`run_query\`, or to
decline by calling \`decline\`. You never compute numbers and you never write database
queries - a deterministic compiler does both from the intent you produce.

# Metrics
${metricCatalogue()}

# Dimensions (group by; at most 2)
${dimensionCatalogue()}

# Filterable fields
${filterCatalogue()}

Filter operators: ${FILTER_OPS.join(", ")}. Every filter value goes in \`values\` as an
array of strings, even for \`eq\` - the compiler coerces to the field's real type.
Use \`is_null\` for "unknown"/"missing"; many profile fields are 20-55% unknown.

# Time
Today is ${ctx.today.toISOString().slice(0, 10)}.
The data covers ${ctx.dataWindow.from} to ${ctx.dataWindow.to}; nothing exists outside it.
Resolve relative phrases with this table rather than doing the arithmetic yourself:
${anchorCatalogue(ctx.today)}

\`grain\` is one of ${GRAINS.join(", ")}. Use \`total\` when the question wants a single
number or a ranking ("which rep...", "top channels..."), and a time grain only when the
question is about a trend or a series. Match the grain to the range: \`day\` over a year
produces an unreadable chart - prefer \`week\` or \`month\`.

\`compareTo\` is one of ${COMPARE_MODES.join(", ")}. Set it whenever the question contains
a comparison ("vs last month", "compared to", "did it drop") and leave it \`none\` otherwise.

# Rules
- Split by \`lead_source\` for channel questions about leads. \`channel\` exists only for
  the spend metrics (cpl, cac) and cannot be mixed with lead dimensions.
- \`limit\` caps the series or rows kept; 10 is a sensible default, 5 for a chart.
- Prefer the narrowest set of dimensions that answers the question. Two is the maximum.

# When to decline
Call \`decline\` when the question needs something this data does not contain - revenue,
lifetime value, deal size, margin, headcount, anything about individual named people,
or a date outside the window above. Declining is a correct answer, not a failure. Say
plainly what is missing and suggest the nearest question that can be answered.

${previousIntentBlock(ctx.previousIntent)}`;
}

function previousIntentBlock(previous: QueryIntent | null): string {
  if (!previous) return "";
  return `# Previous query in this conversation
${JSON.stringify(previous, null, 2)}

If the question is a follow-up ("now break that down by city", "same for last month",
"what about Google"), start from this intent and change only the fields the follow-up
asks about. Keep everything else identical.`;
}

export function narrationSystemPrompt(allowedChartTypes: readonly ChartType[]): string {
  return `You write the two-or-three sentence read-out that goes above a chart for a
revenue-operations team.

The numbers have already been computed. You are given the exact figures. Use them
verbatim as they are formatted - never recompute, never round differently, never state a
figure that is not in the table. If you want to describe a change the table does not
give you, describe it in words instead of inventing a number.

Lead with what actually happened, then the one thing worth doing about it. No preamble,
no restating the question, no bullet lists. Name the largest movement and say whether it
is good or bad for the business given the metric's direction.

Flag honestly when the data is thin: a segment with a handful of leads is noise, and the
most recent bucket is usually incomplete.

\`chartType\` must be one of: ${allowedChartTypes.join(", ")}.
\`headline\` is a short title, under twelve words, with no trailing period.`;
}

export function narrationUserPrompt(question: string, result: ResultSet): string {
  const t = result.total;
  const compare = result.comparisonRange
    ? `Comparison window: ${result.comparisonRange.from} to ${result.comparisonRange.to} (columns "prior" and "ratio").`
    : "No comparison window was requested.";

  return `Question: ${question}

Metric: ${result.metric.label} (${result.metric.unit}); ${
    result.metric.higherIsBetter ? "higher is better" : "lower is better"
  }.
Window: ${result.range.from} to ${result.range.to}, grain ${result.grain}.
${result.dimensions.length > 0 ? `Split by: ${result.dimensions.join(", ")}.` : "No breakdown."}
${compare}
Whole-window total: ${t ? t.formatted : "n/a"}${
    t?.comparison ? ` (prior ${t.comparison.formatted})` : ""
  }.
Caveats to respect: ${result.meta.notes.join(" ")}

Rows (${result.meta.rowCount} total, first ${Math.min(result.meta.rowCount, 60)} shown):
${JSON.stringify(toNarrationTable(result), null, 1)}`;
}

/** Shown to the user when the planner declines - no second model call needed. */
export function refusalMessage(reason: string, suggestion: string): string {
  return suggestion ? `${reason}\n\nTry instead: ${suggestion}` : reason;
}
