import { createHmac } from "node:crypto";

// Callback (CONTEXT.md): Worker POSTet das Job-Ergebnis an die callbackUrl des
// Consumers. Nur Status + Temp-URL, nie Datei-Inhalte. Signatur via HMAC über
// den Body (Header X-MQ-Signature), damit der Empfänger Echtheit prüfen kann.

export interface CallbackPayload {
  jobId: string;
  queue: string;
  type: string;
  status: "completed" | "failed";
  tenant: string | null;
  result?: unknown;
  error?: string;
}

export function signCallbackBody(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export async function sendCallback(
  url: string,
  payload: CallbackPayload,
  signingSecret?: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signingSecret) {
    headers["x-mq-signature"] = signCallbackBody(signingSecret, body);
  }
  // Ein Versuch + zwei Retries mit Backoff — Callback-Fehler brechen nie den Job.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { ok: true, status: response.status };
      if (attempt === 3) return { ok: false, status: response.status };
    } catch (err) {
      if (attempt === 3) return { ok: false, error: (err as Error).message };
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  return { ok: false };
}
