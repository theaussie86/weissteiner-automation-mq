// Seam recordPublishEvent (Teil 2 der Pinfinity-Migration, Ticket #18): schreibt
// Veröffentlichungs-Ereignisse in Pinfinitys Tabelle pin_publish_events
// (Schema siehe petra-pinterest#109). Pinfinity liest die Zeilen für Pin-Historie
// und globales Log.
//
// Struktur wie cleanup.ts: reine Logik plus Seam (PublishEventStore) plus dünner
// supabase-js-Adapter weiter unten.
//
// Best-Effort: Ein Schreibfehler (DB down, RLS, Schema) wirft nie, sondern wird nur
// geloggt — ein Log-Fehler darf keine Veröffentlichung scheitern oder wiederholen lassen.

import type { SupabaseClient } from "@supabase/supabase-js";

// Geteilter Ereignistyp, von publish-pin (#19) und send-publish-error-mail (#20) genutzt.
export type PublishEventType =
  | "attempt_started"
  | "succeeded"
  | "retry_scheduled"
  | "failed_final"
  | "mail_sent";

export interface PublishEventInput {
  pinId: string;
  blogProjectId: string;
  type: PublishEventType;
  /** Leer (null) z.B. bei mail_sent. */
  attempt?: number | null;
  maxAttempts?: number | null;
  /** Kurze, lesbare Zeile (z.B. Fehlertext); wird gekürzt und von Tokens befreit. */
  message?: string | null;
  /** z.B. http_status, error_class, next_retry_at, job_id, pinterest_pin_id, recipient. */
  details?: Record<string, unknown>;
}

// Zeile, wie sie persistiert wird (DB-Spaltennamen). created_at setzt die DB per Default.
export interface PublishEventRow {
  pin_id: string;
  blog_project_id: string;
  event_type: PublishEventType;
  attempt: number | null;
  max_attempts: number | null;
  message: string | null;
  details: Record<string, unknown>;
}

// Schmaler Seam auf Pinfinitys Supabase: eine High-Level-Operation statt der
// fluent supabase-js-API, damit die Logik mit einem trivialen Fake testbar bleibt.
export interface PublishEventStore {
  insertEvent(row: PublishEventRow): Promise<void>;
}

export const MAX_MESSAGE_LENGTH = 500;

// Entfernt Zugriffstokens aus freiem Text (Bearer-Header, Pinterest-Tokens),
// bevor Fehlertexte o.ä. in message/details landen.
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PINTEREST_TOKEN_RE = /\bpin[a-z]*_[A-Za-z0-9._-]{8,}/gi;

function redactSecrets(text: string): string {
  return text.replace(BEARER_RE, "Bearer [redacted]").replace(PINTEREST_TOKEN_RE, "[redacted]");
}

// Werte unter sensiblen Schlüsseln werden komplett ersetzt — der sicherste Schutz,
// falls ein Aufrufer versehentlich ein Secret in details steckt.
const SENSITIVE_KEY_RE = /(token|secret|password|passwd|authorization|api[_-]?key|bearer|credential)/i;

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") return sanitizeObject(value as Record<string, unknown>);
  return value;
}

function sanitizeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : sanitizeValue(value);
  }
  return out;
}

/**
 * Schreibt ein Ereignis nach pin_publish_events. Best-Effort: wirft nie. message wird
 * von Tokens befreit und auf MAX_MESSAGE_LENGTH gekürzt, details rekursiv von Secrets befreit.
 */
export async function recordPublishEvent(
  store: PublishEventStore,
  input: PublishEventInput,
  log: (line: string) => void = (line) => console.error(line),
): Promise<void> {
  const row: PublishEventRow = {
    pin_id: input.pinId,
    blog_project_id: input.blogProjectId,
    event_type: input.type,
    attempt: input.attempt ?? null,
    max_attempts: input.maxAttempts ?? null,
    message: input.message == null ? null : redactSecrets(input.message).slice(0, MAX_MESSAGE_LENGTH),
    details: sanitizeObject(input.details ?? {}),
  };

  try {
    await store.insertEvent(row);
  } catch (err) {
    log(
      JSON.stringify({
        event: "recordPublishEvent.error",
        pinId: input.pinId,
        type: input.type,
        error: (err as Error).message,
      }),
    );
  }
}

// Adapter: erfüllt den PublishEventStore-Seam mit dem echten supabase-js-Insert.
// Dünn gehalten; nutzt die Credential pinfinity-supabase (Service-Role) des Aufrufers.
export function supabasePublishEventStore(sb: SupabaseClient): PublishEventStore {
  return {
    async insertEvent(row) {
      const { error } = await sb.from("pin_publish_events").insert(row);
      if (error) throw new Error(`pin_publish_events insert fehlgeschlagen: ${error.message}`);
    },
  };
}
