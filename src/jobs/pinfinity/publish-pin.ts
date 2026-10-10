// Pinfinity-Publish (Ticket #10, Umbrella #5): veröffentlicht einen Bild-Pin auf
// Pinterest. Löst den Bild-Zweig der Edge Function publish-scheduled-pins ab.
// Video (media_type = "video") ist ein eigenes Ticket (#11).
//
// Die Orchestrierung ist rein und gegen zwei schmale Seams testbar (PinStore,
// PinterestClient); die Adapter auf supabase-js und fetch liegen weiter unten
// bzw. in src/integrations/pinterest.ts. Struktur wie src/jobs/pinfinity/cleanup.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { UnrecoverableError } from "bullmq";
import { z } from "zod";
import { registerJobType } from "../registry.js";
import { createSupabaseClient } from "../../integrations/supabase.js";
import {
  createPinterestClient,
  PinterestApiError,
  type PinterestClient,
  type PinterestCreatePinPayload,
} from "../../integrations/pinterest.js";
import type { ContextEnqueue } from "../enqueue.js";
import { enforcePinterestRateLimit, type RateLimitContext } from "./rate-limit.js";

const BUCKET = "pin-images";
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 800;
const ALT_TEXT_MAX = 500;
// Doppel-Post-Schutz: so oft wird das DB-Update nach erfolgreichem Pinterest-POST
// versucht, bevor wir mit UnrecoverableError abbrechen (kein Retry postet doppelt).
const DB_UPDATE_ATTEMPTS = 3;
const DB_UPDATE_DELAY_MS = 200;

export interface PublishablePin {
  id: string;
  status: string;
  scheduled_at: string | null;
  pinterest_pin_id: string | null;
  pinterest_board_id: string | null;
  image_path: string | null;
  title: string | null;
  description: string | null;
  alt_text: string | null;
  alternate_url: string | null;
  /** blog_articles.url */
  article_url: string | null;
  /** blog_projects.pinterest_connection_id */
  connection_id: string | null;
  ai_modified: boolean | null;
  synthetic_performer: boolean | null;
}

export type AccessTokenResult =
  | { ok: true; token: string }
  // retryable: Netz/5xx (Error -> Retry) vs. sonst (UnrecoverableError).
  | { ok: false; retryable: boolean; message: string };

export interface UpdateResult {
  error: string | null;
}

// Schmaler Seam auf Pinfinitys Supabase: High-Level-Operationen statt der fluent
// supabase-js-API, damit die Orchestrierung mit einem trivialen Fake testbar bleibt.
export interface PinStore {
  loadPin(pinId: string): Promise<PublishablePin | null>;
  getAccessToken(connectionId: string): Promise<AccessTokenResult>;
  publicImageUrl(imagePath: string): string;
  /** Atomar: nur solange der Pin noch metadata_created ist. */
  markPublished(
    pinId: string,
    data: { pinterestPinId: string; pinterestPinUrl: string; publishedAt: string },
  ): Promise<UpdateResult>;
  deactivateConnection(connectionId: string): Promise<void>;
  /** Atomar: Pin auf error setzen, nur solange er noch metadata_created ist. */
  markErrorIfPending(pinId: string, errorMessage: string): Promise<void>;
}

// Port von buildAiDisclosures (petra-pinterest/_shared/ai-disclosure.ts). Reine Funktion.
// - synthetic_performer impliziert immer AI_MODIFIED.
// - beides false => undefined, damit das Feld komplett wegfällt (leeres values lehnt
//   Pinterest ab).
export function buildAiDisclosures(
  aiModified: boolean,
  syntheticPerformer: boolean,
): { values: string[] } | undefined {
  const values: string[] = [];
  if (aiModified || syntheticPerformer) values.push("AI_MODIFIED");
  if (syntheticPerformer) values.push("SYNTHETIC_PERFORMER");
  return values.length > 0 ? { values } : undefined;
}

export interface PublishPinOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Rate-Limit pro Pinterest-Connection (Ticket #13). Fehlt es, wird nicht gebremst
   * (z.B. in Unit-Tests). Der Worker setzt es aus Redis und dem laufenden BullMQ-Job.
   */
  rateLimit?: RateLimitContext;
}

export type PublishPinResult = { skipped: string } | { published: true; pinterestPinId: string };

