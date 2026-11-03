/**
 * The browser's view of the Worker.
 *
 * Every type here is imported from the server modules rather than restated, so
 * the UI is typed against the actual contract. If a metric's shape changes, this
 * file does not need updating - the type error appears in the view that used it.
 */
import type { AnalystAnswer, AnalystTurn, AnswerPoint, AnswerTable } from "../agents/analyst";
import type { SessionMeta } from "../agents/sessions";
import type { TrackedFinding } from "../watch/findings";
import type { Digest } from "../report/digest";
import type { DeliveryResult } from "../report/deliver";
import type { ActionPreview, AuditRecord } from "../desk/apply";

export type {
  AnalystAnswer,
  AnalystTurn,
  AnswerPoint,
  AnswerTable,
  SessionMeta,
  TrackedFinding,
  Digest,
  ActionPreview,
  AuditRecord,
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(text.slice(0, 300) || `${response.status} ${response.statusText}`);
  }
  // The agents answer with a body on failure too - a refusal is an answer, not
  // an exception - so the caller inspects `ok` rather than the status code.
  return parsed as T;
}

/** Every conversation route carries its session in the query string. */
function forSession(id: string | undefined, path = "/api/ask"): string {
  return id ? `${path}?session=${encodeURIComponent(id)}` : path;
}

export const api = {
  ask: (question: string, session?: string) => call<AnalystAnswer>(forSession(session), { question }),

  /** The transcript of one conversation, enough to redraw every answer in it. */
  history: (session: string) => call<{ turns: AnalystTurn[] }>(forSession(session)),

  sessions: () => call<{ sessions: SessionMeta[] }>("/api/sessions"),

  renameSession: (id: string, title: string) =>
    call<{ ok: boolean; sessions: SessionMeta[] }>("/api/sessions/rename", { id, title }),

  /** Drops the list entry and resets the transcript behind it. */
  deleteSession: (id: string) =>
    call<{ ok: boolean; sessions: SessionMeta[] }>("/api/sessions/delete", { id }),

  watch: () =>
    call<{
      schedule: string;
      lastScanAt: string | null;
      lastScanMs: number | null;
      open: number;
      findings: TrackedFinding[];
      history: { at: string; incidents: number; marketShifts: number; raised: number; ms: number }[];
    }>("/api/watch"),

  scan: (asOf?: string) =>
    call<{ ok: boolean; findings: TrackedFinding[]; stats: Record<string, unknown>; ms: number }>(
      "/api/watch/scan",
      asOf ? { asOf } : {},
    ),

  acknowledge: (key: string) => call<{ ok: boolean }>("/api/watch/acknowledge", { key }),

  reportStatus: () =>
    call<{ schedule: string; sink: string; lastRunAt: string | null; lastDelivery: DeliveryResult | null }>(
      "/api/report",
    ),

  latestDigest: () => call<{ digest: Digest | null; delivery: DeliveryResult | null }>("/api/report/latest"),

  runReport: (asOf?: string) =>
    call<{ ok: boolean; digest: Digest; delivery: DeliveryResult }>("/api/report/run", asOf ? { asOf } : {}),

  deskStatus: () =>
    call<{
      open: { proposalId: string; summary: string; matched: number; blocked: string | null; expiresAt: string }[];
      applied: { at: string; auditId: string; summary: string; modified: number }[];
    }>("/api/desk"),

  propose: (request: string) =>
    call<
      | { ok: true; preview: ActionPreview }
      | { ok: false; kind: "refusal" | "error"; reason: string; suggestion?: string }
    >("/api/desk/propose", { request }),

  approve: (proposalId: string) =>
    call<{ ok: true; audit: AuditRecord } | { ok: false; reason: string }>("/api/desk/approve", { proposalId }),

  reject: (proposalId: string) => call<{ ok: boolean }>("/api/desk/reject", { proposalId }),

  revert: (auditId: string) =>
    call<{ ok: true; audit: AuditRecord } | { ok: false; reason: string }>("/api/desk/revert", { auditId }),

  auditTrail: () => call<{ audit: AuditRecord[] }>("/api/desk/audit"),
};

export function ago(iso: string | null): string {
  if (!iso) return "never";
  const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (secs < 90) return "just now";
  const mins = secs / 60;
  if (mins < 90) return `${Math.round(mins)} min ago`;
  const hours = mins / 60;
  if (hours < 36) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
