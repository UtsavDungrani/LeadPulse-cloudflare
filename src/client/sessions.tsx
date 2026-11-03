/**
 * The conversation store.
 *
 * Sessions are shared state between the shell - which lists them - and the Ask
 * view, which reads and writes one of them, so they live in a context rather
 * than being threaded through props or duplicated on both sides.
 *
 * A new conversation exists in the browser before it exists on the server. It
 * is registered by the Worker when its first question lands, which is what
 * keeps the list free of empty conversations nobody asked anything in.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type SessionMeta } from "./api";
import { newSessionId } from "../agents/session-names";

interface SessionsValue {
  sessions: SessionMeta[];
  activeId: string;
  /** True until the first list has come back, so the panel can say so. */
  loading: boolean;
  select: (id: string) => void;
  startNew: () => void;
  remove: (id: string) => Promise<void>;
  /** Re-read the list after a question has been answered. */
  refresh: () => Promise<void>;
}

const Ctx = createContext<SessionsValue | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }) {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [activeId, setActiveId] = useState<string>(() => newSessionId());
  const [loading, setLoading] = useState(true);
  // A conversation the reader has explicitly opened is never replaced by the
  // list arriving late - the fetch below only picks a default the first time.
  const [touched, setTouched] = useState(false);

  const refresh = useCallback(async () => {
    const { sessions: list } = await api.sessions();
    setSessions(list);
    return list;
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const list = await refresh();
        setActiveId((current) => (touched || list.length === 0 ? current : list[0]!.id));
      } catch {
        // An unreachable index is not worth an error screen: a fresh
        // conversation still works, and the panel simply shows nothing.
      } finally {
        setLoading(false);
      }
    })();
    // Once, on mount. `touched` is read, not depended on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value = useMemo<SessionsValue>(
    () => ({
      sessions,
      activeId,
      loading,
      select: (id) => {
        setTouched(true);
        setActiveId(id);
      },
      startNew: () => {
        setTouched(true);
        setActiveId(newSessionId());
      },
      remove: async (id) => {
        const { sessions: list } = await api.deleteSession(id);
        setSessions(list);
        // Deleting what you are looking at leaves you looking at nothing, so
        // land on the next most recent conversation, or a fresh one.
        if (id === activeId) setActiveId(list[0]?.id ?? newSessionId());
      },
      refresh: async () => {
        await refresh();
      },
    }),
    [sessions, activeId, loading, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSessions(): SessionsValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useSessions must be used inside SessionsProvider");
  return value;
}
