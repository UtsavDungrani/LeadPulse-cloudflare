import type { ReactNode } from "react";
import type { AnswerTable } from "../api";

export function Card({ children, ...rest }: { children: ReactNode } & React.HTMLAttributes<HTMLElement>) {
  return (
    <section className="card" {...rest}>
      {children}
    </section>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <p className="muted" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p className="error" role="alert">
      {children}
    </p>
  );
}

/** Right-align anything that reads as a number, and use tabular figures there. */
const NUMERIC = /^[₹$]?-?[\d,.]+%?$|^n\/a$|^—$/;

export function DataTable({ table, max = 40 }: { table: AnswerTable; max?: number }) {
  const rows = table.rows.slice(0, max);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} className={rows.some((r) => NUMERIC.test(r[c.key] ?? "")) ? "num" : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {table.columns.map((c) => (
                <td key={c.key} className={NUMERIC.test(row[c.key] ?? "") ? "num" : undefined}>
                  {row[c.key] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > max && <p className="muted">Showing {max} of {table.rows.length} rows.</p>}
    </div>
  );
}

export function StatTile({
  label,
  value,
  delta,
  deltaGood,
}: {
  label: string;
  value: string;
  delta?: string;
  /** Null when the move has no polarity worth colouring. */
  deltaGood?: boolean | null;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {delta && (
        <div className={`delta${deltaGood === true ? " good" : deltaGood === false ? " bad" : ""}`}>{delta}</div>
      )}
    </div>
  );
}

/**
 * The audit trail, collapsed.
 *
 * Every answer in this app can show exactly what it asked the database. That is
 * the difference between a number you are told and a number you can check, and
 * it is the reason to trust anything above it.
 */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="audit">
      <summary>{summary}</summary>
      {children}
    </details>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="code">{JSON.stringify(value, null, 2)}</pre>;
}
