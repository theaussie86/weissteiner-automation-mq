// Pinfinity-Fehler-Mail (Ticket #12, Umbrella #5): verschickt die Fehler-Mail zu einem
// endgültig gescheiterten Pin per Resend. Portiert notifyPinError aus
// supabase/functions/_shared/notifications.ts (theaussie86/petra-pinterest).
// Eingereiht wird der Job nur als Folge-Job von pinfinity.publish-pin (onFinalFailure, #9/#10).
//
// Die Orchestrierung ist rein und gegen zwei schmale Seams testbar (ErrorMailStore,
// Mailer); die Adapter auf supabase-js und fetch liegen weiter unten. Rendering ist eine
// reine Funktion. Struktur wie src/jobs/pinfinity/publish-pin.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import { registerJobType } from "../registry.js";
import { createSupabaseClient } from "../../integrations/supabase.js";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_FROM = "Pinfinity <noreply@onlineheldinnen.de>";
const DEFAULT_APP_URL = "https://pinfinity.onlineheldinnen.de";

// Fehler mit HTTP-Status, damit die Orchestrierung ihn klassifizieren kann
// (429/5xx = Retry, übrige 4xx = Unrecoverable). Form wie PinterestApiError.
export class ResendApiError extends Error {
  readonly status: number;
  constructor(status: number, apiMessage: string) {
    super(`Resend API error: ${apiMessage}`);
    this.name = "ResendApiError";
    this.status = status;
  }
}

export interface ErrorPin {
  id: string;
  title: string | null;
  blog_project_id: string | null;
  status: string;
  error_notified_at: string | null;
  /** blog_articles.title */
  article_title: string | null;
}

export interface ProjectInfo {
  name: string | null;
  notification_email: string | null;
  /** Besitzer/Tenant des Projekts, für die Fallback-Empfängerauflösung. */
  tenant_id: string | null;
}

