import { useEffect, useState } from "react";
import { api, type AnalystAnswer, type AnalystTurn } from "../api";
import { Chart } from "../charts";
import { Card, DataTable, Disclosure, ErrorNote, Json, Spinner, StatTile } from "../components/bits";
import { useSessions } from "../sessions";

const EXAMPLES = [
  "Show Olark Chat conversion by week in June 2026",
  "Conversion by channel this month vs last month",
  "Which rep is sitting on the most stale leads?",
  "What was our CAC by channel in April 2026?",
  "Monthly lead volume by source for the last year",
  "What is our customer lifetime value?",
];

export function Ask() {
  const { activeId, sessions, refresh } = useSessions();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<AnalystTurn[]>([]);
  const [loadingTurns, setLoadingTurns] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A conversation the index has never heard of has no transcript to fetch,
  // and asking for one would spin up an empty Durable Object per keystroke of
  // curiosity. Unknown means new means empty.
  const known = sessions.some((s) => s.id === activeId);

  useEffect(() => {
    setError(null);
    if (!known) {
      setTurns([]);
      return;
    }
    let cancelled = false;
    setLoadingTurns(true);
    void (async () => {
      try {
        const { turns: history } = await api.history(activeId);
        if (!cancelled) setTurns(history);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingTurns(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, known]);

  async function ask(q: string) {
    if (!q.trim() || busy) return;
    setBusy(true);
    setError(null);
    setQuestion(q);
    try {
      const answer = await api.ask(q, activeId);
      setTurns((prior) => [
        ...prior,
        { id: `local-${Date.now()}`, at: new Date().toISOString(), question: q, answer },
      ]);
      setQuestion("");
      // The list is keyed on the last question, so it moves to the top here.
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Card>
        <form
          className="ask-row"
          onSubmit={(e) => {
            e.preventDefault();
            void ask(question);
          }}
        >
          <input
            type="text"
            value={question}
            placeholder={turns.length > 0 ? "Ask a follow-up…" : "Ask about the pipeline…"}
            aria-label="Question"
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button className="primary" type="submit" disabled={busy || !question.trim()}>
            Ask
          </button>
        </form>
        {turns.length === 0 && (
          <div className="examples">
            {EXAMPLES.map((e) => (
              <button key={e} type="button" onClick={() => void ask(e)} disabled={busy}>
                {e}
              </button>
            ))}
          </div>
        )}
        {turns.length > 0 && (
          <p className="muted" style={{ marginTop: 10 }}>
            {turns.length} {turns.length === 1 ? "question" : "questions"} in this conversation. A follow-up
            patches the previous query rather than starting from nothing.
          </p>
        )}
        {error && <ErrorNote>{error}</ErrorNote>}
      </Card>

      {busy && (
        <Card>
          <Spinner label="Planning the query, running it, and writing it up…" />
        </Card>
      )}

      {loadingTurns && (
        <Card>
          <Spinner label="Opening the conversation…" />
        </Card>
      )}

      {/*
        Newest first. An answer here is a chart, a table and an audit trail -
        several screens of it - so appending downwards would put every new
        answer below a fold the reader has to scroll past to reach.
      */}
      {[...turns].reverse().map((t) => (
        <Turn key={t.id} turn={t} />
      ))}
    </>
  );
}

function Turn({ turn }: { turn: AnalystTurn }) {
  return (
    <>
      <p className="asked">{turn.question}</p>
      <Answer answer={turn.answer} />
    </>
  );
}

/**
 * The answer to a question that named no metric.
 *
 * Tiles, not a chart: seven unrelated measures share no axis, and forcing them
 * onto one is the dual-axis mistake with five more axes. The two blocks are
 * separated because they describe two different windows - reporting yesterday's
 * conversion rate would be confidently wrong, since yesterday's leads have
 * barely started converting.
 */
function Overview({ answer }: { answer: Extract<AnalystAnswer, { kind: "overview" }> }) {
  const { overview } = answer;
  return (
    <Card>
      <h2>{answer.headline}</h2>
      <p className="narrative">{answer.narrative}</p>
      <p className="muted" style={{ marginTop: 8 }}>
        {answer.summarySource === "model"
          ? "Written by the model, over figures it was handed and could not recompute. Every number in it was checked against the data below."
          : "Computed from the numbers — see the note below for why the written summary was not used."}
      </p>

      <h3>
        {overview.period.from === overview.period.to
          ? overview.period.from
          : `${overview.period.from} to ${overview.period.to}`}
      </h3>
      <div className="tiles">
        {overview.live.map((m) => (
          <StatTile key={m.id} label={m.label} value={m.formatted} {...delta(m)} />
        ))}
      </div>

      {overview.matured.length > 0 && (
        <>
          <h3>
            Outcomes · {overview.maturedPeriod.from} to {overview.maturedPeriod.to}
          </h3>
          {overview.maturedIsLagged && (
            <p className="muted" style={{ marginTop: -4, marginBottom: 10 }}>
              A window of the same length that has had time to convert. Reporting these for the
              window you asked about would show a collapse that always recovers.
            </p>
          )}
          <div className="tiles">
            {overview.matured.map((m) => (
              <StatTile key={m.id} label={m.label} value={m.formatted} {...delta(m)} />
            ))}
          </div>
        </>
      )}

      {answer.notes.length > 0 && (
        <p className="muted" style={{ marginTop: 16 }}>
          {answer.notes.join(" ")}
        </p>
      )}

      <Disclosure
        summary={`How this was computed — ${answer.queries.length} queries, ${answer.timings.totalMs} ms`}
      >
        <p className="muted" style={{ marginTop: 8 }}>
          Every tile is an ordinary query against the same compiler, with no metric chosen on your
          behalf. The window is the only thing the model decided.
        </p>
        <h3>Overview intent</h3>
        <Json value={answer.intent} />
        {answer.queries.map((q, i) => (
          <div key={`${q.name}-${i}`}>
            <h3>
              {q.name} · {q.collection}
            </h3>
            <Json value={q.pipeline} />
          </div>
        ))}
      </Disclosure>
    </Card>
  );
}

/** A rounded "+0%" is noise dressed as a measurement; say flat and mean it. */
function delta(m: {
  changePct: number | null;
  higherIsBetter: boolean;
}): { delta?: string; deltaGood?: boolean | null } {
  if (m.changePct === null) return {};
  if (Math.abs(m.changePct) < 1) return { delta: "flat vs prior window", deltaGood: null };
  return {
    delta: `${m.changePct >= 0 ? "+" : ""}${m.changePct.toFixed(0)}% vs prior window`,
    deltaGood: m.changePct > 0 === m.higherIsBetter,
  };
}

function Answer({ answer }: { answer: AnalystAnswer }) {
  if (answer.ok && answer.kind === "overview") return <Overview answer={answer} />;

  if (!answer.ok && answer.kind === "refusal") {
    return (
      <Card>
        <h2>Not answerable from this data</h2>
        <p className="narrative">{answer.reason}</p>
        {answer.suggestion && (
          <p className="narrative">
            <strong>Try instead:</strong> {answer.suggestion}
          </p>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          Declining is a correct answer here. Many columns are 25–50% null, and there is no revenue
          anywhere in this dataset.
        </p>
      </Card>
    );
  }

  if (!answer.ok) {
    return (
      <Card>
        <ErrorNote>{answer.message}</ErrorNote>
      </Card>
    );
  }

  return (
    <Card>
      <h2>{answer.headline}</h2>
      <p className="narrative">{answer.narrative}</p>

      <Chart spec={answer.chart} points={answer.points} />

      {/*
        The table is not optional. Three light-mode palette slots sit below 3:1
        against the surface, and the data-viz relief rule for that is visible
        labels or a table view - so the table ships with every chart rather than
        hiding behind a toggle.
      */}
      <h3>The numbers</h3>
      <DataTable table={answer.table} />

      {answer.notes.length > 0 && (
        <p className="muted" style={{ marginTop: 12 }}>
          {answer.notes.join(" ")}
        </p>
      )}

      <Disclosure
        summary={`How this was computed — ${answer.queries.length} ${
          answer.queries.length === 1 ? "query" : "queries"
        }, ${answer.timings.totalMs} ms`}
      >
        <p className="muted" style={{ marginTop: 8 }}>
          The model produced the intent below. A deterministic compiler turned it into these
          pipelines; the arithmetic never touched a model.
        </p>
        <h3>Query intent</h3>
        <Json value={answer.intent} />
        {answer.queries.map((q) => (
          <div key={q.name}>
            <h3>
              {q.name} · {q.collection}
            </h3>
            <Json value={q.pipeline} />
          </div>
        ))}
        <p className="muted">
          plan {answer.timings.planMs} ms · query {answer.timings.queryMs} ms · narrate{" "}
          {answer.timings.narrateMs} ms
        </p>
      </Disclosure>
    </Card>
  );
}
