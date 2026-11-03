/**
 * `SessionsAgent` - the index of who has asked what.
 *
 * Durable Objects cannot be enumerated: you can address one by name, but there
 * is no way to ask the namespace which names exist. A conversation list needs
 * exactly that, so one more Durable Object holds the list and the per-session
 * transcripts stay where they already are, inside their own `AnalystAgent`.
 *
 * The index is deliberately thin - an id, a title and two timestamps. It is a
 * pointer, never a second copy of the transcript, so it cannot disagree with
 * the session it points at.
 */
import { Agent } from "agents";
import type { Env } from "./analyst";
import { titleFor } from "./session-names";

export { titleFor, newSessionId } from "./session-names";

export interface SessionMeta {
  /** Also the Durable Object name of the `AnalystAgent` holding the transcript. */
  id: string;
  title: string;
  createdAt: string;
  lastAt: string;
  turns: number;
}

export interface SessionsState {
  sessions: SessionMeta[];
}

/**
 * How many conversations the list keeps. The transcripts themselves are not
 * deleted when one falls off the end - a Durable Object keeps its state until
 * it is reset - so this bounds the list, not the data.
 */
const MAX_SESSIONS = 50;

const INITIAL: SessionsState = { sessions: [] };

export class SessionsAgent extends Agent<Env, SessionsState> {
  initialState = INITIAL;

  private list(): SessionMeta[] {
    return [...(this.state.sessions ?? [])].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
  }

  /**
   * Record that a session was used. The first question becomes the title and
   * later ones do not overwrite it - a conversation is named by what opened it,
   * and a title that changes under the reader is a title they cannot find again.
   */
  private touch(id: string, question: string): SessionMeta {
    const now = new Date().toISOString();
    const existing = (this.state.sessions ?? []).find((s) => s.id === id);
    const next: SessionMeta = existing
      ? { ...existing, lastAt: now, turns: existing.turns + 1 }
      : { id, title: titleFor(question), createdAt: now, lastAt: now, turns: 1 };

    this.setState({
      sessions: [next, ...(this.state.sessions ?? []).filter((s) => s.id !== id)].slice(0, MAX_SESSIONS),
    });
    return next;
  }

  async onRequest(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, string>) : {};

    if (req.method === "POST" && path.endsWith("/touch")) {
      if (!body.id) return Response.json({ ok: false, reason: "id is required" }, { status: 400 });
      return Response.json({ ok: true, session: this.touch(body.id, body.question ?? "") });
    }

    if (req.method === "POST" && path.endsWith("/rename")) {
      const title = titleFor(body.title ?? "");
      this.setState({
        sessions: (this.state.sessions ?? []).map((s) => (s.id === body.id ? { ...s, title } : s)),
      });
      return Response.json({ ok: true, sessions: this.list() });
    }

    if (req.method === "POST" && path.endsWith("/delete")) {
      this.setState({ sessions: (this.state.sessions ?? []).filter((s) => s.id !== body.id) });
      // The transcript is cleared by the router, which owns the Analyst stub.
      return Response.json({ ok: true, sessions: this.list() });
    }

    return Response.json({ sessions: this.list() });
  }
}
