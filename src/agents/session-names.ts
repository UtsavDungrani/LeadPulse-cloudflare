/**
 * Naming rules for conversations, shared by the index and the browser.
 *
 * The client mints an id before the first question is asked; the Durable Object
 * registers it when that question lands. Two implementations of the same id
 * scheme would drift, so there is one, and it is pure - no `agents` import, so
 * the browser bundle does not pull a Durable Object runtime in behind it.
 */

/** Long enough to tell two questions apart in a 260px column, short enough to fit. */
const TITLE_MAX = 64;

export function titleFor(question: string): string {
  const clean = question.trim().replace(/\s+/g, " ");
  if (clean.length <= TITLE_MAX) return clean || "Untitled";
  return `${clean.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

/**
 * A readable id that is safe as a Durable Object name and as a URL segment.
 * Date-prefixed so the raw list is roughly chronological before it is sorted.
 */
export function newSessionId(now = new Date(), rand = Math.random): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const suffix = Math.floor(rand() * 36 ** 5)
    .toString(36)
    .padStart(5, "0");
  return `s${day}-${suffix}`;
}