export async function publishPin(
  store: PinStore,
  pinterest: PinterestClient,
  payload: { pinId: string; scheduledAt: string },
  options: PublishPinOptions = {},
): Promise<PublishPinResult> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const pin = await store.loadPin(payload.pinId);

  // Stale-Guard: veralteter oder nicht mehr publish-fähiger Job endet erfolgreich,
  // kein Retry, keine Mail.
  if (!pin) return { skipped: "pin not found" };
  if (pin.status !== "metadata_created") return { skipped: `status is ${pin.status}` };
  if (pin.pinterest_pin_id) return { skipped: "already has pinterest_pin_id" };
  if (pin.scheduled_at !== payload.scheduledAt) return { skipped: "scheduled_at changed" };

  // Pflichtfelder: fehlen sie, hilft kein Retry (Unrecoverable). Meldungen wie heute.
  if (!pin.connection_id) throw new UnrecoverableError("No Pinterest account connected to this project");
  if (!pin.pinterest_board_id) throw new UnrecoverableError("Pin must have a Pinterest board assigned");
  if (!pin.image_path) throw new UnrecoverableError("Pin must have an image");

  const token = await store.getAccessToken(pin.connection_id);
  if (!token.ok) {
    if (token.retryable) throw new Error(token.message);
    throw new UnrecoverableError(token.message);
  }

  const pinPayload: PinterestCreatePinPayload = {
    board_id: pin.pinterest_board_id,
    media_source: { source_type: "image_url", url: store.publicImageUrl(pin.image_path) },
  };
  if (pin.title) pinPayload.title = pin.title.substring(0, TITLE_MAX);
  if (pin.description) pinPayload.description = pin.description.substring(0, DESCRIPTION_MAX);
  if (pin.alt_text) pinPayload.alt_text = pin.alt_text.substring(0, ALT_TEXT_MAX);
  const link = pin.alternate_url ?? pin.article_url;
  if (link) pinPayload.link = link;
  const aiDisclosures = buildAiDisclosures(pin.ai_modified ?? true, pin.synthetic_performer ?? false);
  if (aiDisclosures) pinPayload.ai_disclosures = aiDisclosures;

  // Mindestabstand pro Connection direkt vor dem Pinterest-POST (Ticket #13). Ist die
  // Marke belegt, verschiebt sich der Job selbst (kein Attempt verbraucht) und kehrt
  // hier nicht zurück — createPin läuft erst, wenn die Connection wieder frei ist.
  if (pin.connection_id && options.rateLimit) {
    await enforcePinterestRateLimit(options.rateLimit, pin.connection_id);
  }

  let created: { id: string };
  try {
    created = await pinterest.createPin(token.token, pinPayload);
  } catch (err) {
    if (err instanceof PinterestApiError) {
      // 429 und 5xx sind transient => normaler Error (Retry).
      if (err.status === 429 || err.status >= 500) throw err;
      // 401: Token dauerhaft ungültig => Connection inaktiv und Unrecoverable.
      if (err.status === 401) {
        await store.deactivateConnection(pin.connection_id);
        throw new UnrecoverableError(err.message);
      }
      // Übrige 4xx (400, 403, 404, ...) sind nicht wiederholbar.
      throw new UnrecoverableError(err.message);
    }
    // Netzwerk/Timeout: nicht als PinterestApiError erkannt => Retry.
    throw err;
  }

  // Erfolg: atomares Update. Doppel-Post-Schutz: schlägt das DB-Update fehl, ein paar
  // kurze interne Versuche, dann Unrecoverable (ein Retry würde sonst doppelt posten).
  const pinterestPinUrl = `https://www.pinterest.com/pin/${created.id}/`;
  const publishedAt = now().toISOString();
  for (let attempt = 1; attempt <= DB_UPDATE_ATTEMPTS; attempt++) {
    const result = await store.markPublished(pin.id, {
      pinterestPinId: created.id,
      pinterestPinUrl,
      publishedAt,
    });
    if (!result.error) return { published: true, pinterestPinId: created.id };
    if (attempt < DB_UPDATE_ATTEMPTS) await sleep(DB_UPDATE_DELAY_MS);
  }
  throw new UnrecoverableError(`Pin auf Pinterest angelegt (${created.id}), DB-Update fehlgeschlagen`);
}

const payloadSchema = z.object({
  supabaseCredential: z.string().min(1),
  pinId: z.string().uuid(),
  scheduledAt: z.string().min(1),
  // Für die Fehler-Mail als Folge-Job (#12). Default auf die Betriebs-Credential (#15),
  // damit Pinfinity als Producer es nicht pro Job mitschicken muss.
  resendCredential: z.string().min(1).default("pinfinity-resend"),
});

export type PublishPinPayload = z.infer<typeof payloadSchema>;

// onFinalFailure (Ticket #9/#10): Pin atomar auf error setzen und die Fehler-Mail als
// Folge-Job einreihen. Fehler hier schluckt der Worker (event onFinalFailure.error).
export async function handlePublishPinFinalFailure(
  store: PinStore,
  payload: PublishPinPayload,
  error: Error,
  enqueue: ContextEnqueue,
  jobId: string | undefined,
): Promise<void> {
  await store.markErrorIfPending(payload.pinId, error.message);
  await enqueue(
    "pinfinity.send-publish-error-mail",
    {
      supabaseCredential: payload.supabaseCredential,
      resendCredential: payload.resendCredential,
      pinId: payload.pinId,
      errorMessage: error.message,
    },
    { jobId: `publish-error-mail-${payload.pinId}-${jobId}` },
  );
}

