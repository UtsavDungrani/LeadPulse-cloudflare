/**
 * The renderer for `ChartSpec`.
 *
 * This is the other half of the Phase 1 contract: the agent returns a typed
 * description of what to draw, and this file is the only thing that decides how.
 * No chart library - the spec is deliberately narrow, and hand-drawn SVG keeps
 * the mark specs (thin bars, 2px lines, a 2px surface gap between fills, a 2px
 * surface ring on markers) exactly as specified instead of fighting a library's
 * defaults.
 *
 * Colour rules that are not negotiable, and are enforced here rather than left
 * to the caller:
 *  - Series take palette slots **in a fixed order by identity**. Filtering the
 *    data never repaints the survivors - a reader who learned "Google is blue"
 *    stays right. Switching chart form does not repaint them either.
 *  - Past eight series the tail folds into a single grey "Other" rather than
 *    cycling hues, because a ninth generated colour is indistinguishable from an
 *    existing slot under colour-vision deficiency.
 *  - One axis, always. There is no code path here that draws a second y-scale.
 *  - Text wears text tokens. A number is never printed in its series colour;
 *    the mark beside it carries the identity.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import {
  CHART_LABELS,
  SERIES_SLOTS,
  chartShape,
  compatibleCharts,
  excludedCharts,
  type ChartSpec,
  type ChartType,
} from "../semantic/chart";
import type { AnswerPoint } from "../agents/analyst";

/** The palette has this many categorical slots; the rules know it too. */
const SLOTS = SERIES_SLOTS;
const PAD = { top: 16, right: 20, bottom: 34, left: 56 };
const H = 260;
const WIDTH = 900;

export interface Series {
  key: string;
  color: string;
  points: AnswerPoint[];
}

/** Palette slot for the nth distinct series. Grey once past the eighth. */
function slotColor(index: number): string {
  return index < SLOTS ? `var(--series-${index + 1})` : "var(--series-other)";
}

/** Whether this result is a time series at all. Drives every axis decision below. */
function hasTime(points: AnswerPoint[]): boolean {
  return points.some((p) => p.period !== null);
}

/**
 * What a point is called once its own axis is gone.
 *
 * Ranked bars, pie, donut and treemap all collapse an axis to get a single
 * number per thing, and they have to agree about what the thing *is*: every
 * dimension the point carries, or - when it carries none, because the only
 * axis was time - the period itself. Getting this wrong silently merges rows
 * that are not the same row, which is a wrong chart that looks fine.
 */
function sliceKey(spec: ChartSpec, p: AnswerPoint): string {
  const dims = [spec.x, ...spec.series].filter((d) => p.dims[d] !== undefined);
  if (dims.length > 0) return dims.map((d) => p.dims[d]).join(" / ");
  return p.period ?? "—";
}

/**
 * Group points into series, ordered by total magnitude so the biggest thing on
 * the chart gets slot 1. Ordering by size is stable for a given result, and the
 * key point is that colour follows the *series key*, not its row number.
 */
export function toSeries(spec: ChartSpec, points: AnswerPoint[]): Series[] {
  const keyOf = (p: AnswerPoint) =>
    spec.series.length === 0 ? "" : spec.series.map((d) => p.dims[d] ?? "—").join(" · ");

  const groups = new Map<string, AnswerPoint[]>();
  for (const p of points) {
    const k = keyOf(p);
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }

  const magnitude = (ps: AnswerPoint[]) => ps.reduce((a, p) => a + Math.abs(p.value ?? 0), 0);
  const ordered = [...groups.entries()].sort((a, b) => magnitude(b[1]) - magnitude(a[1]));

  if (ordered.length <= SLOTS) {
    return ordered.map(([key, ps], i) => ({ key, color: slotColor(i), points: ps }));
  }
  // Fold the tail rather than inventing a ninth hue. The count is part of the
  // label because this dataset has a lead source genuinely called "Other", and
  // two different things called the same thing in one legend is a wrong chart.
  const head = ordered.slice(0, SLOTS - 1);
  const tail = ordered.slice(SLOTS - 1);
  return [
    ...head.map(([key, ps], i) => ({ key, color: slotColor(i), points: ps })),
    {
      key: `Other (${tail.length})`,
      color: "var(--series-other)",
      points: tail.flatMap(([, ps]) => ps),
    },
  ];
}

interface Slice {
  key: string;
  color: string;
  value: number;
  formatted: string;
  share: number;
}

/**
 * A value printed in full, not abbreviated.
 *
 * Axis ticks may say ₹1.2L because there are six of them and they only have to
 * order the plot. A label attached to one mark is a reading of that mark, and
 * it should match the table underneath it.
 */
function formatExact(v: number, unit: ChartSpec["yUnit"]): string {
  switch (unit) {
    case "rate":
      return `${(v * 100).toFixed(1)}%`;
    case "currency_inr":
      return `₹${Math.round(v).toLocaleString("en-IN")}`;
    case "days":
      return `${v.toFixed(1)}d`;
    default:
      return Math.round(v).toLocaleString("en-IN");
  }
}

/**
 * The part-to-whole view of a categorical result.
 *
 * Pie, donut and treemap all need the same thing - one number per category,
 * biggest first, as a share of the total - so they share one preparation and
 * therefore one set of colours. Flipping between those three forms never moves
 * a category to a different hue.
 */
function toSlices(spec: ChartSpec, points: AnswerPoint[], fold = true): Slice[] {
  const byLabel = new Map<string, { value: number; formatted: string; n: number }>();
  for (const p of points) {
    const k = sliceKey(spec, p);
    const prior = byLabel.get(k);
    // Summing is only ever reached for an additive measure: `compatibleCharts`
    // does not offer any of these forms for a rate or an average, because
    // adding those up produces a number that was never true of anything.
    byLabel.set(k, {
      value: (prior?.value ?? 0) + Math.max(p.value ?? 0, 0),
      // One contributing point keeps the server's own formatting, which is
      // more precise than anything reconstructed from the float.
      formatted: prior ? "" : p.formatted,
      n: (prior?.n ?? 0) + 1,
    });
  }
  const ordered = [...byLabel.entries()].sort((a, b) => b[1].value - a[1].value);
  // Folding exists because the palette has eight slots. A form where colour
  // carries identity has to fold; ranked bars, which are one colour and use
  // position instead, have no reason to hide the ninth row.
  const folding = fold && ordered.length > SLOTS;
  const head = folding ? ordered.slice(0, SLOTS - 1) : ordered;

  const cells = head.map(([key, v], i) => ({
    key,
    color: slotColor(i),
    value: v.value,
    formatted: v.n === 1 ? v.formatted : "",
  }));
  if (folding) {
    cells.push({
      key: `Other (${ordered.length - SLOTS + 1})`,
      color: "var(--series-other)",
      value: ordered.slice(SLOTS - 1).reduce((a, [, v]) => a + v.value, 0),
      formatted: "",
    });
  }
  const total = cells.reduce((a, c) => a + c.value, 0) || 1;
  return cells.map((c) => ({
    ...c,
    share: c.value / total,
    formatted: c.formatted || formatExact(c.value, spec.yUnit),
  }));
}

function formatTick(v: number, unit: ChartSpec["yUnit"]): string {
  switch (unit) {
    case "rate":
      return `${(v * 100).toFixed(v < 0.1 ? 1 : 0)}%`;
    case "currency_inr":
      return v >= 100_000 ? `₹${(v / 100_000).toFixed(1)}L` : `₹${Math.round(v).toLocaleString("en-IN")}`;
    case "days":
      return `${v.toFixed(0)}d`;
    default:
      return v >= 10_000 ? `${(v / 1000).toFixed(0)}K` : Math.round(v).toLocaleString("en-IN");
  }
}

/** Clean axis ticks: 0 / 1,000 / 2,000, not 0 / 1,137 / 2,274. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(v);
  return ticks;
}

/**
 * Period labels with the year dropped when every period shares one. `2026-06-01`
 * reads as `06-01`, and the year is said once, in the title.
 */
function periodLabel(period: string, all: string[]): string {
  const years = new Set(all.map((p) => p.slice(0, 4)));
  return years.size === 1 && period.length > 7 ? period.slice(5) : period;
}

interface Hover {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ hover }: { hover: Hover | null }) {
  if (!hover) return null;
  const isRight = typeof window !== "undefined" && hover.x > window.innerWidth - 260;
  const isBottom = typeof window !== "undefined" && hover.y > window.innerHeight - 160;
  const left = isRight ? hover.x - 240 : hover.x + 14;
  const top = isBottom ? hover.y - 120 : hover.y - 10;

  return (
    <div
      className="chart-tooltip"
      style={{ left: Math.max(10, left), top: Math.max(10, top) }}
      role="presentation"
    >
      {hover.content}
    </div>
  );
}

/** Every mark in this file is hoverable, so binding one is a one-liner. */
function useHover() {
  const [hover, setHover] = useState<Hover | null>(null);
  const bind = (content: ReactNode) => ({
    onMouseMove: (e: React.MouseEvent) => setHover({ x: e.clientX, y: e.clientY, content }),
    onMouseLeave: () => setHover(null),
  });
  return { hover, setHover, bind };
}

