/**
 * `LeadDeskAgent` - the only thing in this project that writes.
 *
 * Everything before this reads. That asymmetry is the whole design: the Analyst
 * and the Watchtower are handed a data source whose write methods throw, and
 * this agent is the single place where a mutation can originate. If you are
 * auditing whether a language model can change your data, this file and
 * `src/desk/` are the entire surface.
 *
 * The flow is deliberately two-step and cannot be collapsed:
 *
 *   propose  ->  a typed ActionIntent, compiled to an exact filter and update,
 *                run as a dry run, returned with the real affected count and a
 *                sample. Nothing is written.
 *   approve  ->  a human sends back the proposal id. The count is re-checked,
 *                prior values are captured, the update runs, and an audit
 *                record is appended.
 *
 * A proposal is single-use and expires. There is no "auto-approve", no
 * confidence threshold that skips the human, and no endpoint that takes a
 * natural-language request and writes. That is not an oversight to be fixed
 * later; it is the feature.
 */
import { Agent } from "agents";
import { createDriverDataSource } from "../db/driver";
import type { DataSource } from "../db/types";
import { fmtDay, type DateRange } from "../semantic/dates";
import { createProvider, type LLMProvider } from "../llm";
import { ActionError, type ActionIntent } from "../desk/actions";
import {
  apply,
  findAudit,
  preview,
  PROPOSAL_TTL_MS,
  recentAudit,
  undo,
  type ActionPreview,
  type AuditRecord,
} from "../desk/apply";
import type { Env } from "./analyst";

interface StoredProposal {
  preview: ActionPreview;
  createdAt: string;
  /** Single-use: set the moment it is approved or rejected. */
  consumedAt: string | null;
  outcome: "applied" | "rejected" | null;
  auditId: string | null;
}

export interface LeadDeskState {
  /** Open and recently closed proposals, newest first. */
  proposals: StoredProposal[];
  /** Short log of what has actually been written. */
  applied: { at: string; auditId: string; summary: string; modified: number }[];
}

const INITIAL: LeadDeskState = { proposals: [], applied: [] };
const KEEP_PROPOSALS = 20;

export class LeadDeskAgent extends Agent<Env, LeadDeskState> {
  initialState = INITIAL;

  private ds: DataSource | null = null;
  private llm: LLMProvider | null = null;
  private window: DateRange | null = null;
  private repCache: { id: string; name: string; team: string }[] | null = null;

  /** The one writable data source in the system. */
  private data(): DataSource {
    return (this.ds ??= createDriverDataSource(this.env.MONGODB_URI, this.env.MONGODB_DB_NAME));
  }

  private provider(): LLMProvider {
    return (this.llm ??= createProvider(this.env));
  }

  private async reps(): Promise<{ id: string; name: string; team: string }[]> {
    if (this.repCache) return this.repCache;
    const docs = await this.data().aggregate("reps", [
      { $project: { name: 1, team: 1 } },
      { $sort: { _id: 1 } },
    ]);
    return (this.repCache = docs.map((d) => ({
      id: String(d._id),
      name: String(d.name),
      team: String(d.team),
    })));
  }

  private async dataWindow(): Promise<DateRange> {
    if (this.window) return this.window;
    const [first, last] = await Promise.all([
      this.data().aggregate("leads", [{ $sort: { created_at: 1 } }, { $limit: 1 }, { $project: { created_at: 1 } }]),
      this.data().aggregate("leads", [{ $sort: { created_at: -1 } }, { $limit: 1 }, { $project: { created_at: 1 } }]),
    ]);
    const from = first[0]?.created_at;
    const to = last[0]?.created_at;
    if (!(from instanceof Date) || !(to instanceof Date)) {
      throw new Error("leads.created_at is not a BSON date - re-run scripts/import_data.mjs");
    }
    return (this.window = { from: fmtDay(from), to: fmtDay(to) });
  }

