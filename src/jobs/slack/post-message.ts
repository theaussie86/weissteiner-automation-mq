// Slack-Nachricht über einen Incoming Webhook. Erster Anwendungsfall: Backup-Alarme aus
// dem Homelab (minibee) - sofortige Fehlermeldung und Totmannschalter. Der Totmannschalter
// ist kein eigener Mechanismus: der Consumer reicht nach jedem erfolgreichen Lauf einen
// verzögerten slack.post-message mit fester jobId und onExisting "replace" ein. Bleibt der
// nächste Erfolg aus, läuft der verzögerte Job los und meldet das Ausbleiben.
//
// Die Webhook-URL ist ein Credential (provider "apikey", data { webhookUrl }), der Consumer
// schickt nur dessen Namen. Orchestrierung testbar gegen den SlackPoster-Seam, der
// fetch-Adapter liegt darunter. Struktur wie pinfinity/send-publish-error-mail.ts.

import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import { registerJobType } from "../registry.js";

export const SLACK_TEXT_MAX = 4000;

// Fehler mit HTTP-Status, damit die Orchestrierung ihn klassifizieren kann
// (429/5xx = Retry, übrige 4xx = Unrecoverable). Form wie ResendApiError.
export class SlackWebhookError extends Error {
  readonly status: number;
  constructor(status: number, responseBody: string) {
    super(`Slack webhook error ${status}: ${responseBody}`);
    this.name = "SlackWebhookError";
    this.status = status;
  }
}

export interface SlackPoster {
  post(webhookUrl: string, text: string): Promise<void>;
}

const webhookCredentialSchema = z.object({
  webhookUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://hooks.slack.com/")),
});

export async function postSlackMessage(
  poster: SlackPoster,
  credentialData: Record<string, unknown>,
  text: string,
): Promise<{ posted: true }> {
  const cred = webhookCredentialSchema.safeParse(credentialData);
  // Bewusst ohne Zod-Details: die würden die (geheime) URL in Log und Archiv tragen.
  if (!cred.success) {
    throw new UnrecoverableError("Invalid Slack credential: webhookUrl must be a https://hooks.slack.com/ URL");
  }
  try {
    await poster.post(cred.data.webhookUrl, text);
  } catch (err) {
    if (err instanceof SlackWebhookError) {
      if (err.status === 429 || err.status >= 500) throw err;
      // Übrige 4xx (z.B. 404 no_service, 410 channel_is_archived): Webhook kaputt, Retry hilft nicht.
      throw new UnrecoverableError(err.message);
    }
    // Netzwerk/Timeout => Retry.
    throw err;
  }
  return { posted: true };
}

// Adapter: erfüllt den SlackPoster-Seam mit dem echten Webhook-Call. Slacks Antwort-Body
// ist ein kurzer Fehlercode (z.B. "no_service"), keine Geheimnisse.
export const fetchSlackPoster: SlackPoster = {
  async post(webhookUrl, text) {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new SlackWebhookError(res.status, (await res.text()).slice(0, 200));
    }
  },
};

registerJobType({
  name: "slack.post-message",
  queue: "integrations",
  payloadSchema: z.object({
    slackCredential: z.string().min(1),
    text: z.string().min(1).max(SLACK_TEXT_MAX),
  }),
  attempts: 5,
  backoff: { type: "exponential", delay: 30_000 },
  process: async (payload, ctx) =>
    postSlackMessage(fetchSlackPoster, await ctx.getCredential(payload.slackCredential), payload.text),
});
