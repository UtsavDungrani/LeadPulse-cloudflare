/**
 * Where a digest goes.
 *
 * Delivery is the one part of this system that reaches outside it, so the
 * default is **off**. `REPORT_SINK` must be set deliberately and, for the
 * webhook, a URL must be supplied as a secret. Nothing is posted anywhere
 * because a digest happened to be generated.
 *
 * `none` is not a stub: it is the correct production setting until someone has
 * decided who should receive these and agreed that the contents - lead volumes,
 * rep names, spend - may leave the system.
 */
import type { Digest } from "./digest";

export type SinkKind = "none" | "webhook";

export interface DeliveryResult {
  sink: SinkKind;
  delivered: boolean;
  detail: string;
}

export interface DeliveryEnv {
  REPORT_SINK?: string;
  /** Set with `wrangler secret put REPORT_WEBHOOK_URL`. Never committed. */
  REPORT_WEBHOOK_URL?: string;
}

export function resolveSink(env: DeliveryEnv): SinkKind {
  return env.REPORT_SINK === "webhook" ? "webhook" : "none";
}

export async function deliver(digest: Digest, env: DeliveryEnv): Promise<DeliveryResult> {
  const sink = resolveSink(env);

  if (sink === "none") {
    return {
      sink,
      delivered: false,
      detail: "Held. Set REPORT_SINK to enable delivery; the digest is readable at /api/report/latest.",
    };
  }

  const url = env.REPORT_WEBHOOK_URL;
  if (!url) {
    return { sink, delivered: false, detail: "REPORT_SINK is webhook but REPORT_WEBHOOK_URL is not set." };
  }
  if (!url.startsWith("https://")) {
    // A digest carries rep names and spend figures. It does not travel in clear.
    return { sink, delivered: false, detail: "REPORT_WEBHOOK_URL must be https." };
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `text` is what Slack-compatible incoming webhooks read; anything else
      // receiving this gets the same markdown plus the structured digest.
      body: JSON.stringify({ text: digest.markdown, digest }),
    });
    return {
      sink,
      delivered: response.ok,
      detail: response.ok ? `Delivered (${response.status}).` : `Webhook returned ${response.status}.`,
    };
  } catch (e) {
    return { sink, delivered: false, detail: `Webhook failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