// Schmaler Seam auf Pinfinitys Supabase: High-Level-Operationen statt der fluent
// supabase-js-API, damit die Orchestrierung mit einem trivialen Fake testbar bleibt.
export interface ErrorMailStore {
  loadPin(pinId: string): Promise<ErrorPin | null>;
  loadProject(projectId: string): Promise<ProjectInfo | null>;
  /** E-Mail des ältesten Profils des Tenants (via auth.admin.getUserById). */
  resolveTenantEmail(tenantId: string): Promise<string | null>;
  /** Setzt pins.error_notified_at als Versand-Throttle. */
  markNotified(pinId: string, at: string): Promise<void>;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

// Schmaler Seam: die Orchestrierung testet gegen diese eine Methode, der echte
// fetch-Adapter liegt darunter.
export interface Mailer {
  send(msg: MailMessage): Promise<void>;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface ErrorMailContent {
  projectName: string | null;
  pinTitle: string | null;
  articleTitle: string | null;
  errorMessage: string;
  appUrl: string;
}

export interface RenderedMail {
  subject: string;
  text: string;
  html: string;
}

// Reine Render-Funktion (unit-getestet): Text + HTML mit echten Umlauten, Fehlermeldung
// im HTML escaped. Betreff wie bisher: "[Pinfinity] Fehler beim Veröffentlichen - <Projekt>".
export function renderErrorMail(c: ErrorMailContent): RenderedMail {
  const project = c.projectName ?? "Unbekanntes Projekt";
  const pinLabel = c.pinTitle ?? c.articleTitle ?? "(ohne Titel)";
  const subject = `[Pinfinity] Fehler beim Veröffentlichen - ${project}`;
  const text = [
    "Hallo,",
    "",
    `beim Veröffentlichen eines Pins im Projekt "${project}" ist ein Fehler aufgetreten.`,
    "",
    `Pin: ${pinLabel}`,
    `Fehler: ${c.errorMessage}`,
    "",
    `Pin in Pinfinity öffnen: ${c.appUrl}`,
    "",
    "Viele Grüße",
    "Pinfinity",
  ].join("\n");
  const html = `<!doctype html>
<html lang="de">
<body>
<p>Hallo,</p>
<p>beim Veröffentlichen eines Pins im Projekt „${escapeHtml(project)}“ ist ein Fehler aufgetreten.</p>
<p><strong>Pin:</strong> ${escapeHtml(pinLabel)}<br>
<strong>Fehler:</strong> ${escapeHtml(c.errorMessage)}</p>
<p><a href="${escapeHtml(c.appUrl)}">Pin in Pinfinity öffnen</a></p>
<p>Viele Grüße<br>Pinfinity</p>
</body>
</html>`;
  return { subject, text, html };
}

export interface SendErrorMailInput {
  pinId: string;
  errorMessage: string;
  from: string;
  appUrl: string;
}

export interface SendErrorMailOptions {
  now?: () => Date;
}

export type SendErrorMailResult = { skipped: string } | { sent: true; recipient: string };

export async function sendPublishErrorMail(
  store: ErrorMailStore,
  mailer: Mailer,
  input: SendErrorMailInput,
  options: SendErrorMailOptions = {},
): Promise<SendErrorMailResult> {
  const now = options.now ?? (() => new Date());

  const pin = await store.loadPin(input.pinId);
  // Skip (Job erfolgreich, kein Retry): Pin weg, nicht mehr im Fehlerzustand
  // (z.B. inzwischen manuell veröffentlicht) oder bereits benachrichtigt.
  if (!pin) return { skipped: "pin not found" };
  if (pin.status !== "error") return { skipped: `status is ${pin.status}` };
  if (pin.error_notified_at) return { skipped: "already notified" };

  const project = pin.blog_project_id ? await store.loadProject(pin.blog_project_id) : null;
  // Empfänger: zuerst die Projekt-Adresse, sonst das älteste Profil des Tenants.
  let recipient = project?.notification_email?.trim() || null;
  if (!recipient && project?.tenant_id) {
    recipient = await store.resolveTenantEmail(project.tenant_id);
  }
  // Kein Empfänger => hilft kein Retry.
  if (!recipient) {
    throw new UnrecoverableError(`No notification recipient for pin ${input.pinId}`);
  }

  const mail = renderErrorMail({
    projectName: project?.name ?? null,
    pinTitle: pin.title,
    articleTitle: pin.article_title,
    errorMessage: input.errorMessage,
    appUrl: input.appUrl,
  });

  try {
    await mailer.send({ from: input.from, to: recipient, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (err) {
    if (err instanceof ResendApiError) {
      // 429 und 5xx sind transient => normaler Error (Retry).
      if (err.status === 429 || err.status >= 500) throw err;
      // Übrige 4xx (400, 401, 403, 422, ...) sind nicht wiederholbar.
      throw new UnrecoverableError(err.message);
    }
    // Netzwerk/Timeout: nicht als ResendApiError erkannt => Retry.
    throw err;
  }

  // Throttle setzen. Der Trigger reset_error_notified_at setzt es zurück, sobald der Pin
  // error verlässt (siehe Ticket).
  await store.markNotified(pin.id, now().toISOString());
  return { sent: true, recipient };
}

// Adapter: erfüllt den Mailer-Seam mit dem echten Resend-Call. Wirft ResendApiError mit
// Status; Netzwerk-/Timeout-Fehler propagiert fetch als eigenen Error.
export function createResendMailer(apiKey: string, fetchImpl: typeof fetch = fetch): Mailer {
  return {
    async send(msg) {
      const response = await fetchImpl(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: msg.from, to: msg.to, subject: msg.subject, text: msg.text, html: msg.html }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        let apiMessage = `${response.status} ${response.statusText}`;
        try {
          const json = JSON.parse(text);
          if (json?.message) apiMessage = json.message as string;
        } catch {
          // Kein JSON-Body: Status/Statustext als Meldung behalten.
        }
        throw new ResendApiError(response.status, apiMessage);
      }
    },
  };
}

// Adapter: erfüllt den ErrorMailStore-Seam mit den echten supabase-js-Calls. Dünn gehalten
// und über das Live-E2E verifiziert, nicht per Unit-Test (wie bei publish-pin.ts). Die
// Projekt-/Profil-Spaltennamen folgen Pinfinitys Schema und werden beim Cutover (#15) geprüft.
export function supabaseErrorMailStore(sb: SupabaseClient): ErrorMailStore {
  return {
    async loadPin(pinId) {
      const { data, error } = await sb
        .from("pins")
        .select("id, title, blog_project_id, status, error_notified_at, blog_articles(title)")
        .eq("id", pinId)
        .maybeSingle();
      if (error) throw new Error(`Supabase-Query fehlgeschlagen: ${error.message}`);
      if (!data) return null;
      const row = data as Record<string, unknown>;
      const article = row.blog_articles as { title?: string | null } | null | undefined;
      return {
        id: row.id as string,
        title: (row.title as string | null) ?? null,
        blog_project_id: (row.blog_project_id as string | null) ?? null,
        status: row.status as string,
        error_notified_at: (row.error_notified_at as string | null) ?? null,
        article_title: article?.title ?? null,
      };
    },
    async loadProject(projectId) {
      const { data, error } = await sb
        .from("blog_projects")
        .select("name, notification_email, tenant_id")
        .eq("id", projectId)
        .maybeSingle();
      if (error) throw new Error(`Supabase-Query fehlgeschlagen: ${error.message}`);
      if (!data) return null;
      const row = data as Record<string, unknown>;
      return {
        name: (row.name as string | null) ?? null,
        notification_email: (row.notification_email as string | null) ?? null,
        tenant_id: (row.tenant_id as string | null) ?? null,
      };
    },
    async resolveTenantEmail(tenantId) {
      const { data, error } = await sb
        .from("profiles")
        .select("id")
        .eq("tenant_id", tenantId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error || !data) return null;
      const userId = (data as { id: string }).id;
      const { data: userData, error: userError } = await sb.auth.admin.getUserById(userId);
      if (userError || !userData?.user?.email) return null;
      return userData.user.email;
    },
    async markNotified(pinId, at) {
      await sb.from("pins").update({ error_notified_at: at }).eq("id", pinId);
    },
  };
}

// Form der pinfinity-resend-Credential (Provider apikey) mit Defaults.
const resendCredentialSchema = z.object({
  apiKey: z.string().min(1),
  from: z.string().min(1).default(DEFAULT_FROM),
  appUrl: z.string().url().default(DEFAULT_APP_URL),
});

const payloadSchema = z.object({
  supabaseCredential: z.string().min(1),
  resendCredential: z.string().min(1).default("pinfinity-resend"),
  pinId: z.string().uuid(),
  errorMessage: z.string(),
});

export type SendPublishErrorMailPayload = z.infer<typeof payloadSchema>;

registerJobType({
  name: "pinfinity.send-publish-error-mail",
  queue: "integrations",
  payloadSchema,
  // Retry-Defaults laut Ticket: 1 Versuch + 4 Wiederholungen, exponentiell ab 1 min.
  attempts: 5,
  backoff: { type: "exponential", delay: 60_000 },
  process: async (payload, ctx) => {
    const sbCreds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(sbCreds);
    const resend = resendCredentialSchema.parse(await ctx.getCredential(payload.resendCredential));
    const store = supabaseErrorMailStore(sb);
    const mailer = createResendMailer(resend.apiKey);
    return sendPublishErrorMail(store, mailer, {
      pinId: payload.pinId,
      errorMessage: payload.errorMessage,
      from: resend.from,
      appUrl: resend.appUrl,
    });
  },
});
