// Pinfinity-Publish (Ticket #10/#11, Umbrella #5): veröffentlicht einen Bild- oder
// Video-Pin auf Pinterest. Löst beide Zweige der Edge Function publish-scheduled-pins
// ab. Bild (media_type = "image"): einstufiger createPin. Video (media_type = "video"):
// Media registrieren, nach S3 hochladen, Verarbeitung pollen, Video-Pin anlegen.
//
// Die Orchestrierung ist rein und gegen schmale Seams testbar (PinStore,
// PinterestClient, downloadVideo); die Adapter auf supabase-js und fetch liegen weiter
// unten bzw. in src/integrations/pinterest.ts. Struktur wie src/jobs/pinfinity/cleanup.ts.

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
import { downloadToTempFile, type DownloadedFile } from "../../media/download.js";
import type { ContextEnqueue } from "../enqueue.js";
import { enforcePinterestRateLimit, type RateLimitContext } from "./rate-limit.js";
import { recordPublishEvent, supabasePublishEventStore, type PublishEventStore } from "./publish-events.js";
import type { FailableJob } from "../../worker/failure.js";

const IMAGE_BUCKET = "pin-images";
const VIDEO_BUCKET = "pin-videos";
const TITLE_MAX = 100;
const DESCRIPTION_MAX = 800;
const ALT_TEXT_MAX = 500;
// Doppel-Post-Schutz: so oft wird das DB-Update nach erfolgreichem Pinterest-POST
// versucht, bevor wir mit UnrecoverableError abbrechen (kein Retry postet doppelt).
const DB_UPDATE_ATTEMPTS = 3;
const DB_UPDATE_DELAY_MS = 200;
// Video-Verarbeitung pollen: Intervall und Gesamt-Timeout. BullMQ erneuert den Job-Lock
// automatisch, solange der Processor läuft, der Job gilt also nicht als stalled.
const VIDEO_POLL_INTERVAL_MS = 5_000;
const VIDEO_POLL_TIMEOUT_MS = 5 * 60_000;
// cover_keyframe_seconds (DB, Sekunden) -> Pinterest cover_image_key_frame_time (Millisekunden).
const DEFAULT_COVER_KEYFRAME_SECONDS = 1;
const MS_PER_SECOND = 1_000;

export interface PublishablePin {
  id: string;
  /** Projekt des Pins, für die Zuordnung der Veröffentlichungs-Ereignisse (#19). */
  blog_project_id: string | null;
  status: string;
  scheduled_at: string | null;
  pinterest_pin_id: string | null;
  pinterest_board_id: string | null;
  /** "image" (Default) oder "video". */
  media_type: string | null;
  image_path: string | null;
  /** Nur bei media_type = "video". */
  video_path: string | null;
  /** Optionales Standbild als Video-Cover (im Bild-Bucket). */
  cover_image_path: string | null;
  /** Fallback-Cover: Zeitpunkt im Video in Sekunden, wenn kein cover_image_path. */
  cover_keyframe_seconds: number | null;
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
  publicVideoUrl(videoPath: string): string;
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

// Führt einen Pinterest-Call aus und klassifiziert Fehler einheitlich (Ticket #10/#11):
// 429 und 5xx sind transient (normaler Error => Retry). 401 bedeutet dauerhaft
// ungültiges Token => Connection inaktiv und Unrecoverable. Übrige 4xx (400, 403, 404)
// sind nicht wiederholbar. Netzwerk/Timeout propagiert als eigener Error (=> Retry).
async function callPinterest<T>(
  store: PinStore,
  connectionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PinterestApiError) {
      if (err.status === 429 || err.status >= 500) throw err;
      if (err.status === 401) {
        await store.deactivateConnection(connectionId);
        throw new UnrecoverableError(err.message);
      }
      throw new UnrecoverableError(err.message);
    }
    throw err;
  }
}

// Titel/Beschreibung/Alt-Text (trunkiert), Link und AI-Kennzeichnung — identisch für
// Bild- und Video-Pins.
function applyCommonPinFields(payload: PinterestCreatePinPayload, pin: PublishablePin): void {
  if (pin.title) payload.title = pin.title.substring(0, TITLE_MAX);
  if (pin.description) payload.description = pin.description.substring(0, DESCRIPTION_MAX);
  if (pin.alt_text) payload.alt_text = pin.alt_text.substring(0, ALT_TEXT_MAX);
  const link = pin.alternate_url ?? pin.article_url;
  if (link) payload.link = link;
  const aiDisclosures = buildAiDisclosures(pin.ai_modified ?? true, pin.synthetic_performer ?? false);
  if (aiDisclosures) payload.ai_disclosures = aiDisclosures;
}