function Legend({
  items,
  activeKey,
  onHover,
  onClick,
}: {
  items: { key: string; color: string }[];
  activeKey?: string | null;
  onHover?: (key: string | null) => void;
  onClick?: (key: string | null) => void;
}) {
  // One series needs no legend - the title already names it.
  if (items.length < 2) return null;
  return (
    <div className="legend" role="group" aria-label="Series legend">
      {items.map((s) => {
        const isDimmed = Boolean(activeKey && activeKey !== s.key);
        const isActive = activeKey === s.key;
        return (
          <span
            key={s.key}
            className={`${isActive ? "active" : ""} ${isDimmed ? "dimmed" : ""}`}
            style={{ opacity: isDimmed ? 0.35 : 1 }}
            onMouseEnter={() => onHover?.(s.key)}
            onMouseLeave={() => onHover?.(null)}
            onClick={() => onClick?.(activeKey === s.key ? null : s.key)}
            title={activeKey === s.key ? "Click to reset view" : "Click to isolate this series"}
          >
            <i style={{ background: s.color }} aria-hidden="true" />
            {s.key}
          </span>
        );
      })}
    </div>
  );
}

export interface AnnotationMark {
  at: number;
  note: string;
  date: string;
}

function timeAnnotations(
  spec: ChartSpec,
  periods: string[],
  posOf: (i: number) => number,
): AnnotationMark[] {
  if (!spec.annotations || spec.annotations.length === 0) return [];
  const out: AnnotationMark[] = [];
  for (const ann of spec.annotations) {
    const idx = periods.indexOf(ann.at);
    if (idx !== -1) {
      out.push({ at: posOf(idx), note: ann.note, date: ann.at });
    }
  }
  return out;
}

/** Shared plot frame: gridlines, y ticks, x labels, and incident annotations. */
function Frame({
  width,
  yMax,
  unit,
  xLabels,
  annotations,
  children,
  svgRef,
  onMouseMove,
  onMouseLeave,
}: {
  width: number;
  yMax: number;
  unit: ChartSpec["yUnit"];
  xLabels: { at: number; text: string }[];
  annotations?: AnnotationMark[];
  children: ReactNode;
  svgRef?: React.RefObject<SVGSVGElement | null>;
  onMouseMove?: (e: React.MouseEvent<SVGSVGElement>) => void;
  onMouseLeave?: () => void;
}) {
  const { hover, bind } = useHover();
  const plotH = H - PAD.top - PAD.bottom;
  const ticks = niceTicks(yMax);
  const top = ticks[ticks.length - 1] || 1;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;

  return (
    <>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${H}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text x={PAD.left - 10} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">
              {formatTick(t, unit)}
            </text>
          </g>
        ))}
        <line
          x1={PAD.left}
          x2={width - PAD.right}
          y1={y(0)}
          y2={y(0)}
          stroke="var(--axis)"
          strokeWidth={1}
        />
        {xLabels.map((l, i) => (
          <text
            key={`${l.text}-${i}`}
            x={l.at}
            y={H - 12}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {l.text}
          </text>
        ))}
        {annotations?.map((ann, i) => (
          <g key={`ann-${i}`}>
            <line
              x1={ann.at}
              x2={ann.at}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke="var(--warning)"
              strokeWidth={1.5}
              strokeDasharray="3 3"
              opacity={0.85}
            />
            <g
              transform={`translate(${ann.at}, ${PAD.top})`}
              style={{ cursor: "pointer" }}
              {...bind(
                <div className="chart-tooltip-panel">
                  <div className="chart-tooltip-header">
                    <strong>Incident / Note</strong>
                    <span className="chart-tooltip-period-sub">{ann.date}</span>
                  </div>
                  <div style={{ color: "var(--text-secondary)", fontSize: "12px", maxWidth: 220 }}>
                    {ann.note}
                  </div>
                </div>,
              )}
            >
              <rect
                x={-16}
                y={-14}
                width={32}
                height={16}
                rx={4}
                fill="var(--surface-1)"
                stroke="var(--warning)"
                strokeWidth={1.2}
              />
              <text
                x={0}
                y={-3}
                textAnchor="middle"
                fontSize={9}
                fontWeight={700}
                fill="var(--warning)"
              >
                NOTE
              </text>
            </g>
          </g>
        ))}
        {children}
      </svg>
      <Tooltip hover={hover} />
    </>
  );
}

/** Keep the x axis readable: at most ~8 labels, evenly spaced. */
function thinLabels<T>(items: T[], max = 8): number[] {
  if (items.length <= max) return items.map((_, i) => i);
  const step = Math.ceil(items.length / max);
  return items.map((_, i) => i).filter((i) => i % step === 0);
}

/**
 * Everything a time-axis chart needs, computed once.
 *
 * Line, area, columns, grouped columns, stacked columns and stacked areas all
 * want the same periods, the same scale and the same label thinning. Deriving
 * that six times is how six charts end up with five different y axes.
 */
function timeScale(spec: ChartSpec, points: AnswerPoint[], stacked: boolean, width: number) {
  const series = toSeries(spec, points);
  const periods = [...new Set(points.map((p) => p.period ?? ""))].sort();
  const plotH = H - PAD.top - PAD.bottom;
  const plotW = width - PAD.left - PAD.right;

  const perPeriodTotal = periods.map((c) =>
    points.filter((p) => (p.period ?? "") === c).reduce((a, p) => a + (p.value ?? 0), 0),
  );
  const yMax = stacked ? Math.max(...perPeriodTotal, 0) : Math.max(...points.map((p) => p.value ?? 0), 0);
  const ticks = niceTicks(yMax);
  const top = ticks[ticks.length - 1] || 1;
  const band = plotW / Math.max(periods.length, 1);

  return {
    series,
    periods,
    yMax,
    band,
    y: (v: number) => PAD.top + plotH - (v / top) * plotH,
    /** Centre of a band - what a column or a bubble sits on. */
    cx: (i: number) => PAD.left + band * i + band / 2,
    /** Edge to edge - what a continuous line rides. */
    lx: (i: number) => PAD.left + (periods.length === 1 ? plotW / 2 : (i / (periods.length - 1)) * plotW),
    labels: (at: (i: number) => number) =>
      thinLabels(periods).map((i) => ({ at: at(i), text: periodLabel(periods[i]!, periods) })),
  };
}

/* ---------------------------------------------------------------- time forms */

/**
 * Line, area and stacked area.
 *
 * One component, because they differ only in what is drawn beneath the line.
 * An unstacked area is single-series only: two translucent fills over each
 * other produce a third colour that is in neither palette and means nothing.
 */
