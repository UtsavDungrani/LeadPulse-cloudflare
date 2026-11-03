import { useEffect, useState } from "react";
import { ago, api, type Digest } from "../api";
import { Card, ErrorNote, Spinner, StatTile } from "../components/bits";

export function DigestView() {
  const [digest, setDigest] = useState<Digest | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof api.reportStatus>> | null>(null);
  const [busy, setBusy] = useState(false);
  const [asOf, setAsOf] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [s, d] = await Promise.all([api.reportStatus(), api.latestDigest()]);
        setStatus(s);
        setDigest(d.digest);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api.runReport(asOf ? `${asOf}T08:00:00.000Z` : undefined);
      setDigest(r.digest);
      setStatus(await api.reportStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <h2>Weekly digest</h2>
        <p className="muted">
          Runs on <code>{status?.schedule ?? "…"}</code> · last built {ago(status?.lastRunAt ?? null)} ·
          delivery <strong>{status?.sink ?? "…"}</strong>
        </p>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => void run()} disabled={busy}>
            {busy ? "Building…" : "Build now"}
          </button>
          <label className="muted" htmlFor="rasof">
            as of
          </label>
          <input
            id="rasof"
            type="text"
            placeholder="2026-09-24"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            style={{ maxWidth: 150, flex: "none" }}
          />
        </div>
        {status?.sink === "none" && (
          <p className="muted" style={{ marginTop: 10 }}>
            Delivery is off by default. It stays off until someone decides who may receive lead
            volumes, rep names and spend figures.
          </p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>

      {busy && (
        <Card>
          <Spinner label="Building the digest…" />
        </Card>
      )}

      {!digest && !busy && (
        <Card>
          <p className="empty">No digest yet. Build one to see it.</p>
        </Card>
      )}

      {digest && !busy && <Body digest={digest} />}
    </>
  );
}

function Body({ digest }: { digest: Digest }) {
  return (
    <>
      <Card>
        <h2>
          {digest.period.from} to {digest.period.to}
        </h2>
        <p className="narrative">{digest.summary}</p>
        <p className="muted" style={{ marginTop: 8 }}>
          Summary written {digest.summarySource === "model" ? "by the model" : "from the numbers"}.
        </p>

        <h3>This period</h3>
        <div className="tiles">
          {digest.thisPeriod.map((m) => (
            <StatTile
              key={m.id}
              label={m.label}
              value={m.formatted}
              delta={deltaLabel(m.changePct)}
              deltaGood={
                m.changePct === null || Math.abs(m.changePct) < 1 ? null : m.changePct > 0 === m.higherIsBetter
              }
            />
          ))}
        </div>

        <h3>
          Matured cohort · {digest.maturedPeriod.from} to {digest.maturedPeriod.to}
        </h3>
        <p className="muted" style={{ marginTop: -4, marginBottom: 10 }}>
          An earlier week that has had time to convert. Conversion and CAC are only meaningful here —
          this week&rsquo;s cohort has barely started converting, so reporting its rate would show a
          collapse that always recovers.
        </p>
        <div className="tiles">
          {digest.maturedCohort.map((m) => (
            <StatTile
              key={m.id}
              label={m.label}
              value={m.formatted}
              delta={deltaLabel(m.changePct)}
              deltaGood={
                m.changePct === null || Math.abs(m.changePct) < 1 ? null : m.changePct > 0 === m.higherIsBetter
              }
            />
          ))}
        </div>

        <h3>Channels</h3>
        <ChannelBars digest={digest} />
      </Card>

      <Card>
        <h3>Watchtower</h3>
        <p className="muted" style={{ marginTop: -4 }}>
          {digest.findingsAsOf ? `Last swept ${ago(digest.findingsAsOf)}.` : "Never swept."}
        </p>
        {digest.findings.length === 0 ? (
          <p className="empty">Nothing open.</p>
        ) : (
          digest.findings.map((f) => (
            <div key={f.key} className={`finding ${f.kind}`}>
              <h4>{f.headline}</h4>
              <p>{f.narrative ?? f.impact}</p>
            </div>
          ))
        )}
      </Card>
    </>
  );
}

/** A rounded "+0%" is noise dressed as a measurement; say flat and mean it. */
function deltaLabel(changePct: number | null): string | undefined {
  if (changePct === null) return undefined;
  if (Math.abs(changePct) < 1) return "flat vs prior week";
  return `${changePct >= 0 ? "+" : ""}${changePct.toFixed(0)}% vs prior week`;
}

/**
 * Horizontal bars. One series, one colour — a value ramp here would encode bar
 * length twice and burn the only free channel on information already on screen.
 */
function ChannelBars({ digest }: { digest: Digest }) {
  const max = Math.max(...digest.channels.map((c) => c.leads), 1);
  return (
    <div>
      {digest.channels.map((c) => (
        <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <div style={{ width: 140, fontSize: 13.5, color: "var(--text-secondary)" }}>{c.name}</div>
          <div style={{ flex: 1, height: 20 }}>
            <div
              style={{
                width: `${Math.max((c.leads / max) * 100, 1)}%`,
                height: "100%",
                background: "var(--series-1)",
                borderRadius: "3px 4px 4px 3px",
              }}
            />
          </div>
          <div
            style={{
              width: 56,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
              fontSize: 13.5,
              fontWeight: 600,
            }}
          >
            {c.leads}
          </div>
          <div style={{ width: 84, textAlign: "right", fontSize: 13, color: "var(--text-muted)" }}>
            {c.changePct === null ? "—" : `${c.changePct >= 0 ? "+" : ""}${c.changePct.toFixed(0)}%`}
          </div>
        </div>
      ))}
    </div>
  );
}