async function publishImagePin(
  store: PinStore,
  pinterest: PinterestClient,
  pin: PublishablePin,
  token: string,
  connectionId: string,
): Promise<{ id: string }> {
  const payload: PinterestCreatePinPayload = {
    board_id: pin.pinterest_board_id as string,
    media_source: { source_type: "image_url", url: store.publicImageUrl(pin.image_path as string) },
  };
  applyCommonPinFields(payload, pin);
  return callPinterest(store, connectionId, () => pinterest.createPin(token, payload));
}

// Mehrstufiger Video-Ablauf (Ticket #11): 1. Media registrieren (einmalige media_id),
// 2. Video in eine Temp-Datei streamen, 3. nach S3 hochladen, 4. Verarbeitung pollen,
// 5. Video-Pin anlegen. Die Temp-Datei wird auch im Fehlerfall gelöscht.
async function publishVideoPin(
  store: PinStore,
  pinterest: PinterestClient,
  pin: PublishablePin,
  token: string,
  connectionId: string,
  options: PublishPinOptions,
): Promise<{ id: string }> {
  // 1. Registrierung — jeder Versuch registriert neu (media_id ist einmalig verwendbar).
  const registration = await callPinterest(store, connectionId, () => pinterest.registerVideoMedia(token));

  // 2. Video laden und 3. hochladen. Temp-Datei im finally aufräumen (auch bei Fehler).
  const videoUrl = store.publicVideoUrl(pin.video_path as string);
  const download = await (options.downloadVideo ?? downloadToTempFile)(videoUrl);
  try {
    await callPinterest(store, connectionId, () => pinterest.uploadVideoToS3(registration, download.path));
  } finally {
    await download.cleanup();
  }

  // 4. Polling bis succeeded. failed => Unrecoverable, Timeout => Retry.
  await pollMediaStatus(store, pinterest, token, connectionId, registration.mediaId, options);

  // 5. Video-Pin anlegen. Cover aus cover_image_path, sonst Keyframe-Zeit (Default 1 s).
  const mediaSource: Extract<PinterestCreatePinPayload["media_source"], { source_type: "video_id" }> = {
    source_type: "video_id",
    media_id: registration.mediaId,
  };
  if (pin.cover_image_path) {
    mediaSource.cover_image_url = store.publicImageUrl(pin.cover_image_path);
  } else {
    const seconds = pin.cover_keyframe_seconds ?? DEFAULT_COVER_KEYFRAME_SECONDS;
    mediaSource.cover_image_key_frame_time = seconds * MS_PER_SECOND;
  }
  const payload: PinterestCreatePinPayload = { board_id: pin.pinterest_board_id as string, media_source: mediaSource };
  applyCommonPinFields(payload, pin);
  return callPinterest(store, connectionId, () => pinterest.createPin(token, payload));
}

async function pollMediaStatus(
  store: PinStore,
  pinterest: PinterestClient,
  token: string,
  connectionId: string,
  mediaId: string,
  options: PublishPinOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = options.videoPollIntervalMs ?? VIDEO_POLL_INTERVAL_MS;
  const timeoutMs = options.videoPollTimeoutMs ?? VIDEO_POLL_TIMEOUT_MS;
  const deadline = now().getTime() + timeoutMs;

  for (;;) {
    const status = await callPinterest(store, connectionId, () => pinterest.getMediaStatus(token, mediaId));
    if (status === "succeeded") return;
    // failed ist endgültig: ein Retry würde dasselbe Video wieder hochladen.
    if (status === "failed") throw new UnrecoverableError("Pinterest media processing failed");
    // Timeout ist wiederholbar (normaler Error): ein Retry gibt mehr Verarbeitungszeit.
    if (now().getTime() + intervalMs > deadline) {
      throw new Error(`Pinterest media processing timed out after ${timeoutMs} ms (status: ${status})`);
    }
    await sleep(intervalMs);
  }
}