function LineChart({
  spec,
  points,
  width,
  filled,
  stacked,
  activeSeries,
  onActiveSeriesChange,
}: {
  spec: ChartSpec;
  points: AnswerPoint[];
  width: number;
  filled?: boolean;
  stacked?: boolean;
  activeSeries?: string | null;
  onActiveSeriesChange?: (key: string | null) => void;
}) {
  const { hover, setHover, bind } = useHover();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const s = timeScale(spec, points, Boolean(stacked), width);
  const gradient = useId().replace(/:/g, "");
  const baseline = new Map<string, number>();
  const anns = timeAnnotations(spec, s.periods, s.lx);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || s.periods.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * width;
    if (svgX < PAD.left - 10 || svgX > width - PAD.right + 10) {
      setHoveredIdx(null);
      setHover(null);
      return;
    }

    let closestIdx = 0;
    let minDist = Infinity;
    s.periods.forEach((_, i) => {
      const px = s.lx(i);
      const dist = Math.abs(svgX - px);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    });

    setHoveredIdx(closestIdx);
    const period = s.periods[closestIdx];
    if (!period) return;

    const seriesValues = s.series
      .map((ser) => {
        const p = ser.points.find((q) => (q.period ?? "") === period);
        return {
          key: ser.key,
          color: ser.color,
          value: p?.value ?? null,
          formatted: p?.formatted ?? "—",
          comparison: p?.comparison ?? null,
        };
      })
      .filter((ser) => ser.value !== null);

    setHover({
      x: e.clientX,
      y: e.clientY,
      content: (
        <div className="chart-tooltip-panel">
          <div className="chart-tooltip-header">
            <strong>{periodLabel(period, s.periods)}</strong>
            <span className="chart-tooltip-period-sub">{period}</span>
          </div>
          <div className="chart-tooltip-body">
            {seriesValues.map((sv) => (
              <div key={sv.key || "val"} className="chart-tooltip-row">
                <span className="chart-tooltip-label">
                  <i style={{ background: sv.color }} className="chart-tooltip-dot" />
                  {sv.key || spec.y}
                </span>
                <span className="chart-tooltip-val">
                  <b>{sv.formatted}</b>
                  {sv.comparison !== null && (
                    <span className={`chart-tooltip-delta ${(sv.value ?? 0) >= sv.comparison ? "good" : "bad"}`}>
                      {((sv.value ?? 0) >= sv.comparison ? "+" : "") +
                        formatTick((sv.value ?? 0) - sv.comparison, spec.yUnit)}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ),
    });
  };

  const handleMouseLeave = () => {
    setHoveredIdx(null);
    setHover(null);
  };

  return (
    <>
      <Frame
        width={width}
        yMax={s.yMax}
        unit={spec.yUnit}
        xLabels={s.labels(s.lx)}
        annotations={anns}
        svgRef={svgRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Vertical crosshair guideline snapping to period */}
        {hoveredIdx !== null && (
          <line
            x1={s.lx(hoveredIdx)}
            x2={s.lx(hoveredIdx)}
            y1={PAD.top}
            y2={H - PAD.bottom}
            stroke="var(--axis)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            pointerEvents="none"
          />
        )}
        {s.series.map((series, si) => {
          const drawable = s.periods
            .map((period, i) => ({ period, i, p: series.points.find((q) => (q.period ?? "") === period) }))
            .filter((d): d is { period: string; i: number; p: AnswerPoint } => Boolean(d.p) && d.p!.value !== null);

          const base = (period: string) => (stacked ? (baseline.get(period) ?? 0) : 0);
          const topOf = (d: (typeof drawable)[number]) => base(d.period) + (d.p.value ?? 0);
          const path = drawable.map((d, i) => `${i === 0 ? "M" : "L"} ${s.lx(d.i)} ${s.y(topOf(d))}`).join(" ");
          const area =
            drawable.length > 0
              ? `${path} ${[...drawable]
                  .reverse()
                  .map((d) => `L ${s.lx(d.i)} ${s.y(base(d.period))}`)
                  .join(" ")} Z`
              : "";

          if (stacked) for (const d of drawable) baseline.set(d.period, topOf(d));

          const isDimmed = Boolean(activeSeries && series.key && series.key !== activeSeries);
          const isFocused = Boolean(activeSeries && series.key === activeSeries);

          return (
            <g
              key={series.key || "one"}
              style={{
                opacity: isDimmed ? 0.2 : 1,
                transition: "opacity 0.2s ease",
              }}
            >
              {(filled || stacked) && (
                <>
                  <defs>
                    <linearGradient id={`${gradient}-${si}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={series.color} stopOpacity={stacked ? 0.85 : 0.35} />
                      <stop offset="100%" stopColor={series.color} stopOpacity={stacked ? 0.85 : 0.02} />
                    </linearGradient>
                  </defs>
                  <path d={area} fill={`url(#${gradient}-${si})`} stroke="none" />
                </>
              )}
              <path
                d={path}
                fill="none"
                stroke={series.color}
                strokeWidth={isFocused ? 3 : 2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {drawable.map((d) => {
                const isHovered = hoveredIdx === d.i;
                return (
                  <circle
                    key={`${series.key}-${d.period}`}
                    cx={s.lx(d.i)}
                    cy={s.y(topOf(d))}
                    r={isHovered ? 6 : 4}
                    fill={series.color}
                    stroke="var(--surface-1)"
                    strokeWidth={isHovered ? 2.5 : 2}
                    style={{ transition: "r 0.15s ease" }}
                    {...bind(
                      <div className="chart-tooltip-panel">
                        <div className="chart-tooltip-header">
                          <strong>{periodLabel(d.period, s.periods)}</strong>
                          <span className="chart-tooltip-period-sub">{d.period}</span>
                        </div>
                        <div className="chart-tooltip-row">
                          <span className="chart-tooltip-label">
                            <i style={{ background: series.color }} className="chart-tooltip-dot" />
                            {series.key || spec.y}
                          </span>
                          <span className="chart-tooltip-val">{d.p.formatted}</span>
                        </div>
                      </div>,
                    )}
                  />
                );
              })}
            </g>
          );
        })}
      </Frame>
      <Legend
        items={s.series}
        activeKey={activeSeries}
        onHover={onActiveSeriesChange}
        onClick={(k) => onActiveSeriesChange?.(activeSeries === k ? null : k)}
      />
      <Tooltip hover={hover} />
    </>
  );
}

/**
 * Columns over a time axis: plain, stacked and grouped.
 *
 * Counts and money stack; rates never do, which is why `compatibleCharts` only
 * offers the stacked form when the unit is additive. Grouping is capped at four
 * series and ten periods, past which the bars are narrower than their own gaps.
 */
function Columns({
  spec,
  points,
  width,
  mode,
  activeSeries,
  onActiveSeriesChange,
}: {
  spec: ChartSpec;
  points: AnswerPoint[];
  width: number;
  mode: "single" | "stacked" | "grouped";
  activeSeries?: string | null;
  onActiveSeriesChange?: (key: string | null) => void;
}) {
  const { hover, setHover, bind } = useHover();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const s = timeScale(spec, points, mode === "stacked", width);
  const lanes = mode === "grouped" ? s.series.length : 1;
  const groupW = Math.min(24 * lanes + 2 * (lanes - 1), s.band * 0.72);
  const barW = mode === "grouped" ? Math.max(3, (groupW - 2 * (lanes - 1)) / lanes) : Math.min(24, s.band * 0.62);
  const anns = timeAnnotations(spec, s.periods, s.cx);

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!svgRef.current || s.periods.length === 0) return;
    const rect = svgRef.current.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * width;
    if (svgX < PAD.left - 10 || svgX > width - PAD.right + 10) {
      setHoveredIdx(null);
      setHover(null);
      return;
    }

    let closestIdx = 0;
    let minDist = Infinity;
    s.periods.forEach((_, i) => {
      const cx = s.cx(i);
      const dist = Math.abs(svgX - cx);
      if (dist < minDist) {
        minDist = dist;
        closestIdx = i;
      }
    });

    setHoveredIdx(closestIdx);
    const period = s.periods[closestIdx];
    if (!period) return;

    const seriesValues = s.series
      .map((ser) => {
        const p = ser.points.find((q) => (q.period ?? "") === period);
        return {
          key: ser.key,
          color: ser.color,
          value: p?.value ?? null,
          formatted: p?.formatted ?? "—",
          comparison: p?.comparison ?? null,
        };
      })
      .filter((ser) => ser.value !== null);

    const bucketTotal = seriesValues.reduce((a, sv) => a + (sv.value ?? 0), 0);

    setHover({
      x: e.clientX,
      y: e.clientY,
      content: (
        <div className="chart-tooltip-panel">
          <div className="chart-tooltip-header">
            <strong>{periodLabel(period, s.periods)}</strong>
            <span className="chart-tooltip-period-sub">{period}</span>
          </div>
          {mode === "stacked" && seriesValues.length > 1 && (
            <div className="chart-tooltip-row" style={{ borderBottom: "1px dashed var(--border)", paddingBottom: 4 }}>
              <span className="chart-tooltip-label">
                <strong>Bucket Total</strong>
              </span>
              <span className="chart-tooltip-val">
                <b>{formatExact(bucketTotal, spec.yUnit)}</b>
              </span>
            </div>
          )}
          <div className="chart-tooltip-body">
            {seriesValues.map((sv) => (
              <div key={sv.key || "val"} className="chart-tooltip-row">
                <span className="chart-tooltip-label">
                  <i style={{ background: sv.color }} className="chart-tooltip-dot" />
                  {sv.key || spec.y}
                </span>
                <span className="chart-tooltip-val">
                  <b>{sv.formatted}</b>
                  {mode === "stacked" && bucketTotal > 0 && sv.value !== null && (
                    <span className="chart-tooltip-period-sub">({((sv.value / bucketTotal) * 100).toFixed(0)}%)</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>
      ),
    });
  };

  const handleMouseLeave = () => {
    setHoveredIdx(null);
    setHover(null);
  };

  return (
    <>
      <Frame
        width={width}
        yMax={s.yMax}
        unit={spec.yUnit}
        xLabels={s.labels(s.cx)}
        annotations={anns}
        svgRef={svgRef}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        {/* Subtle background highlight for the active period bucket */}
        {hoveredIdx !== null && (
          <rect
            x={s.cx(hoveredIdx) - s.band / 2 + 2}
            y={PAD.top}
            width={Math.max(0, s.band - 4)}
            height={H - PAD.top - PAD.bottom}
            fill="var(--axis)"
            fillOpacity={0.08}
            rx={4}
            pointerEvents="none"
          />
        )}
        {s.periods.map((period, i) => {
          let acc = 0;
          return s.series.map((series, si) => {
            const p = series.points.find((q) => (q.period ?? "") === period);
            const v = p?.value ?? 0;
            if (v <= 0) return null;
            const y1 = mode === "stacked" ? s.y(acc + v) : s.y(v);
            const y0 = mode === "stacked" ? s.y(acc) : s.y(0);
            if (mode === "stacked") acc += v;
            const h = Math.max(0, y0 - y1 - (mode === "stacked" ? 2 : 0));
            const x = mode === "grouped" ? s.cx(i) - groupW / 2 + si * (barW + 2) : s.cx(i) - barW / 2;

            const isDimmed = Boolean(activeSeries && series.key && series.key !== activeSeries);

            return (
              <rect
                key={`${period}-${series.key || "one"}`}
                x={x}
                y={y1}
                width={barW}
                height={h}
                rx={3}
                fill={series.color}
                opacity={isDimmed ? 0.25 : 1}
                style={{ transition: "opacity 0.2s ease, y 0.2s ease, height 0.2s ease" }}
                {...bind(
                  <div className="chart-tooltip-panel">
                    <div className="chart-tooltip-header">
                      <strong>{periodLabel(period, s.periods)}</strong>
                      <span className="chart-tooltip-period-sub">{period}</span>
                    </div>
                    <div className="chart-tooltip-row">
                      <span className="chart-tooltip-label">
                        <i style={{ background: series.color }} className="chart-tooltip-dot" />
                        {series.key || spec.y}
                      </span>
                      <span className="chart-tooltip-val">{p?.formatted}</span>
                    </div>
                  </div>,
                )}
              />
            );
          });
        })}
      </Frame>
      <Legend
        items={s.series}
        activeKey={activeSeries}
        onHover={onActiveSeriesChange}
        onClick={(k) => onActiveSeriesChange?.(activeSeries === k ? null : k)}
      />
      <Tooltip hover={hover} />
    </>
  );
}

/**
 * A timeline: when each thing happened, and how big it was.
 *
 * For single series: an interactive milestone/event timeline with a chronological
 * baseline track, vertical event stems, pin heads, peak badges, and soft trend
 * shading.
 * For multi-series: swimlanes (one lane per series, one bubble per period)
 * with crosshair guides and isolated inspection.
 */
function Timeline({
  spec,
  points,
  width,
  activeSeries,
  onActiveSeriesChange,
}: {
  spec: ChartSpec;
  points: AnswerPoint[];
  width: number;
  activeSeries?: string | null;
  onActiveSeriesChange?: (key: string | null) => void;
}) {
  const { hover, setHover, bind } = useHover();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const series = toSeries(spec, points);
  const periods = [...new Set(points.map((p) => p.period ?? ""))].sort();
  const gradientId = useId().replace(/:/g, "");

  if (periods.length === 0) return null;

  // Single series: Interactive Milestone Event Timeline
  if (series.length <= 1) {
    const s = series[0] ?? { key: spec.y, color: "var(--series-1)", points };
    const pts = periods.map((period) => s.points.find((p) => (p.period ?? "") === period) ?? null);
    const validPts = pts.filter((p): p is AnswerPoint => p !== null && p.value !== null);
    const maxVal = Math.max(...validPts.map((p) => p.value ?? 0), 1);
    const totalVal = validPts.reduce((acc, p) => acc + (p.value ?? 0), 0);
    const avgVal = validPts.length > 0 ? totalVal / validPts.length : 0;

    let peakIdx = -1;
    let highest = -Infinity;
    pts.forEach((p, idx) => {
      const v = p?.value ?? 0;
      if (v > highest) {
        highest = v;
        peakIdx = idx;
      }
    });
    const peakPoint = peakIdx !== -1 ? pts[peakIdx] : null;

    const height = 195;
    const baselineY = 138;
    const gutter = 36;
    const plotW = Math.max(width - gutter * 2, 100);
    const x = (i: number) =>
      gutter + (periods.length <= 1 ? plotW / 2 : (i / (periods.length - 1)) * plotW);

    const stemTop = (val: number) => baselineY - Math.max(12, (val / maxVal) * 78);

    const areaPoints = pts
      .map((p, i) => ({ x: x(i), y: stemTop(p?.value ?? 0) }))
      .filter((_, i) => pts[i] !== null);

    const areaPath =
      areaPoints.length > 1
        ? `M ${areaPoints[0]!.x} ${baselineY} ` +
          areaPoints.map((pt) => `L ${pt.x} ${pt.y}`).join(" ") +
          ` L ${areaPoints[areaPoints.length - 1]!.x} ${baselineY} Z`
        : "";

    const anns = timeAnnotations(spec, periods, x);

    return (
      <div className="timeline-wrapper">
        <div className="timeline-summary-bar">
          {peakPoint && maxVal > 0 && (
            <div className="timeline-stat">
              <span>Peak Activity:</span>
              <strong>{peakPoint.formatted}</strong>
              <span className="timeline-stat-sub">
                ({periodLabel(peakPoint.period ?? "", periods)})
              </span>
            </div>
          )}
          <div className="timeline-stat">
            <span>Total Volume:</span>
            <strong>{totalVal.toLocaleString("en-IN")}</strong>
          </div>
          <div className="timeline-stat">
            <span>Daily Average:</span>
            <strong>{formatTick(avgVal, spec.yUnit)}</strong>
          </div>
        </div>

        <svg
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: "100%", height: "auto", display: "block" }}
          role="img"
          onMouseLeave={() => {
            setHoveredIdx(null);
            setHover(null);
          }}
        >
          <defs>
            <linearGradient id={`tl-grad-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.2" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
            </linearGradient>
            <filter id={`tl-glow-${gradientId}`} x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="1.5" stdDeviation="2.5" floodColor="rgba(0,0,0,0.18)" />
            </filter>
          </defs>

          {/* Soft background trend silhouette */}
          {areaPath && <path d={areaPath} fill={`url(#tl-grad-${gradientId})`} pointerEvents="none" />}

          {/* Baseline chronological track */}
          <line
            x1={gutter - 12}
            x2={width - gutter + 12}
            y1={baselineY}
            y2={baselineY}
            stroke="var(--axis)"
            strokeWidth={1.75}
            strokeLinecap="round"
          />
          <circle cx={gutter - 12} cy={baselineY} r={3} fill="var(--axis)" />
          <circle cx={width - gutter + 12} cy={baselineY} r={3} fill="var(--axis)" />

          {/* Incident / Note annotations */}
          {anns.map((ann, i) => (
            <g key={`ann-${i}`}>
              <line
                x1={ann.at}
                x2={ann.at}
                y1={20}
                y2={baselineY}
                stroke="var(--warning)"
                strokeWidth={1.5}
                strokeDasharray="3 3"
                opacity={0.85}
              />
              <g
                transform={`translate(${ann.at}, 20)`}
                style={{ cursor: "pointer" }}
                {...bind(
                  <div className="chart-tooltip-panel">
                    <div className="chart-tooltip-header">
                      <strong>Incident / Note</strong>
                      <span className="chart-tooltip-period-sub">{ann.date}</span>
                    </div>
                    <div style={{ color: "var(--text-secondary)", fontSize: "12px", maxWidth: 220 }}>
                      {ann.note}
                    </div>
                  </div>,
                )}
              >
                <rect x={-16} y={-14} width={32} height={16} rx={4} fill="var(--surface-1)" stroke="var(--warning)" strokeWidth={1.2} />
                <text x={0} y={-3} textAnchor="middle" fontSize={9} fontWeight={700} fill="var(--warning)">
                  NOTE
                </text>
              </g>
            </g>
          ))}

          {/* Event Pins & Stems */}
          {pts.map((p, i) => {
            const val = p?.value ?? 0;
            const px = x(i);
            const py = stemTop(val);
            const isPeak = i === peakIdx && maxVal > 0;
            const isHovered = hoveredIdx === i;
            const colW = periods.length > 1 ? plotW / (periods.length - 1) : plotW;

            return (
              <g key={periods[i]} style={{ cursor: "pointer" }}>
                {/* Baseline notch */}
                <line
                  x1={px}
                  x2={px}
                  y1={baselineY}
                  y2={baselineY + 4}
                  stroke={isHovered ? "var(--text-primary)" : "var(--axis)"}
                  strokeWidth={isHovered ? 2 : 1}
                />

                {/* Vertical stem */}
                <line
                  x1={px}
                  x2={px}
                  y1={baselineY}
                  y2={py}
                  stroke={isHovered ? "var(--text-primary)" : isPeak ? s.color : "var(--axis)"}
                  strokeWidth={isHovered ? 2.5 : isPeak ? 2 : 1.2}
                  strokeDasharray={isPeak || isHovered ? "none" : "2 2"}
                />

                {/* Pin head */}
                <circle
                  cx={px}
                  cy={py}
                  r={isHovered ? 8 : isPeak ? 7 : 4.5}
                  fill={isHovered ? "var(--surface-1)" : isPeak ? s.color : "var(--surface-1)"}
                  fillOpacity={isPeak && !isHovered ? 0.35 : 1}
                  stroke={isHovered ? "var(--text-primary)" : s.color}
                  strokeWidth={isHovered ? 2.5 : 2}
                  filter={isPeak || isHovered ? `url(#tl-glow-${gradientId})` : "none"}
                />
                <circle
                  cx={px}
                  cy={py}
                  r={isHovered ? 4 : isPeak ? 3.5 : 2}
                  fill={isHovered ? "var(--text-primary)" : s.color}
                />

                {/* Peak Callout Badge */}
                {isPeak && (
                  <g transform={`translate(${px}, ${py - 16})`}>
                    <rect
                      x={-34}
                      y={-14}
                      width={68}
                      height={18}
                      rx={9}
                      fill="var(--surface-1)"
                      stroke={s.color}
                      strokeWidth={1.5}
                      filter={`url(#tl-glow-${gradientId})`}
                    />
                    <text
                      x={0}
                      y={-2}
                      textAnchor="middle"
                      fontSize={10}
                      fontWeight={700}
                      fill={s.color}
                    >
                      ★ {p?.formatted}
                    </text>
                  </g>
                )}

                {/* Hover value badge when not peak */}
                {isHovered && !isPeak && (
                  <g transform={`translate(${px}, ${py - 14})`}>
                    <rect
                      x={-26}
                      y={-14}
                      width={52}
                      height={17}
                      rx={8.5}
                      fill="var(--surface-1)"
                      stroke="var(--text-primary)"
                      strokeWidth={1.2}
                      filter={`url(#tl-glow-${gradientId})`}
                    />
                    <text
                      x={0}
                      y={-2}
                      textAnchor="middle"
                      fontSize={9.5}
                      fontWeight={600}
                      fill="var(--text-primary)"
                    >
                      {p?.formatted}
                    </text>
                  </g>
                )}

                {/* Transparent hit target for hover */}
                <rect
                  x={px - colW / 2}
                  y={15}
                  width={colW}
                  height={baselineY - 15}
                  fill="transparent"
                  onMouseEnter={(e) => {
                    setHoveredIdx(i);
                    const period = periods[i] ?? "";
                    const deltaAvg = val - avgVal;
                    setHover({
                      x: e.clientX,
                      y: e.clientY,
                      content: (
                        <div className="chart-tooltip-panel">
                          <div className="chart-tooltip-header">
                            <strong>{periodLabel(period, periods)}</strong>
                            <span className="chart-tooltip-period-sub">{period}</span>
                          </div>
                          <div className="chart-tooltip-body">
                            <div className="chart-tooltip-row">
                              <span className="chart-tooltip-label">
                                <i style={{ background: s.color }} className="chart-tooltip-dot" />
                                {s.key || spec.y}
                              </span>
                              <span className="chart-tooltip-val">
                                <b>{p?.formatted ?? "—"}</b>
                              </span>
                            </div>
                            <div className="chart-tooltip-row">
                              <span className="chart-tooltip-label">Daily Avg Diff</span>
                              <span className={`chart-tooltip-delta ${deltaAvg >= 0 ? "good" : "bad"}`}>
                                {(deltaAvg >= 0 ? "+" : "") + formatTick(deltaAvg, spec.yUnit)}
                              </span>
                            </div>
                            {isPeak && (
                              <div style={{ marginTop: 4, fontSize: 11, color: s.color, fontWeight: 600 }}>
                                ★ Peak activity day of this period
                              </div>
                            )}
                          </div>
                        </div>
                      ),
                    });
                  }}
                  onMouseMove={(e) => {
                    if (hoveredIdx === i) {
                      setHover((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : null));
                    }
                  }}
                />
              </g>
            );
          })}

          {/* Date Axis Labels below baseline */}
          {thinLabels(periods).map((i) => (
            <text
              key={periods[i]}
              x={x(i)}
              y={baselineY + 22}
              textAnchor="middle"
              fontSize={11}
              fill={hoveredIdx === i ? "var(--text-primary)" : "var(--text-muted)"}
              fontWeight={hoveredIdx === i ? 600 : 400}
            >
              {periodLabel(periods[i]!, periods)}
            </text>
          ))}
        </svg>
        <Tooltip hover={hover} />
      </div>
    );
  }

  // Multi-series: Swimlanes with crosshair guides and interactive legend
  const laneH = 38;
  const labelW = 150;
  const height = series.length * laneH + 46;
  const max = Math.max(...points.map((p) => p.value ?? 0), 1);
  const r = (v: number) => 4 + Math.sqrt(Math.max(v, 0) / max) * 11;
  const gutter = labelW + 12 + r(max);
  const plotW = width - gutter - PAD.right - r(max);
  const x = (period: string) =>
    gutter + (periods.length === 1 ? plotW / 2 : (periods.indexOf(period) / (periods.length - 1)) * plotW);

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
      >
        {series.map((s, li) => {
          const cy = 14 + li * laneH + laneH / 2;
          const isDimmed = Boolean(activeSeries && s.key && s.key !== activeSeries);
          return (
            <g
              key={s.key || "one"}
              style={{ opacity: isDimmed ? 0.25 : 1, transition: "opacity 0.2s ease" }}
            >
              <line
                x1={gutter}
                x2={width - PAD.right}
                y1={cy}
                y2={cy}
                stroke="var(--grid)"
                strokeWidth={1}
              />
              <text x={labelW} y={cy + 4} textAnchor="end" fontSize={12} fill="var(--text-secondary)">
                {s.key.length > 22 ? `${s.key.slice(0, 21)}…` : s.key}
              </text>
              {s.points
                .filter((p) => (p.value ?? 0) > 0)
                .map((p) => (
                  <circle
                    key={`${s.key}-${p.period}`}
                    cx={x(p.period ?? "")}
                    cy={cy}
                    r={r(p.value ?? 0)}
                    fill={s.color}
                    fillOpacity={0.85}
                    stroke="var(--surface-1)"
                    strokeWidth={2}
                    {...bind(
                      <div className="chart-tooltip-panel">
                        <div className="chart-tooltip-header">
                          <strong>{periodLabel(p.period ?? "", periods)}</strong>
                          <span className="chart-tooltip-period-sub">{p.period}</span>
                        </div>
                        <div className="chart-tooltip-row">
                          <span className="chart-tooltip-label">
                            <i style={{ background: s.color }} className="chart-tooltip-dot" />
                            {s.key || spec.y}
                          </span>
                          <span className="chart-tooltip-val">{p.formatted}</span>
                        </div>
                      </div>,
                    )}
                  />
                ))}
            </g>
          );
        })}
        {thinLabels(periods).map((i) => (
          <text
            key={periods[i]}
            x={x(periods[i]!)}
            y={height - 10}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {periodLabel(periods[i]!, periods)}
          </text>
        ))}
      </svg>
      <Legend
        items={series}
        activeKey={activeSeries}
        onHover={onActiveSeriesChange}
        onClick={(k) => onActiveSeriesChange?.(activeSeries === k ? null : k)}
      />
      <Tooltip hover={hover} />
    </>
  );
}

/* --------------------------------------------------------- categorical forms */

/**
 * Named categories run horizontally.
 *
 * A vertical column chart has to thin or rotate its x labels once there are
 * more than a handful of categories, and a category you cannot read is a bar
 * that means nothing. Rotating to horizontal puts every label in a left-hand
 * column at full size, and the value sits at the tip of its own bar.
 */
function CategoryBars({
  spec,
  points,
  activeKey,
  onActiveKeyChange,
}: {
  spec: ChartSpec;
  points: AnswerPoint[];
  activeKey?: string | null;
  onActiveKeyChange?: (k: string | null) => void;
}) {
  const { hover, bind } = useHover();
  const rows = toSlices(spec, points, false);
  const max = Math.max(...rows.map((p) => p.value), 1);
  const total = rows.reduce((a, p) => a + p.value, 0) || 1;

  return (
    <>
      <div style={{ marginTop: 10 }}>
        {rows.map((p, i) => {
          const isDimmed = Boolean(activeKey && activeKey !== p.key);
          const isCurrent = activeKey === p.key;
          const rank = i + 1;
          const rankClass = rank === 1 ? "top-1" : rank === 2 ? "top-2" : rank === 3 ? "top-3" : "";
          const pct = ((p.value / total) * 100).toFixed(1);

          const b = bind(
            <div className="chart-tooltip-panel">
              <div className="chart-tooltip-header">
                <strong>#{rank} · {p.key}</strong>
                <span>{pct}% share</span>
              </div>
              <div className="chart-tooltip-row">
                <span className="chart-tooltip-label">Value</span>
                <span className="chart-tooltip-val">{p.formatted}</span>
              </div>
            </div>,
          );

          return (
            <div
              key={p.key}
              className="bar-row"
              style={{
                opacity: isDimmed ? 0.3 : 1,
                cursor: "pointer",
              }}
              onMouseEnter={() => onActiveKeyChange?.(p.key)}
              onMouseMove={b.onMouseMove}
              onMouseLeave={() => {
                b.onMouseLeave();
                onActiveKeyChange?.(null);
              }}
            >
              <div className={`bar-rank ${rankClass}`}>#{rank}</div>
              <div className="bar-label" title={p.key}>
                {p.key}
              </div>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width: `${Math.max((p.value / max) * 100, 1.5)}%`,
                    background: p.color || "var(--series-1)",
                    boxShadow: isCurrent ? "0 0 0 1px var(--axis)" : "none",
                  }}
                />
              </div>
              <div className="bar-value">
                {p.formatted}
                <span className="bar-share">({pct}%)</span>
              </div>
            </div>
          );
        })}
      </div>
      <Tooltip hover={hover} />
    </>
  );
}

/** Vertical columns over named categories. Offered only while the labels fit. */
function CategoryColumns({ spec, points, width }: { spec: ChartSpec; points: AnswerPoint[]; width: number }) {
  const { hover, bind } = useHover();
  const rows = toSlices(spec, points, false);
  const yMax = Math.max(...rows.map((p) => p.value), 0);
  const total = rows.reduce((a, p) => a + p.value, 0) || 1;
  const plotH = H - PAD.top - PAD.bottom;
  const ticks = niceTicks(yMax);
  const top = ticks[ticks.length - 1] || 1;
  const band = (width - PAD.left - PAD.right) / Math.max(rows.length, 1);
  const barW = Math.min(34, band * 0.6);
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const cx = (i: number) => PAD.left + band * i + band / 2;
  const short = (s: string) => (s.length > 13 ? `${s.slice(0, 12)}…` : s);

  return (
    <>
      <Frame
        width={width}
        yMax={yMax}
        unit={spec.yUnit}
        xLabels={rows.map((p, i) => ({ at: cx(i), text: short(p.key) }))}
      >
        {rows.map((p, i) => {
          const pct = ((p.value / total) * 100).toFixed(1);
          return (
            <rect
              key={p.key}
              x={cx(i) - barW / 2}
              y={y(p.value)}
              width={barW}
              height={Math.max(0, y(0) - y(p.value))}
              rx={3}
              fill="var(--series-1)"
              style={{ transition: "y 0.2s ease, height 0.2s ease" }}
              {...bind(
                <div className="chart-tooltip-panel">
                  <div className="chart-tooltip-header">
                    <strong>{p.key}</strong>
                    <span>{pct}% share</span>
                  </div>
                  <div className="chart-tooltip-row">
                    <span className="chart-tooltip-label">Value</span>
                    <span className="chart-tooltip-val">{p.formatted}</span>
                  </div>
                </div>,
              )}
            />
          );
        })}
      </Frame>
      <Tooltip hover={hover} />
    </>
  );
}

/**
 * Pie and donut - the same chart with a different hole.
 *
 * Part-to-whole only, and only while the slice count stays small; past eight
 * the arcs are no longer comparable to each other and the form has stopped
 * working. Labels sit outside the ring in text tokens with a leader line,
 * because a number printed on its own wedge is unreadable on at least two of
 * the eight palette slots.
 */
function PieChart({
  spec,
  points,
  hole,
  activeKey,
  onActiveKeyChange,
}: {
  spec: ChartSpec;
  points: AnswerPoint[];
  hole: number;
  activeKey?: string | null;
  onActiveKeyChange?: (k: string | null) => void;
}) {
  const { hover, bind } = useHover();
  const [hoveredSlice, setHoveredSlice] = useState<Slice | null>(null);
  const slices = toSlices(spec, points);
  const width = 560;
  const height = 300;
  const cx = 190;
  const cy = height / 2;
  const R = 108;

  let angle = -Math.PI / 2;
  const arcs = slices.map((s) => {
    const from = angle;
    const to = angle + s.share * Math.PI * 2;
    angle = to;
    const at = (a: number, radius: number) => `${cx + Math.cos(a) * radius} ${cy + Math.sin(a) * radius}`;
    const large = to - from > Math.PI ? 1 : 0;
    const d =
      hole > 0
        ? `M ${at(from, R)} A ${R} ${R} 0 ${large} 1 ${at(to, R)} L ${at(to, hole)} A ${hole} ${hole} 0 ${large} 0 ${at(
            from,
            hole,
          )} Z`
        : `M ${cx} ${cy} L ${at(from, R)} A ${R} ${R} 0 ${large} 1 ${at(to, R)} Z`;
    return { ...s, d, mid: (from + to) / 2 };
  });

  const total = slices.reduce((a, s) => a + s.value, 0);
  const active = hoveredSlice || (activeKey ? slices.find((s) => s.key === activeKey) ?? null : null);

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block", maxWidth: 620 }}
        role="img"
      >
        {arcs.map((a) => {
          const isCurrent = active?.key === a.key;
          const isDimmed = Boolean(active && !isCurrent);
          const b = bind(
            <div className="chart-tooltip-panel">
              <div className="chart-tooltip-header">
                <strong>{a.key}</strong>
                <span>{(a.share * 100).toFixed(1)}%</span>
              </div>
              <div className="chart-tooltip-row">
                <span className="chart-tooltip-label">Value</span>
                <span className="chart-tooltip-val">{a.formatted}</span>
              </div>
            </div>,
          );

          return (
            <path
              key={a.key}
              d={a.d}
              fill={a.color}
              stroke={isCurrent ? "var(--text-primary)" : "var(--surface-1)"}
              strokeWidth={isCurrent ? 2.5 : 2}
              opacity={isDimmed ? 0.35 : 1}
              style={{ transition: "opacity 0.15s ease", cursor: "pointer" }}
              onMouseEnter={() => {
                setHoveredSlice(a);
                onActiveKeyChange?.(a.key);
              }}
              onMouseMove={b.onMouseMove}
              onMouseLeave={() => {
                b.onMouseLeave();
                setHoveredSlice(null);
                onActiveKeyChange?.(null);
              }}
            />
          );
        })}
        {hole > 0 && (
          <g style={{ pointerEvents: "none" }}>
            {active ? (
              <>
                <text
                  x={cx}
                  y={cy - 12}
                  textAnchor="middle"
                  fontSize={11.5}
                  fill="var(--text-secondary)"
                >
                  {active.key.length > 15 ? `${active.key.slice(0, 14)}…` : active.key}
                </text>
                <text
                  x={cx}
                  y={cy + 7}
                  textAnchor="middle"
                  fontSize={18}
                  fontWeight={620}
                  fill="var(--text-primary)"
                >
                  {active.formatted}
                </text>
                <text
                  x={cx}
                  y={cy + 24}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill="var(--series-1)"
                >
                  {(active.share * 100).toFixed(1)}%
                </text>
              </>
            ) : (
              <>
                <text
                  x={cx}
                  y={cy - 2}
                  textAnchor="middle"
                  fontSize={22}
                  fontWeight={620}
                  fill="var(--text-primary)"
                >
                  {formatTick(total, spec.yUnit)}
                </text>
                <text x={cx} y={cy + 18} textAnchor="middle" fontSize={12} fill="var(--text-muted)">
                  total
                </text>
              </>
            )}
          </g>
        )}
        {/* Direct labels for anything big enough to point at */}
        {arcs
          .filter((a) => a.share >= 0.05)
          .map((a) => {
            const isCurrent = active?.key === a.key;
            const right = Math.cos(a.mid) >= 0;
            const x2 = cx + Math.cos(a.mid) * (R + 14);
            const y2 = cy + Math.sin(a.mid) * (R + 14);
            const x3 = right ? x2 + 10 : x2 - 10;
            return (
              <g key={`label-${a.key}`} opacity={active && !isCurrent ? 0.35 : 1}>
                <polyline
                  points={`${cx + Math.cos(a.mid) * (R + 2)},${cy + Math.sin(a.mid) * (R + 2)} ${x2},${y2} ${x3},${y2}`}
                  fill="none"
                  stroke={isCurrent ? "var(--text-primary)" : "var(--axis)"}
                  strokeWidth={isCurrent ? 1.5 : 1}
                />
                <text
                  x={right ? x3 + 4 : x3 - 4}
                  y={y2 + 4}
                  textAnchor={right ? "start" : "end"}
                  fontSize={11.5}
                  fontWeight={isCurrent ? 600 : 400}
                  fill={isCurrent ? "var(--text-primary)" : "var(--text-secondary)"}
                >
                  {(a.share * 100).toFixed(0)}%
                </text>
              </g>
            );
          })}
      </svg>
      <Legend
        items={slices}
        activeKey={active?.key}
        onHover={(k) => {
          setHoveredSlice(k ? slices.find((s) => s.key === k) ?? null : null);
          onActiveKeyChange?.(k);
        }}
        onClick={(k) => {
          const next = activeKey === k ? null : k;
          onActiveKeyChange?.(next);
        }}
      />
      <Tooltip hover={hover} />
    </>
  );
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Squarified treemap layout.
 *
 * Rows grow greedily while the worst aspect ratio in the row keeps improving,
 * which is the thing that stops a treemap degenerating into slivers. This is
 * the part-to-whole form that still works past the point where a pie has given
 * up - it reads fine at twenty cells.
 */
function squarify<T extends { value: number }>(items: T[], rect: Rect): (Rect & { item: T })[] {
  const total = items.reduce((a, i) => a + i.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const areas = items.map((i) => (i.value / total) * rect.w * rect.h);
  const out: (Rect & { item: T })[] = [];

  const worstRatio = (row: number[], sum: number, side: number) => {
    const thickness = sum / side;
    return Math.max(...row.map((a) => Math.max(thickness / (a / thickness), a / thickness / thickness)));
  };

  let free = { ...rect };
  let i = 0;
  while (i < items.length && free.w > 0.5 && free.h > 0.5) {
    const vertical = free.w >= free.h;
    const side = vertical ? free.h : free.w;
    let row: number[] = [];
    let sum = 0;
    let best = Infinity;
    let j = i;
    while (j < items.length) {
      const next = [...row, areas[j]!];
      const nextSum = sum + areas[j]!;
      const ratio = worstRatio(next, nextSum, side);
      if (row.length > 0 && ratio > best) break;
      row = next;
      sum = nextSum;
      best = ratio;
      j++;
    }
    const thickness = sum / side;
    let offset = 0;
    for (let k = 0; k < row.length; k++) {
      const len = row[k]! / thickness;
      out.push(
        vertical
          ? { x: free.x, y: free.y + offset, w: thickness, h: len, item: items[i + k]! }
          : { x: free.x + offset, y: free.y, w: len, h: thickness, item: items[i + k]! },
      );
      offset += len;
    }
    free = vertical
      ? { x: free.x + thickness, y: free.y, w: free.w - thickness, h: free.h }
      : { x: free.x, y: free.y + thickness, w: free.w, h: free.h - thickness };
    i += row.length;
  }
  return out;
}

function Treemap({
  spec,
  points,
  width,
  activeKey,
  onActiveKeyChange,
}: {
  spec: ChartSpec;
  points: AnswerPoint[];
  width: number;
  activeKey?: string | null;
  onActiveKeyChange?: (k: string | null) => void;
}) {
  const { hover, bind } = useHover();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const slices = toSlices(spec, points);
  const height = 300;
  const cells = squarify(slices, { x: 0, y: 0, w: width, h: height });
  const active = hoveredKey || activeKey;

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
      >
        {cells.map((c) => {
          const isCurrent = active === c.item.key;
          const isDimmed = Boolean(active && !isCurrent);

          const b = bind(
            <div className="chart-tooltip-panel">
              <div className="chart-tooltip-header">
                <strong>{c.item.key}</strong>
                <span>{(c.item.share * 100).toFixed(1)}%</span>
              </div>
              <div className="chart-tooltip-row">
                <span className="chart-tooltip-label">Value</span>
                <span className="chart-tooltip-val">{c.item.formatted}</span>
              </div>
            </div>,
          );

          return (
            <g
              key={c.item.key}
              opacity={isDimmed ? 0.35 : 1}
              style={{ transition: "opacity 0.15s ease", cursor: "pointer" }}
              onMouseEnter={() => {
                setHoveredKey(c.item.key);
                onActiveKeyChange?.(c.item.key);
              }}
              onMouseMove={b.onMouseMove}
              onMouseLeave={() => {
                b.onMouseLeave();
                setHoveredKey(null);
                onActiveKeyChange?.(null);
              }}
            >
              <rect
                x={c.x + 1}
                y={c.y + 1}
                width={Math.max(0, c.w - 2)}
                height={Math.max(0, c.h - 2)}
                rx={4}
                fill={c.item.color}
                stroke={isCurrent ? "var(--text-primary)" : "none"}
                strokeWidth={isCurrent ? 2 : 0}
              />
              {c.w > 86 && c.h > 52 && (
                <>
                  <rect
                    x={c.x + 9}
                    y={c.y + 10}
                    width={Math.min(c.w - 18, Math.max(72, c.item.key.length * 6.6 + 12))}
                    height={40}
                    rx={5}
                    fill="var(--surface-1)"
                    fillOpacity={0.92}
                  />
                  <text x={c.x + 16} y={c.y + 26} fontSize={12} fill="var(--text-secondary)">
                    {c.item.key.length > 18 ? `${c.item.key.slice(0, 17)}…` : c.item.key}
                  </text>
                  <text x={c.x + 16} y={c.y + 43} fontSize={13.5} fontWeight={620} fill="var(--text-primary)">
                    {c.item.formatted}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>
      <Legend
        items={slices}
        activeKey={active}
        onHover={(k) => {
          setHoveredKey(k);
          onActiveKeyChange?.(k);
        }}
        onClick={(k) => {
          const next = activeKey === k ? null : k;
          onActiveKeyChange?.(next);
        }}
      />
      <Tooltip hover={hover} />
    </>
  );
}

/**
 * Funnel over the canonical pipeline order.
 *
 * An actual geometric SVG funnel chart with tapered trapezoid geometry,
 * sequential ordinal blue tones, interactive stage isolation, and
 * pipeline share distribution.
 */
const ORDINAL = ["var(--seq-250)", "var(--seq-350)", "var(--seq-450)", "var(--seq-550)", "var(--seq-650)"];
const FUNNEL_ORDER = ["New", "Attempting", "Engaged", "Qualified", "Won"];

function Funnel({ points }: { points: AnswerPoint[] }) {
  const { hover, bind } = useHover();
  const [funnelMode, setFunnelMode] = useState<"funnel" | "proportional">("funnel");
  const [activeStage, setActiveStage] = useState<string | null>(null);

  const rows = FUNNEL_ORDER.map((stage) => points.find((p) => p.dims.stage === stage)).filter(
    (p): p is AnswerPoint => Boolean(p),
  );
  if (rows.length === 0) return null;

  const total = rows.reduce((a, p) => a + (p.value ?? 0), 0) || 1;
  const maxVal = Math.max(...rows.map((p) => p.value ?? 0), 1);
  const isMonotonic = rows.every((r, idx) => idx === 0 || (r.value ?? 0) <= (rows[idx - 1]?.value ?? 0));
  const topVal = rows[0]?.value ?? 1;
  const wonVal = rows[rows.length - 1]?.value ?? 0;
  const overallConv = topVal > 0 ? ((wonVal / topVal) * 100).toFixed(1) : "0";

  const width = 880;
  const height = 310;
  const cx = 390;
  const N = rows.length;
  const stageH = 46;
  const gap = 6;
  const startY = 20;

  return (
    <div className="funnel-wrapper">
      <div className="funnel-controls">
        <div className="funnel-modes" role="group" aria-label="Funnel rendering style">
          <button
            type="button"
            className={funnelMode === "funnel" ? "active" : ""}
            onClick={() => setFunnelMode("funnel")}
          >
            Funnel Shape
          </button>
          <button
            type="button"
            className={funnelMode === "proportional" ? "active" : ""}
            onClick={() => setFunnelMode("proportional")}
          >
            Volume Stream
          </button>
        </div>
        <div className="funnel-summary-badge">
          {isMonotonic ? (
            <>
              <span>Conversion ({rows[0]?.dims.stage} → Won):</span>
              <strong>{overallConv}%</strong>
              <span className="muted">
                ({wonVal.toLocaleString("en-IN")} of {topVal.toLocaleString("en-IN")})
              </span>
            </>
          ) : (
            <>
              <span>Total Pipeline Volume:</span>
              <strong>{total.toLocaleString("en-IN")} leads</strong>
              <span className="muted">({rows.length} stages)</span>
            </>
          )}
        </div>
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
      >
        <defs>
          <filter id="funnel-glow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="2" stdDeviation="3" floodOpacity="0.18" />
          </filter>
        </defs>
        {rows.map((p, i) => {
          const val = p.value ?? 0;
          const pct = ((val / total) * 100).toFixed(1);
          const y0 = startY + i * (stageH + gap);
          const y1 = y0 + stageH;
          const midY = (y0 + y1) / 2;

          let wTop: number;
          let wBot: number;

          if (funnelMode === "funnel") {
            // Iconic tapered funnel contour: wide mouth tapering to focused spout
            const maxW = 460;
            const minW = 160;
            wTop = maxW - (i / N) * (maxW - minW);
            wBot = maxW - ((i + 1) / N) * (maxW - minW);
          } else {
            // Proportional mode: widths scale directly with stage volume
            const nextVal = i < N - 1 ? (rows[i + 1]?.value ?? 0) : val * 0.9;
            wTop = Math.max(120, (val / maxVal) * 440);
            wBot = Math.max(120, (nextVal / maxVal) * 440);
          }

          const isCurrent = activeStage === p.dims.stage;
          const isDimmed = Boolean(activeStage && !isCurrent);
          const b = bind(
            <div className="chart-tooltip-panel">
              <div className="chart-tooltip-header">
                <strong>Stage {i + 1} · {p.dims.stage}</strong>
                <span>{pct}% of pipeline</span>
              </div>
              <div className="chart-tooltip-row">
                <span className="chart-tooltip-label">Leads in stage</span>
                <span className="chart-tooltip-val">{p.formatted}</span>
              </div>
              <div className="chart-tooltip-row">
                <span className="chart-tooltip-label">Pipeline share</span>
                <span className="chart-tooltip-val">{pct}%</span>
              </div>
            </div>,
          );

          const leftX = cx - Math.max(wTop, wBot) / 2 - 16;
          const rightX = cx + Math.max(wTop, wBot) / 2 + 16;

          return (
            <g
              key={p.dims.stage}
              opacity={isDimmed ? 0.35 : 1}
              style={{ transition: "all 0.2s ease", cursor: "pointer" }}
              onMouseEnter={() => setActiveStage(p.dims.stage ?? null)}
              onMouseMove={b.onMouseMove}
              onMouseLeave={() => {
                b.onMouseLeave();
                setActiveStage(null);
              }}
            >
              {/* Funnel trapezoid polygon */}
              <polygon
                points={`
                  ${cx - wTop / 2},${y0}
                  ${cx + wTop / 2},${y0}
                  ${cx + wBot / 2},${y1}
                  ${cx - wBot / 2},${y1}
                `}
                fill={ORDINAL[Math.min(i, ORDINAL.length - 1)]}
                stroke={isCurrent ? "var(--text-primary)" : "var(--surface-1)"}
                strokeWidth={isCurrent ? 2.5 : 2}
                filter={isCurrent ? "url(#funnel-glow)" : "none"}
              />

              {/* Inside trapezoid: centered stage text */}
              <text
                x={cx}
                y={midY - 3}
                textAnchor="middle"
                fontSize={13}
                fontWeight={620}
                fill="#ffffff"
                style={{ pointerEvents: "none" }}
              >
                {p.dims.stage}
              </text>
              <text
                x={cx}
                y={midY + 13}
                textAnchor="middle"
                fontSize={11.5}
                fill="rgba(255,255,255,0.9)"
                style={{ pointerEvents: "none" }}
              >
                {p.formatted} · {pct}%
              </text>

              {/* Left side: Stage step number & name */}
              <text
                x={leftX}
                y={midY + 4}
                textAnchor="end"
                fontSize={12.5}
                fontWeight={isCurrent ? 600 : 500}
                fill={isCurrent ? "var(--text-primary)" : "var(--text-secondary)"}
              >
                {i + 1}. {p.dims.stage}
              </text>

              {/* Right side: Lead count and share of total pipeline */}
              <text
                x={rightX}
                y={midY - 2}
                textAnchor="start"
                fontSize={13}
                fontWeight={620}
                fill="var(--text-primary)"
              >
                {p.formatted}
              </text>
              <text
                x={rightX}
                y={midY + 14}
                textAnchor="start"
                fontSize={11.5}
                fill="var(--text-muted)"
              >
                {pct}% of pipeline
              </text>
            </g>
          );
        })}
      </svg>
      <Tooltip hover={hover} />
    </div>
  );
}

/**
 * This window against the one before it.
 *
 * The diagonal is "no change", so the chart answers which side of it a thing
 * sits on and by how far.
 */
function Scatter({ spec, points, width }: { spec: ChartSpec; points: AnswerPoint[]; width: number }) {
  const { hover, bind } = useHover();
  const usable = points.filter((p) => p.value !== null && p.comparison !== null);
  const max = Math.max(...usable.flatMap((p) => [p.value ?? 0, p.comparison ?? 0]), 0);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotH = H - PAD.top - PAD.bottom;
  const plotW = width - PAD.left - PAD.right;
  const x = (v: number) => PAD.left + (v / top) * plotW;
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
  const nameOf = (p: AnswerPoint) => sliceKey(spec, p);

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${H + 26}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        role="img"
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={PAD.left - 10} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--text-muted)">
              {formatTick(t, spec.yUnit)}
            </text>
            <text x={x(t)} y={H - 12} textAnchor="middle" fontSize={11} fill="var(--text-muted)">
              {formatTick(t, spec.yUnit)}
            </text>
          </g>
        ))}
        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(top)}
          y2={y(top)}
          stroke="var(--axis)"
          strokeWidth={1.5}
          strokeDasharray="4 4"
        />
        <text x={x(top) - 8} y={y(top) + 15} textAnchor="end" fontSize={11} fill="var(--text-muted)">
          no change line
        </text>
        {usable.map((p) => {
          const val = p.value ?? 0;
          const comp = p.comparison ?? 0;
          const isBetter = spec.invertGood ? val <= comp : val >= comp;
          const delta = val - comp;
          const deltaPct = comp !== 0 ? ((delta / comp) * 100).toFixed(1) : null;
          const sign = delta > 0 ? "+" : "";

          return (
            <circle
              key={nameOf(p)}
              cx={x(comp)}
              cy={y(val)}
              r={6.5}
              fill={isBetter ? "var(--series-1)" : "var(--series-2)"}
              stroke="var(--surface-1)"
              strokeWidth={2}
              style={{ transition: "all 0.15s ease", cursor: "pointer" }}
              {...bind(
                <div className="chart-tooltip-panel">
                  <div className="chart-tooltip-header">
                    <strong>{nameOf(p)}</strong>
                    <span className={`chart-tooltip-delta ${isBetter ? "good" : "bad"}`}>
                      {sign}
                      {formatTick(delta, spec.yUnit)} {deltaPct ? `(${sign}${deltaPct}%)` : ""}
                    </span>
                  </div>
                  <div className="chart-tooltip-row">
                    <span className="chart-tooltip-label">Current window</span>
                    <span className="chart-tooltip-val">{p.formatted}</span>
                  </div>
                  <div className="chart-tooltip-row">
                    <span className="chart-tooltip-label">Prior window</span>
                    <span className="chart-tooltip-val">{formatTick(comp, spec.yUnit)}</span>
                  </div>
                </div>,
              )}
            />
          );
        })}
        <text x={width / 2} y={H + 16} textAnchor="middle" fontSize={11.5} fill="var(--text-muted)">
          horizontal: prior window · vertical: current window · above diagonal improved
        </text>
      </svg>
      <Tooltip hover={hover} />
    </>
  );
}

/** Two axes and one number. Sequential single hue, light to dark. */
function Heatmap({ spec, points }: { spec: ChartSpec; points: AnswerPoint[] }) {
  const { hover, bind } = useHover();
  const timed = hasTime(points);
  const rowOf = (p: AnswerPoint) =>
    timed ? spec.series.map((d) => p.dims[d] ?? "—").join(" / ") : (p.dims[spec.x] ?? "—");
  const colOf = (p: AnswerPoint) => (timed ? (p.period ?? "—") : (p.dims[spec.series[0] ?? ""] ?? "—"));

  const rows = [...new Set(points.map(rowOf))];
  const cols = [...new Set(points.map(colOf))].sort();
  const max = Math.max(...points.map((p) => p.value ?? 0), 1);
  const steps = [
    "var(--seq-100)",
    "var(--seq-250)",
    "var(--seq-350)",
    "var(--seq-450)",
    "var(--seq-550)",
    "var(--seq-650)",
  ];

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c} className="num">
                  {timed ? periodLabel(c, cols) : c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r}>
                <td style={{ color: "var(--text-secondary)" }}>{r}</td>
                {cols.map((c) => {
                  const p = points.find((q) => rowOf(q) === r && colOf(q) === c);
                  const v = p?.value ?? null;
                  const step =
                    v === null ? null : steps[Math.min(steps.length - 1, Math.floor((v / max) * steps.length))];
                  return (
                    <td key={c} className="num" style={{ padding: 3 }}>
                      <div
                        style={{
                          background: step ?? "transparent",
                          borderRadius: 4,
                          padding: "6px 8px",
                          color: step && v! / max > 0.55 ? "#fff" : "var(--text-primary)",
                          fontVariantNumeric: "tabular-nums",
                        }}
                        {...(p
                          ? bind(
                              <div className="chart-tooltip-panel">
                                <div className="chart-tooltip-header">
                                  <strong>{r}</strong>
                                  <span>{c}</span>
                                </div>
                                <div className="chart-tooltip-row">
                                  <span className="chart-tooltip-label">Value</span>
                                  <span className="chart-tooltip-val">{p.formatted}</span>
                                </div>
                              </div>,
                            )
                          : {})}
                      >
                        {p?.formatted ?? "—"}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Tooltip hover={hover} />
    </>
  );
}

/* ------------------------------------------------------------------ assembly */

/**
 * The form switcher.
 *
 * Every option here came out of `compatibleCharts`, so there is no way to pick
 * a form that misrepresents the data: the picker cannot offer a stacked rate or
 * a nine-slice pie because those never reach it. What the reader gets is a free
 * choice among the honest options, which is the difference between a chart they
 * were handed and one they interrogated.
 */
function ChartPicker({
  options,
  value,
  onChange,
  excluded,
}: {
  options: ChartType[];
  value: ChartType;
  onChange: (t: ChartType) => void;
  excluded: { type: ChartType; reason: string }[];
}) {
  if (options.length < 2) return null;
  return (
    <>
      <div className="chart-picker" role="group" aria-label="Chart type">
        {options.map((t) => (
          <button key={t} type="button" aria-pressed={t === value} onClick={() => onChange(t)}>
            {CHART_LABELS[t]}
          </button>
        ))}
      </div>
      {excluded.length > 0 && (
        <details className="chart-why">
          <summary>Why not the other {excluded.length} forms?</summary>
          <ul>
            {excluded.map((e) => (
              <li key={e.type}>
                <b>{CHART_LABELS[e.type]}</b> — {e.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/** Forms that collapse the time axis, and therefore owe the reader a sentence. */
const TOTALLING: ChartType[] = ["pie", "donut", "treemap", "bar"];

export function Chart({ spec, points }: { spec: ChartSpec; points: AnswerPoint[] }) {
  const id = useId();
  const [chosen, setChosen] = useState<ChartType | null>(null);
  const [activeSeries, setActiveSeries] = useState<string | null>(null);
  const width = WIDTH;

  if (points.length === 0) return <p className="empty">No rows matched this query.</p>;

  const options = compatibleCharts(spec, points);
  const type = chosen && options.includes(chosen) ? chosen : spec.type;
  const shape = chartShape(spec, points);
  const totalled = shape.periods > 1 && TOTALLING.includes(type);

  // A single number is not a chart. The answer's own table carries it.
  if (points.length === 1 && type !== "funnel") {
    const p = points[0]!;
    return (
      <div className="tile" style={{ maxWidth: 260 }}>
        <div className="label">{spec.title}</div>
        <div className="value">{p.formatted}</div>
      </div>
    );
  }

  return (
    <figure style={{ margin: "12px 0 0" }} aria-label={spec.title} key={id}>
      <ChartPicker
        options={options}
        value={type}
        onChange={setChosen}
        excluded={excludedCharts(spec, points)}
      />
      {type === "line" && (
        <LineChart
          spec={spec}
          points={points}
          width={width}
          activeSeries={activeSeries}
          onActiveSeriesChange={setActiveSeries}
        />
      )}
      {type === "area" && (
        <LineChart
          spec={spec}
          points={points}
          width={width}
          filled
          activeSeries={activeSeries}
          onActiveSeriesChange={setActiveSeries}
        />
      )}
      {type === "stacked_area" && (
        <LineChart
          spec={spec}
          points={points}
          width={width}
          stacked
          activeSeries={activeSeries}
          onActiveSeriesChange={setActiveSeries}
        />
      )}
      {type === "column" &&
        (hasTime(points) ? (
          <Columns
            spec={spec}
            points={points}
            width={width}
            mode="single"
            activeSeries={activeSeries}
            onActiveSeriesChange={setActiveSeries}
          />
        ) : (
          <CategoryColumns spec={spec} points={points} width={width} />
        ))}
      {type === "bar" && (
        <CategoryBars
          spec={spec}
          points={points}
          activeKey={activeSeries}
          onActiveKeyChange={setActiveSeries}
        />
      )}
      {type === "grouped_bar" && (
        <Columns
          spec={spec}
          points={points}
          width={width}
          mode="grouped"
          activeSeries={activeSeries}
          onActiveSeriesChange={setActiveSeries}
        />
      )}
      {type === "stacked_bar" && (
        <Columns
          spec={spec}
          points={points}
          width={width}
          mode="stacked"
          activeSeries={activeSeries}
          onActiveSeriesChange={setActiveSeries}
        />
      )}
      {type === "pie" && (
        <PieChart
          spec={spec}
          points={points}
          hole={0}
          activeKey={activeSeries}
          onActiveKeyChange={setActiveSeries}
        />
      )}
      {type === "donut" && (
        <PieChart
          spec={spec}
          points={points}
          hole={62}
          activeKey={activeSeries}
          onActiveKeyChange={setActiveSeries}
        />
      )}
      {type === "treemap" && (
        <Treemap
          spec={spec}
          points={points}
          width={width}
          activeKey={activeSeries}
          onActiveKeyChange={setActiveSeries}
        />
      )}
      {type === "funnel" && <Funnel points={points} />}
      {type === "timeline" && (
        <Timeline
          spec={spec}
          points={points}
          width={width}
          activeSeries={activeSeries}
          onActiveSeriesChange={setActiveSeries}
        />
      )}
      {type === "heatmap" && <Heatmap spec={spec} points={points} />}
      {type === "scatter" && <Scatter spec={spec} points={points} width={width} />}
      {type === "table" && <p className="empty">Shown as a table below.</p>}
      <figcaption className="muted" style={{ marginTop: 8 }}>
        {spec.title}
        {totalled && (
          <>
            {" · "}
            <strong>totalled across all {shape.periods} periods</strong>, not one of them
          </>
        )}
      </figcaption>
    </figure>
  );
}
