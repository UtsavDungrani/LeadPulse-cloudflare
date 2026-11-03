import { useEffect, useState } from "react";
import { Ask } from "./views/Ask";
import { Watch } from "./views/Watch";
import { DigestView } from "./views/DigestView";
import { Desk } from "./views/Desk";
import { SessionPanel } from "./components/SessionPanel";
import { SessionsProvider } from "./sessions";

const TABS = [
  { id: "ask", label: "Ask", title: "Ask the analyst" },
  { id: "watch", label: "Watch", title: "What the watchtower found" },
  { id: "digest", label: "Digest", title: "The weekly digest" },
  { id: "desk", label: "Desk", title: "Propose a change" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function useTheme() {
  const [theme, setTheme] = useState<"system" | "light" | "dark">(
    () => (localStorage.getItem("theme") as "light" | "dark" | null) ?? "system",
  );
  useEffect(() => {
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
      localStorage.removeItem("theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
      localStorage.setItem("theme", theme);
    }
  }, [theme]);
  return [theme, setTheme] as const;
}

export function App() {
  // The tab lives in the hash so a refresh, or a shared link, lands where it
  // left off - and so the nav can be real links rather than buttons pretending.
  const [tab, setTab] = useState<TabId>(
    () => (TABS.find((t) => t.id === location.hash.slice(1))?.id ?? "ask") as TabId,
  );
  const [theme, setTheme] = useTheme();
  const [panelOpen, setPanelOpen] = useState(false);

  // Without this the hash is write-only: the back button and a pasted #watch
  // link both leave the view where it was.
  useEffect(() => {
    const onHashChange = () => {
      const next = TABS.find((t) => t.id === location.hash.slice(1))?.id;
      if (next) setTab(next);
    };
    addEventListener("hashchange", onHashChange);
    return () => removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    if (location.hash.slice(1) !== tab) location.hash = tab;
  }, [tab]);

  return (
    <SessionsProvider>
      <header className="navbar">
        <div className="nav-inner">
          <button
            type="button"
            className="nav-toggle"
            aria-label="Conversations"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((v) => !v)}
          >
            <span aria-hidden="true">☰</span>
          </button>

          <a className="brand" href="#ask">
            LeadPulse<span>an analyst that works a shift</span>
          </a>

          {/*
            Links, not buttons. Each view has its own address, so it can be
            opened in a new tab, bookmarked and reached with the back button -
            none of which a button that mutates state can do.
          */}
          <nav className="nav-links" aria-label="Views">
            {TABS.map((t) => (
              <a key={t.id} href={`#${t.id}`} aria-current={tab === t.id ? "page" : undefined} title={t.title}>
                {t.label}
              </a>
            ))}
          </nav>

          <button
            type="button"
            className="nav-theme"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            aria-label="Toggle colour scheme"
            title="Toggle colour scheme"
          >
            {theme === "dark" ? "Light" : "Dark"}
          </button>
        </div>
      </header>

      <div className={`shell${panelOpen ? " panel-open" : ""}`}>
        <SessionPanel onNavigate={() => setPanelOpen(false)} />
        {/* Tapping away closes the panel on a phone, where it sits over the page. */}
        <div className="scrim" onClick={() => setPanelOpen(false)} aria-hidden="true" />

        <main>
          {tab === "ask" && <Ask />}
          {tab === "watch" && <Watch />}
          {tab === "digest" && <DigestView />}
          {tab === "desk" && <Desk />}
        </main>
      </div>
    </SessionsProvider>
  );
}