export interface PublishPinOptions {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Rate-Limit pro Pinterest-Connection (Ticket #13). Fehlt es, wird nicht gebremst
   * (z.B. in Unit-Tests). Der Worker setzt es aus Redis und dem laufenden BullMQ-Job.
   */
  rateLimit?: RateLimitContext;
  /**
   * Lädt das Video aus der Storage-URL in eine Temp-Datei (Seam, ADR-0004). Default ist
   * downloadToTempFile (streamt, nicht komplett im RAM). In Unit-Tests gefaked.
   */
  downloadVideo?: (url: string) => Promise<DownloadedFile>;
  /** Polling-Overrides für Video-Verarbeitung (Tests). */
  videoPollIntervalMs?: number;
  videoPollTimeoutMs?: number;
  /**
   * Schreibt Veröffentlichungs-Ereignisse nach pin_publish_events (Ticket #19). Fehlt es
   * (z.B. in reinen Logik-Tests), werden keine Ereignisse geschrieben. Der Worker setzt es
   * mit dem supabase-js-Adapter und dem Versuchszähler des laufenden Jobs.
   */
  events?: PublishEventContext;
}

export interface PublishEventContext {
  store: PublishEventStore;
  /** Laufender Versuch (1-basiert) = job.attemptsMade + 1. */
  attempt: number;
  /** job.opts.attempts. */
  maxAttempts: number;
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
  const isVideo = (pin.media_type ?? "image") === "video";
  if (isVideo) {
    if (!pin.video_path) throw new UnrecoverableError("Pin must have a video");
  } else {
    if (!pin.image_path) throw new UnrecoverableError("Pin must have an image");
  }

  const token = await store.getAccessToken(pin.connection_id);
  if (!token.ok) {
    if (token.retryable) throw new Error(token.message);
    throw new UnrecoverableError(token.message);
  }

  // Mindestabstand pro Connection direkt vor den Pinterest-Calls (Ticket #13). Ist die
  // Marke belegt, verschiebt sich der Job selbst (kein Attempt verbraucht) und kehrt
  // hier nicht zurück — die Veröffentlichung läuft erst, wenn die Connection frei ist.
  if (options.rateLimit) {
    await enforcePinterestRateLimit(options.rateLimit, pin.connection_id);
  }

  // Der Versuch fängt jetzt tatsächlich an: nach Stale-Guard und Rate-Limit-Wartezeit.
  // Ein per DelayedError verschobener Lauf kommt hier nicht an (kein Doppeleintrag).
  if (options.events) {
    await recordPublishEvent(options.events.store, {
      pinId: pin.id,
      blogProjectId: pin.blog_project_id ?? "",
      type: "attempt_started",
      attempt: options.events.attempt,
      maxAttempts: options.events.maxAttempts,
    });
  }

