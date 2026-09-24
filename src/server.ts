import { getAgentByName, routeAgentRequest, type Agent } from "agents";
import { AnalystAgent, type Env } from "./agents/analyst";
import { WatchtowerAgent } from "./agents/watchtower";
import { ReportAgent } from "./agents/report";
import { LeadDeskAgent } from "./agents/leaddesk";
import { METRICS, METRIC_IDS } from "./semantic/metrics";
import { DIMENSION_IDS, FIELDS } from "./semantic/fields";

export { AnalystAgent, WatchtowerAgent, ReportAgent, LeadDeskAgent };
export type { Env, AnalystState, AnalystAnswer } from "./agents/analyst";
export type { WatchtowerState } from "./agents/watchtower";
export type { ReportState } from "./agents/report";
export type { LeadDeskState } from "./agents/leaddesk";

const DEFAULT_SESSION = "default";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

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

    // Convenience route for the UI and for curl: one shared session unless a
    // `session` query param names another.
    if (url.pathname === "/api/ask" && req.method === "POST") {
      const session = url.searchParams.get("session") ?? DEFAULT_SESSION;
      const agent = await getAgentByName(env.AnalystAgent, session);
      return agent.fetch(new Request(new URL("/ask", url).toString(), req));
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

/**
 * Route a prefixed path to one agent, preserving the leaf.
 *
 * The state parameter is left open: these four agents hold unrelated state
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