// Adapter: erfüllt den PinStore-Seam mit den echten supabase-js-Calls. Dünn gehalten
// und über das Live-E2E verifiziert, nicht per Unit-Test (wie bei cleanup.ts).
export function supabasePinStore(sb: SupabaseClient, supabaseUrl: string): PinStore {
  return {
    async loadPin(pinId) {
      const { data, error } = await sb
        .from("pins")
        .select(
          "id, status, scheduled_at, pinterest_pin_id, pinterest_board_id, image_path, title, description, alt_text, alternate_url, ai_modified, synthetic_performer, blog_articles(url), blog_projects(pinterest_connection_id)",
        )
        .eq("id", pinId)
        .maybeSingle();
      if (error) throw new Error(`Supabase-Query fehlgeschlagen: ${error.message}`);
      if (!data) return null;
      const row = data as Record<string, unknown>;
      const article = row.blog_articles as { url?: string | null } | null | undefined;
      const project = row.blog_projects as { pinterest_connection_id?: string | null } | null | undefined;
      return {
        id: row.id as string,
        status: row.status as string,
        scheduled_at: (row.scheduled_at as string | null) ?? null,
        pinterest_pin_id: (row.pinterest_pin_id as string | null) ?? null,
        pinterest_board_id: (row.pinterest_board_id as string | null) ?? null,
        image_path: (row.image_path as string | null) ?? null,
        title: (row.title as string | null) ?? null,
        description: (row.description as string | null) ?? null,
        alt_text: (row.alt_text as string | null) ?? null,
        alternate_url: (row.alternate_url as string | null) ?? null,
        article_url: article?.url ?? null,
        connection_id: project?.pinterest_connection_id ?? null,
        ai_modified: (row.ai_modified as boolean | null) ?? null,
        synthetic_performer: (row.synthetic_performer as boolean | null) ?? null,
      };
    },
    async getAccessToken(connectionId) {
      try {
        const { data, error } = await sb.rpc("get_pinterest_access_token", { p_connection_id: connectionId });
        if (error) {
          // Zurückgegebener RPC-Fehler ist in der Regel persistent => Unrecoverable.
          return { ok: false, retryable: false, message: `Failed to retrieve Pinterest access token: ${error.message}` };
        }
        if (!data) {
          return { ok: false, retryable: false, message: "Failed to retrieve Pinterest access token: Unknown error" };
        }
        return { ok: true, token: data as string };
      } catch (err) {
        // Geworfener Fehler = Netz/Timeout => wiederholbar.
        return { ok: false, retryable: true, message: `Failed to retrieve Pinterest access token: ${(err as Error).message}` };
      }
    },
    publicImageUrl(imagePath) {
      return `${supabaseUrl}/storage/v1/object/public/${BUCKET}/${imagePath}`;
    },
    async markPublished(pinId, data) {
      const { error } = await sb
        .from("pins")
        .update({
          status: "published",
          published_at: data.publishedAt,
          pinterest_pin_id: data.pinterestPinId,
          pinterest_pin_url: data.pinterestPinUrl,
        })
        .eq("id", pinId)
        .eq("status", "metadata_created");
      return { error: error ? error.message : null };
    },
    async deactivateConnection(connectionId) {
      await sb.from("pinterest_connections").update({ is_active: false }).eq("id", connectionId);
    },
    async markErrorIfPending(pinId, errorMessage) {
      await sb
        .from("pins")
        .update({ status: "error", error_message: errorMessage })
        .eq("id", pinId)
        .eq("status", "metadata_created");
    },
  };
}

registerJobType({
  name: "pinfinity.publish-pin",
  queue: "integrations",
  payloadSchema,
  attempts: 4,
  backoff: { type: "exponential", delay: 300_000 },
  process: async (payload, ctx) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    const store = supabasePinStore(sb, creds.url as string);
    // defer gibt es nur im Worker-Prozess (nicht in onFinalFailure) => Rate-Limit aktiv.
    const options: PublishPinOptions = ctx.defer ? { rateLimit: { redis: ctx.redis, defer: ctx.defer } } : {};
    return publishPin(store, createPinterestClient(), { pinId: payload.pinId, scheduledAt: payload.scheduledAt }, options);
  },
  onFinalFailure: async (payload, error, ctx, job) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    const store = supabasePinStore(sb, creds.url as string);
    await handlePublishPinFinalFailure(store, payload, error, ctx.enqueue, job.id);
  },
});