  const created = isVideo
    ? await publishVideoPin(store, pinterest, pin, token.token, pin.connection_id, options)
    : await publishImagePin(store, pinterest, pin, token.token, pin.connection_id);

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
    if (!result.error) {
      if (options.events) {
        await recordPublishEvent(options.events.store, {
          pinId: pin.id,
          blogProjectId: pin.blog_project_id ?? "",
          type: "succeeded",
          attempt: options.events.attempt,
          maxAttempts: options.events.maxAttempts,
          details: { pinterest_pin_id: created.id },
        });
      }
      return { published: true, pinterestPinId: created.id };
    }
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

// HTTP-Status eines Pinterest-Fehlers, falls bekannt — sonst undefined (z.B. Netz/Timeout).
function httpStatusOf(error: Error): number | undefined {
  return error instanceof PinterestApiError ? error.status : undefined;
}

// Projekt-Zuordnung für ein Ereignis: beste Mühe. loadPin kann scheitern (DB) — das darf
// weder Mailversand noch Retry blockieren, daher Fehler verschlucken und "" zurückgeben.
async function loadBlogProjectId(store: PinStore, pinId: string): Promise<string> {
  try {
    const pin = await store.loadPin(pinId);
    return pin?.blog_project_id ?? "";
  } catch {
    return "";
  }
}

/**
 * Nächster Retry-Zeitpunkt aus der BullMQ-Backoff-Konfiguration und den bisher gemachten
 * Versuchen. Exponentiell: delay * 2^(attemptsMade - 1) (delay 5 min => +5, +10, +20 min),
 * fixed: immer delay. Ohne Backoff/Delay null.
 */
export function computeNextRetryAt(
  backoff: number | { type?: string; delay?: number } | undefined,
  attemptsMade: number,
  now: Date,
): string | null {
  const cfg = typeof backoff === "number" ? { type: "fixed", delay: backoff } : backoff;
  if (!cfg?.delay) return null;
  const factor = cfg.type === "exponential" ? Math.pow(2, Math.max(0, attemptsMade - 1)) : 1;
  return new Date(now.getTime() + cfg.delay * factor).toISOString();
}

// onRetryScheduled (Ticket #19): ein Versuch scheiterte mit wiederholbarem Fehler, ein
// Retry folgt noch. Schreibt retry_scheduled. attemptsMade ist der gerade gescheiterte
// Versuch. Nur ein Ereignis, keine Seiteneffekte — der Retry ist bereits eingeplant.
export async function handlePublishPinRetryScheduled(
  store: PinStore,
  eventStore: PublishEventStore,
  payload: PublishPinPayload,
  error: Error,
  job: FailableJob,
  now: () => Date = () => new Date(),
): Promise<void> {
  const blogProjectId = await loadBlogProjectId(store, payload.pinId);
  const httpStatus = httpStatusOf(error);
  const nextRetryAt = computeNextRetryAt(job.opts.backoff, job.attemptsMade, now());
  await recordPublishEvent(eventStore, {
    pinId: payload.pinId,
    blogProjectId,
    type: "retry_scheduled",
    attempt: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    message: error.message,
    details: {
      error_class: "retryable",
      ...(httpStatus != null ? { http_status: httpStatus } : {}),
      ...(nextRetryAt ? { next_retry_at: nextRetryAt } : {}),
    },
  });
}

// onFinalFailure (Ticket #9/#10, Ereignis #19): Pin atomar auf error setzen, failed_final
// schreiben und die Fehler-Mail als Folge-Job einreihen. Fehler hier schluckt der Worker
// (event onFinalFailure.error). error_class unterscheidet erschöpfte Retries (retryable)
// von einem nicht wiederholbaren Fehler (unrecoverable).
export async function handlePublishPinFinalFailure(
  store: PinStore,
  eventStore: PublishEventStore,
  payload: PublishPinPayload,
  error: Error,
  enqueue: ContextEnqueue,
  job: FailableJob,
): Promise<void> {
  const blogProjectId = await loadBlogProjectId(store, payload.pinId);
  await store.markErrorIfPending(payload.pinId, error.message);
  const httpStatus = httpStatusOf(error);
  await recordPublishEvent(eventStore, {
    pinId: payload.pinId,
    blogProjectId,
    type: "failed_final",
    attempt: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 1,
    message: error.message,
    details: {
      error_class: error instanceof UnrecoverableError ? "unrecoverable" : "retryable",
      ...(httpStatus != null ? { http_status: httpStatus } : {}),
    },
  });
  await enqueue(
    "pinfinity.send-publish-error-mail",
    {
      supabaseCredential: payload.supabaseCredential,
      resendCredential: payload.resendCredential,
      pinId: payload.pinId,
      errorMessage: error.message,
    },
    { jobId: `publish-error-mail-${payload.pinId}-${job.id}` },
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
          "id, blog_project_id, status, scheduled_at, pinterest_pin_id, pinterest_board_id, media_type, image_path, video_path, cover_image_path, cover_keyframe_seconds, title, description, alt_text, alternate_url, ai_modified, synthetic_performer, blog_articles(url), blog_projects(pinterest_connection_id)",
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
        blog_project_id: (row.blog_project_id as string | null) ?? null,
        status: row.status as string,
        scheduled_at: (row.scheduled_at as string | null) ?? null,
        pinterest_pin_id: (row.pinterest_pin_id as string | null) ?? null,
        pinterest_board_id: (row.pinterest_board_id as string | null) ?? null,
        media_type: (row.media_type as string | null) ?? null,
        image_path: (row.image_path as string | null) ?? null,
        video_path: (row.video_path as string | null) ?? null,
        cover_image_path: (row.cover_image_path as string | null) ?? null,
        cover_keyframe_seconds: (row.cover_keyframe_seconds as number | null) ?? null,
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
      return `${supabaseUrl}/storage/v1/object/public/${IMAGE_BUCKET}/${imagePath}`;
    },
    publicVideoUrl(videoPath) {
      return `${supabaseUrl}/storage/v1/object/public/${VIDEO_BUCKET}/${videoPath}`;
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
    const options: PublishPinOptions = {};
    // defer gibt es nur im Worker-Prozess (nicht in onFinalFailure) => Rate-Limit aktiv.
    if (ctx.defer) options.rateLimit = { redis: ctx.redis, defer: ctx.defer };
    // Versuchszähler ebenfalls nur im Worker-Prozess gesetzt => Ereignisse schreiben.
    if (ctx.attempt) {
      options.events = { store: supabasePublishEventStore(sb), attempt: ctx.attempt, maxAttempts: ctx.maxAttempts ?? 1 };
    }
    return publishPin(store, createPinterestClient(), { pinId: payload.pinId, scheduledAt: payload.scheduledAt }, options);
  },
  onRetryScheduled: async (payload, error, ctx, job) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    const store = supabasePinStore(sb, creds.url as string);
    await handlePublishPinRetryScheduled(store, supabasePublishEventStore(sb), payload, error, job);
  },
  onFinalFailure: async (payload, error, ctx, job) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    const store = supabasePinStore(sb, creds.url as string);
    await handlePublishPinFinalFailure(store, supabasePublishEventStore(sb), payload, error, ctx.enqueue, job);
  },
});
