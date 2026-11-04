import { getAgentByName, routeAgentRequest, type Agent } from "agents";
import { AnalystAgent, type Env } from "./agents/analyst";
import { WatchtowerAgent } from "./agents/watchtower";
import { ReportAgent } from "./agents/report";
import { LeadDeskAgent } from "./agents/leaddesk";
import { SessionsAgent } from "./agents/sessions";
import { METRICS, METRIC_IDS } from "./semantic/metrics";
import { DIMENSION_IDS, FIELDS } from "./semantic/fields";
import { handleEvalRequest } from "./evals/route";

export { AnalystAgent, WatchtowerAgent, ReportAgent, LeadDeskAgent, SessionsAgent };
export type { Env, AnalystState, AnalystAnswer } from "./agents/analyst";
export type { WatchtowerState } from "./agents/watchtower";
export type { ReportState } from "./agents/report";
export type { LeadDeskState } from "./agents/leaddesk";
export type { SessionsState, SessionMeta } from "./agents/sessions";

const DEFAULT_SESSION = "default";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    // The golden-set runner. Off unless EVALS_ENABLED is "true" - see evals/route.ts.
    const evalResponse = await handleEvalRequest(req, env, url);
    if (evalResponse) return evalResponse;

    /**
     * The semantic layer, described. Worth exposing: it is the contract the UI
     * builds against and the list a reader checks a claimed number against.
     */
    if (url.pathname === "/api/catalog") {
      return Response.json({
        metrics: METRIC_IDS.map((id) => ({
          id,
          label: METRICS[id].label,
          unit: METRICS[id].unit,
          higherIsBetter: METRICS[id].higherIsBetter,
          description: METRICS[id].description,
        })),
        dimensions: DIMENSION_IDS.map((id) => ({
          id,
          description: FIELDS[id].description,
          values: "values" in FIELDS[id] ? FIELDS[id].values : undefined,
        })),
      });
    }

    /**
     * One conversation per `session`, defaulting to a shared one so curl still
     * works without picking a name.
     *
     * POST asks; GET returns that conversation's transcript. The index is
     * updated here rather than inside the Analyst, so the two can never
     * disagree about whether a turn happened - the same response decides both.
     */
    if (url.pathname === "/api/ask") {
      const session = url.searchParams.get("session") ?? DEFAULT_SESSION;
      const agent = await getAgentByName(env.AnalystAgent, session);

      if (req.method !== "POST") {
        return agent.fetch(new Request(new URL("/history", url).toString(), { method: "GET" }));
      }

      const body = await req.text();
      const response = await agent.fetch(
        new Request(new URL("/ask", url).toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      const answer = (await response.json()) as { ok?: boolean; kind?: string };
      // An error is not a turn: the Analyst does not add it to the transcript,
      // so the index must not count it either. A refusal *is* a turn.
      if (!(answer.ok === false && answer.kind === "error")) {
        const question = (JSON.parse(body || "{}") as { question?: string }).question ?? "";
        await touchSession(env, url, session, question);
      }
      return Response.json(answer, { status: response.status });
    }

    // The conversation list. Deleting drops the pointer and resets the
    // transcript it pointed at, in that order - a list entry with no
    // conversation behind it is worse than a conversation with no entry.
    if (url.pathname.startsWith("/api/sessions")) {
      if (url.pathname.endsWith("/delete") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { id?: string };
        if (body.id) {
          const analyst = await getAgentByName(env.AnalystAgent, body.id);
          await analyst.fetch(new Request(new URL("/reset", url).toString(), { method: "POST" }));
        }
        const index = await getAgentByName(env.SessionsAgent, DEFAULT_SESSION);
        return index.fetch(
          new Request(new URL("/delete", url).toString(), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
      }
      return forward(env.SessionsAgent, "/api/sessions", url, req);
    }

    // The Watchtower feed: what the pipeline looks like right now, without
    // anyone having had to ask a question.
    if (url.pathname.startsWith("/api/watch")) {
      return forward(env.WatchtowerAgent, "/api/watch", url, req);
    }

    // The weekly digest.
    if (url.pathname.startsWith("/api/report")) {
      return forward(env.ReportAgent, "/api/report", url, req);
    }

    // The write path. Every route under here is propose / approve / reject /
    // revert - there is deliberately no endpoint that takes a request and
    // writes in one step.
    if (url.pathname.startsWith("/api/desk")) {
      return forward(env.LeadDeskAgent, "/api/desk", url, req);
    }

    return (
      (await routeAgentRequest(req, env, { cors: true })) ?? new Response("not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;

async function touchSession(env: Env, url: URL, id: string, question: string): Promise<void> {
  const index = await getAgentByName(env.SessionsAgent, DEFAULT_SESSION);
  await index.fetch(
    new Request(new URL("/touch", url).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, question }),
    }),
  );
}

/**
 * Route a prefixed path to one agent, preserving the leaf.
 *
 * The state parameter is left open: these agents hold unrelated state
 * shapes and this function only ever calls `fetch` on the stub.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function forward<A extends Agent<Env, any>>(
  namespace: DurableObjectNamespace<A>,
  prefix: string,
  url: URL,
  req: Request,
): Promise<Response> {
  const agent = await getAgentByName(namespace, DEFAULT_SESSION);
  const leaf = url.pathname.slice(prefix.length) || "/";
  return agent.fetch(new Request(new URL(leaf, url).toString(), req));
}
