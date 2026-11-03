import { useEffect, useState } from "react";
import { api, type ActionPreview, type AuditRecord } from "../api";
import { Card, Disclosure, ErrorNote, Json, Spinner } from "../components/bits";

const EXAMPLES = [
  "Move the Olark Chat leads created in the first week of June 2026 over to REP007",
  "Mark the Facebook leads from August 2026 as do-not-email",
  "Mark every converted lead from June as Won",
];

export function Desk() {
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<ActionPreview | null>(null);
  const [refusal, setRefusal] = useState<{ reason: string; suggestion?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditRecord[]>([]);

  async function loadAudit() {
    try {
      setAudit((await api.auditTrail()).audit);
    } catch {
      /* the trail is context, not the point of the page */
    }
  }

  useEffect(() => {
    void loadAudit();
  }, []);

  async function propose(r: string) {
    if (!r.trim()) return;
    setBusy("Proposing");
    setError(null);
    setRefusal(null);
    setPreview(null);
    setRequest(r);
    try {
      const result = await api.propose(r);
      if (result.ok) setPreview(result.preview);
      else if (result.kind === "refusal") setRefusal({ reason: result.reason, suggestion: result.suggestion });
      else setError(result.reason);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function approve() {
    if (!preview) return;
    setBusy("Applying");
    setError(null);
    try {
      const result = await api.approve(preview.proposalId);
      if (!result.ok) setError(result.reason);
      else setPreview(null);
      await loadAudit();
    } finally {
      setBusy(null);
    }
  }

  async function reject() {
    if (!preview) return;
    await api.reject(preview.proposalId);
    setPreview(null);
  }

  async function revert(auditId: string) {
    setBusy("Reverting");
    setError(null);
    try {
      const result = await api.revert(auditId);
      if (!result.ok) setError(result.reason);
      await loadAudit();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Card>
        <h2>Lead desk</h2>
        <p className="muted">
          The only part of this system that writes. Nothing is applied until you approve the preview
          below — there is no endpoint that takes a request and writes in one step.
        </p>
        <form
          className="ask-row"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void propose(request);
          }}
        >
          <input
            type="text"
            value={request}
            placeholder="Describe a change…"
            aria-label="Requested change"
            onChange={(e) => setRequest(e.target.value)}
          />
          <button className="primary" type="submit" disabled={Boolean(busy) || !request.trim()}>
            Propose
          </button>
        </form>
        <div className="examples">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => void propose(e)} disabled={Boolean(busy)}>
              {e}
            </button>
          ))}
        </div>
      </Card>

      {busy && (
        <Card>
          <Spinner label={`${busy}…`} />
        </Card>
      )}

      {error && (
        <Card>
          <ErrorNote>{error}</ErrorNote>
        </Card>
      )}

      {refusal && !busy && (
        <Card>
          <h2>Declined</h2>
          <p className="narrative">{refusal.reason}</p>
          {refusal.suggestion && (
            <p className="narrative">
              <strong>Try instead:</strong> {refusal.suggestion}
            </p>
          )}
          <p className="muted" style={{ marginTop: 12 }}>
            The desk can change how a lead is worked — its owner, its stage, its consent flags. It can
            never change what happened to it: conversion, dates and provenance are not writable.
          </p>
        </Card>
      )}

      {preview && !busy && (
        <Card>
          <h2>Proposed change</h2>
          <p className="narrative">{preview.summary}</p>
          <p className="muted">Reason recorded in the audit trail: “{preview.intent.reason}”</p>

          <div className="tiles" style={{ marginTop: 16 }}>
            <div className="tile">
              <div className="label">Leads affected</div>
              <div className="value">{preview.matched}</div>
              <div className="delta">limit {preview.intent.limit}</div>
            </div>
            <div className="tile">
              <div className="label">Already correct</div>
              <div className="value">{preview.alreadyCorrect}</div>
              <div className="delta">will not change</div>
            </div>
          </div>

          {preview.compiled.guards.length > 0 && (
            <>
              <h3>Guards the compiler added</h3>
              <ul className="muted" style={{ marginTop: 0 }}>
                {preview.compiled.guards.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </>
          )}

          <h3>Currently held values</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Value</th>
                  <th className="num">Leads</th>
                </tr>
              </thead>
              <tbody>
                {preview.currentValues.map((c) => (
                  <tr key={c.value}>
                    <td>{c.value}</td>
                    <td className="num">{c.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {preview.blocked ? (
            <ErrorNote>{preview.blocked}</ErrorNote>
          ) : (
            <div className="row" style={{ marginTop: 20 }}>
              <button className="primary" onClick={() => void approve()}>
                Approve and apply
              </button>
              <button className="ghost" onClick={() => void reject()}>
                Reject
              </button>
              <span className="muted">expires {new Date(preview.expiresAt).toLocaleTimeString()}</span>
            </div>
          )}

          <Disclosure summary="The exact query and write you are approving">
            <h3>Filter</h3>
            <Json value={preview.compiled.filter} />
            <h3>Update</h3>
            <Json value={preview.compiled.update} />
            <h3>Sample of affected leads</h3>
            <Json value={preview.sample} />
          </Disclosure>
        </Card>
      )}

      <Card>
        <h3>Audit trail</h3>
        {audit.length === 0 ? (
          <p className="empty">Nothing has been written.</p>
        ) : (
          audit.map((a) => (
            <div key={a._id} className="finding">
              <div className="pills">
                <span className="pill">{a.action}</span>
                <span className="pill">{new Date(a.at).toLocaleString()}</span>
              </div>
              <h4>{a.summary}</h4>
              <p>
                {a.modified} of {a.matched} leads changed · {a.reason}
              </p>
              {!a.undoOf && !audit.some((x) => x.undoOf === a._id) && (
                <button
                  className="danger"
                  style={{ marginTop: 8, padding: "5px 12px" }}
                  onClick={() => void revert(a._id)}
                >
                  Revert
                </button>
              )}
            </div>
          ))
        )}
      </Card>
    </>
  );
}
