import { getAgentByName, routeAgentRequest } from "agents";
import { AnalystAgent, type Env } from "./agents/analyst";
import { METRICS, METRIC_IDS } from "./semantic/metrics";
import { DIMENSION_IDS, FIELDS } from "./semantic/fields";

export { AnalystAgent };
export type { Env, AnalystState, AnalystAnswer } from "./agents/analyst";

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

    return (
      (await routeAgentRequest(req, env, { cors: true })) ?? new Response("not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
