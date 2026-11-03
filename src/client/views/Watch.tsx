import { useEffect, useState } from "react";
import { ago, api, type TrackedFinding } from "../api";
import { Card, ErrorNote, Spinner } from "../components/bits";

export function Watch() {
  const [state, setState] = useState<Awaited<ReturnType<typeof api.watch>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setState(await api.watch());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      await api.scan(asOf ? `${asOf}T07:00:00.000Z` : undefined);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const incidents = state?.findings.filter((f) => f.kind === "incident") ?? [];
  const market = state?.findings.filter((f) => f.kind === "market_shift") ?? [];

  return (
    <>
      <Card>
        <h2>Watchtower</h2>
        <p className="muted">
          Sweeps on <code>{state?.schedule ?? "…"}</code> · last swept {ago(state?.lastScanAt ?? null)}
          {state?.lastScanMs ? ` in ${state.lastScanMs} ms` : ""}
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void scan()} disabled={busy}>
            {busy ? "Sweeping…" : "Sweep now"}
          </button>
          <label className="muted" htmlFor="asof">
            as of
          </label>
          <input
            id="asof"
            type="text"
            placeholder="2026-06-29"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{ maxWidth: 150, flex: "none" }}
          />
          <span className="muted">— replay a historical date, or leave blank for today</span>
        </div>
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>

      {busy && (
        <Card>
          <Spinner label="Testing every segment against the rest of the pipeline…" />
        </Card>
      )}

      <Card>
        <h3>Incidents — a segment moved when the rest did not</h3>
        {incidents.length === 0 ? (
          <p className="empty">
            Nothing open. On quiet data this is the usual answer — the detector raises about 0.17
            findings per sweep.
          </p>
        ) : (
          incidents.map((f) => <Finding key={f.key} finding={f} onAck={() => void api.acknowledge(f.key).then(load)} />)
        )}

        <h3>Market shifts — the whole pipeline moved together</h3>
        {market.length === 0 ? (
          <p className="empty">None.</p>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 10 }}>
              Reported, never alerted. Nothing you own is channel-agnostic, so a uniform move is
              demand rather than a fault.
            </p>
            {market.map((f) => (
              <Finding key={f.key} finding={f} onAck={() => void api.acknowledge(f.key).then(load)} />
            ))}
          </>
        )}
      </Card>
    </>
  );
}

function Finding({ finding, onAck }: { finding: TrackedFinding; onAck: () => void }) {
  const pct = Math.abs(finding.effect - 1) * 100;
  return (
    <div className={`finding ${finding.kind} ${finding.direction} ${finding.status}`}>
      <div className="pills">
        <span className={`pill ${finding.status}`}>{finding.status}</span>
        <span className="pill">{finding.detector}</span>
        <span className="pill">{finding.direction}</span>
        {finding.acknowledgedAt && <span className="pill">acknowledged</span>}
      </div>
      <h4>{finding.headline}</h4>
      <p>{finding.narrative ?? finding.impact}</p>
      <p className="muted" style={{ marginTop: 6 }}>
        observed {Math.round(finding.observed).toLocaleString("en-IN")} vs expected{" "}
        {Math.round(finding.expected).toLocaleString("en-IN")} ({pct.toFixed(0)}%{" "}
        {finding.direction === "drop" ? "below" : "above"}) · window {finding.window.from} to{" "}
        {finding.window.to} · p={finding.p.toExponential(1)} · seen {finding.scanCount}×
      </p>
      {finding.status !== "resolved" && !finding.acknowledgedAt && (
        <button className="ghost" style={{ marginTop: 8, padding: "5px 12px" }} onClick={onAck}>
          Acknowledge
        </button>
      )}
    </div>
  );
}
