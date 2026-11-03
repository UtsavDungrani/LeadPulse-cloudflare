/**
 * The conversation list.
 *
 * Each row is a pointer to a Durable Object that still holds its own
 * transcript, so opening one redraws the original answers - the charts, the
 * tables and the pipelines that produced them - rather than re-running the
 * query against data that may have moved since.
 */
import { useState } from "react";
import { ago } from "../api";
import { useSessions } from "../sessions";

export function SessionPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { sessions, activeId, loading, select, startNew, remove } = useSessions();
  // Deleting a conversation cannot be undone, so the button asks once. A
  // browser confirm() would do the same job and stop the whole page to do it.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  function open(id: string) {
    select(id);
    location.hash = "ask";
    onNavigate?.();
  }

  return (
    <aside className="sidebar" aria-label="Conversations">
      <div className="side-head">
        <h2>Conversations</h2>
        <button
          type="button"
          className="side-new"
          onClick={() => {
            startNew();
            location.hash = "ask";
            onNavigate?.();
          }}
        >
          + New
        </button>
      </div>

      {loading && <p className="side-empty">Loading…</p>}

      {!loading && sessions.length === 0 && (
        <p className="side-empty">
          No conversations yet. Ask something and it will be saved here.
        </p>
      )}

      <ul className="side-list">
        {sessions.map((s) => (
          <li key={s.id} className={s.id === activeId ? "active" : undefined}>
            <button type="button" className="side-item" onClick={() => open(s.id)}>
              <span className="side-title">{s.title}</span>
              <span className="side-meta">
                {ago(s.lastAt)} · {s.turns} {s.turns === 1 ? "question" : "questions"}
              </span>
            </button>
            {pendingDelete === s.id ? (
              <span className="side-confirm">
                <button type="button" onClick={() => void remove(s.id).then(() => setPendingDelete(null))}>
                  Delete
                </button>
                <button type="button" onClick={() => setPendingDelete(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="side-del"
                aria-label={`Delete ${s.title}`}
                title="Delete this conversation"
                onClick={() => setPendingDelete(s.id)}
              >
                ×
              </button>
            )}
          </li>
        ))}
      </ul>

      <p className="side-note">
        Each conversation keeps its own context, so a follow-up like
        <em> now break that down by city </em>
        patches the previous query rather than starting again.
      </p>
    </aside>
  );
}