  /**
   * Turn a request into a previewed proposal. Reads only.
   */
  async propose(request: string): Promise<
    | { ok: true; preview: ActionPreview }
    | { ok: false; kind: "refusal" | "error"; reason: string; suggestion?: string }
  > {
    const trimmed = request.trim();
    if (!trimmed) return { ok: false, kind: "error", reason: "Describe the change you want." };

    try {
      const plan = await this.provider().propose(trimmed, {
        today: new Date(),
        dataWindow: await this.dataWindow(),
        reps: await this.reps(),
      });

      if (plan.kind === "refusal") {
        return { ok: false, kind: "refusal", reason: plan.reason, suggestion: plan.suggestion };
      }

      const result = await preview(this.data(), plan.intent);
      this.remember(result);
      return { ok: true, preview: result };
    } catch (e) {
      return { ok: false, kind: "error", reason: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Preview an intent built by hand, bypassing the model but not the human. */
  async previewIntent(intent: ActionIntent): Promise<ActionPreview> {
    const result = await preview(this.data(), intent);
    this.remember(result);
    return result;
  }

  /**
   * Apply a proposal a person has approved.
   *
   * Every guard that matters lives here or in `desk/apply.ts`: the proposal
   * must exist, be unconsumed, be unexpired, be unblocked, and still match the
   * same number of leads it did when it was previewed.
   */
  async approve(
    proposalId: string,
  ): Promise<{ ok: true; audit: AuditRecord } | { ok: false; reason: string }> {
    const stored = this.state.proposals.find((p) => p.preview.proposalId === proposalId);
    if (!stored) return { ok: false, reason: `No proposal ${proposalId}.` };
    if (stored.consumedAt) {
      return { ok: false, reason: `Proposal ${proposalId} was already ${stored.outcome}.` };
    }
    if (Date.now() - Date.parse(stored.createdAt) > PROPOSAL_TTL_MS) {
      this.consume(proposalId, "rejected", null);
      return { ok: false, reason: `Proposal ${proposalId} expired. Re-run it to see a fresh preview.` };
    }
    if (stored.preview.blocked) return { ok: false, reason: stored.preview.blocked };

    try {
      const audit = await apply(
        this.data(),
        stored.preview.intent,
        proposalId,
        stored.preview.matched,
      );
      this.consume(proposalId, "applied", audit._id);
      this.setState({
        ...this.state,
        applied: [
          { at: audit.at, auditId: audit._id, summary: audit.summary, modified: audit.modified },
          ...this.state.applied,
        ].slice(0, 50),
      });
      return { ok: true, audit };
    } catch (e) {
      // A refused apply does not consume the proposal - the operator may want
      // to re-preview and try again.
      return { ok: false, reason: e instanceof ActionError ? e.message : String(e) };
    }
  }

  async reject(proposalId: string): Promise<{ ok: boolean; reason?: string }> {
    const stored = this.state.proposals.find((p) => p.preview.proposalId === proposalId);
    if (!stored) return { ok: false, reason: `No proposal ${proposalId}.` };
    this.consume(proposalId, "rejected", null);
    return { ok: true };
  }

  /** Reverse an applied change from its audit record. */
  async revert(auditId: string): Promise<{ ok: true; audit: AuditRecord } | { ok: false; reason: string }> {
    const record = await findAudit(this.data(), auditId);
    if (!record) return { ok: false, reason: `No audit record ${auditId}.` };
    try {
      return { ok: true, audit: await undo(this.data(), record) };
    } catch (e) {
      return { ok: false, reason: e instanceof ActionError ? e.message : String(e) };
    }
  }

  private remember(result: ActionPreview): void {
    this.setState({
      ...this.state,
      proposals: [
        { preview: result, createdAt: new Date().toISOString(), consumedAt: null, outcome: null, auditId: null },
        ...this.state.proposals,
      ].slice(0, KEEP_PROPOSALS),
    });
  }

  private consume(proposalId: string, outcome: "applied" | "rejected", auditId: string | null): void {
    this.setState({
      ...this.state,
      proposals: this.state.proposals.map((p) =>
        p.preview.proposalId === proposalId
          ? { ...p, consumedAt: new Date().toISOString(), outcome, auditId }
          : p,
      ),
    });
  }

  async onRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = async <T>() => ((await req.json().catch(() => ({}))) as T);

    if (req.method === "POST" && path.endsWith("/propose")) {
      const { request } = await body<{ request?: string }>();
      const result = await this.propose(request ?? "");
      return Response.json(result, { status: result.ok ? 200 : 400 });
    }

    if (req.method === "POST" && path.endsWith("/approve")) {
      const { proposalId } = await body<{ proposalId?: string }>();
      const result = await this.approve(proposalId ?? "");
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }

    if (req.method === "POST" && path.endsWith("/reject")) {
      const { proposalId } = await body<{ proposalId?: string }>();
      return Response.json(await this.reject(proposalId ?? ""));
    }

    if (req.method === "POST" && path.endsWith("/revert")) {
      const { auditId } = await body<{ auditId?: string }>();
      const result = await this.revert(auditId ?? "");
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }

    if (path.endsWith("/audit")) {
      return Response.json({ ok: true, audit: await recentAudit(this.data()) });
    }

    if (path.endsWith("/reset")) {
      // Clears this agent's memory of proposals. It does not undo anything -
      // applied changes are reversed through /revert, from the audit trail.
      this.setState(INITIAL);
      return Response.json({ ok: true, reset: true });
    }

    return Response.json({
      ok: true,
      agent: "LeadDeskAgent",
      open: this.state.proposals.filter((p) => !p.consumedAt).map((p) => ({
        proposalId: p.preview.proposalId,
        summary: p.preview.summary,
        matched: p.preview.matched,
        blocked: p.preview.blocked,
        expiresAt: p.preview.expiresAt,
      })),
      applied: this.state.applied,
    });
  }
}
