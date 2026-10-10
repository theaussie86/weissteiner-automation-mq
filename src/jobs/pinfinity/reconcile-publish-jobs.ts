// Pinfinity-Reconcile (Ticket #14, Umbrella #5): Sicherheitsnetz und Backlog-Abbau.
// Reiht fehlende pinfinity.publish-pin-Jobs für fällige/geplante Pins nach, falls
// Pinfinity beim Speichern nicht einreihen konnte (MQ kurz weg), Redis Jobs verloren
// hat oder der Bestand zum Cutover eingereiht werden muss.
//
// Die Orchestrierung ist rein und gegen zwei Seams testbar (ReconcileClient für die
// Auswahl, ContextEnqueue fürs Einreihen); der supabase-js-Adapter liegt weiter unten.
// Struktur wie src/jobs/pinfinity/cleanup.ts.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { registerJobType } from "../registry.js";
import { createSupabaseClient } from "../../integrations/supabase.js";
import type { ContextEnqueue } from "../enqueue.js";

const DAY_MS = 24 * 3600 * 1000;
const DEFAULT_HORIZON_DAYS = 14;

export interface ReconcilablePin {
  id: string;
  /** Nicht leer (SQL filtert scheduled_at IS NOT NULL). */
  scheduled_at: string;
}

// Schmaler Seam auf Pinfinitys Supabase: eine High-Level-Operation statt der fluent
// supabase-js-API, damit die Orchestrierung mit einem trivialen Fake testbar bleibt.
export interface ReconcileClient {
  /**
   * Publish-Kandidaten im Horizont: status = metadata_created, scheduled_at gesetzt,
   * pinterest_pin_id leer, scheduled_at <= now + horizonDays.
   */
  listReconcilablePins(horizonDays: number): Promise<ReconcilablePin[]>;
}

export interface ReconcileResult {
  total: number;
  enqueued: number;
  alreadyQueued: number;
  dryRun: boolean;
}

export interface ReconcileOptions {
  supabaseCredential: string;
  horizonDays: number;
  dryRun: boolean;
  now?: () => Date;
}

export async function reconcilePublishJobs(
  client: ReconcileClient,
  enqueue: ContextEnqueue,
  opts: ReconcileOptions,
): Promise<ReconcileResult> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const horizonMs = nowMs + opts.horizonDays * DAY_MS;

  // Horizont-Filter auch hier (nicht nur in SQL): macht Auswahl und Delay gegen ein
  // festes now deterministisch testbar und ist robust, falls der Client mehr liefert.
  const candidates = await client.listReconcilablePins(opts.horizonDays);
  const due = candidates.filter((pin) => Date.parse(pin.scheduled_at) <= horizonMs);
  const total = due.length;

  if (opts.dryRun) return { total, enqueued: 0, alreadyQueued: 0, dryRun: true };

  let enqueued = 0;
  let alreadyQueued = 0;
  for (const pin of due) {
    // delay = max(0, scheduled_at - now): fällige Pins sofort, künftige verzögert.
    const delay = Math.max(0, Date.parse(pin.scheduled_at) - nowMs);
    // onExisting: skip => idempotent, bestehende Jobs bleiben unberührt.
    const result = await enqueue(
      "pinfinity.publish-pin",
      {
        supabaseCredential: opts.supabaseCredential,
        pinId: pin.id,
        scheduledAt: pin.scheduled_at,
      },
      { jobId: `publish-pin-${pin.id}`, delay, onExisting: "skip" },
    );
    if (result.outcome === "enqueued") enqueued++;
    else alreadyQueued++;
  }
  return { total, enqueued, alreadyQueued, dryRun: false };
}

// Adapter: erfüllt den ReconcileClient-Seam mit den echten supabase-js-Calls.
// Dünn gehalten und über das Live-E2E verifiziert, nicht per Unit-Test (wie cleanup.ts).
export function supabaseReconcileClient(sb: SupabaseClient): ReconcileClient {
  return {
    async listReconcilablePins(horizonDays) {
      const cutoff = new Date(Date.now() + horizonDays * DAY_MS).toISOString();
      const { data, error } = await sb
        .from("pins")
        .select("id, scheduled_at")
        .eq("status", "metadata_created")
        .not("scheduled_at", "is", null)
        .is("pinterest_pin_id", null)
        .lte("scheduled_at", cutoff)
        .order("scheduled_at", { ascending: true });
      if (error) throw new Error(`Supabase-Query fehlgeschlagen: ${error.message}`);
      return (data ?? []) as ReconcilablePin[];
    },
  };
}

const payloadSchema = z.object({
  supabaseCredential: z.string().min(1),
  horizonDays: z.number().int().positive().default(DEFAULT_HORIZON_DAYS),
  dryRun: z.boolean().default(false),
});

registerJobType({
  name: "pinfinity.reconcile-publish-jobs",
  queue: "integrations",
  payloadSchema,
  process: async (payload, ctx) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    return reconcilePublishJobs(supabaseReconcileClient(sb), ctx.enqueue, {
      supabaseCredential: payload.supabaseCredential,
      horizonDays: payload.horizonDays,
      dryRun: payload.dryRun,
    });
  },
});
