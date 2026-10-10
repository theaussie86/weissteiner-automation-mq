// Cleanup-Job pinfinity.cleanup-publish-events (Teil 2 der Pinfinity-Migration,
// Ticket #21): löscht Einträge aus Pinfinitys Tabelle pin_publish_events, die älter
// als retentionDays (Default 90) sind. Gelöscht wird in Batches, bis nichts mehr
// übrig ist, damit ein großer Rückstand eine einzelne Query nicht sprengt.
//
// Struktur wie cleanup.ts: reine Orchestrierung gegen den PublishEventsCleanupClient-
// Seam plus dünner supabase-js-Adapter weiter unten. Fehler werfen und führen so zum
// Retry über die Standard-Policy des Workers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { registerJobType } from "../registry.js";
import { createSupabaseClient } from "../../integrations/supabase.js";

export const DEFAULT_RETENTION_DAYS = 90;
export const BATCH_SIZE = 1000;

// Schmaler Seam auf Pinfinitys Supabase: zwei High-Level-Operationen statt der
// fluent supabase-js-API, damit die Orchestrierung mit einem trivialen Fake testbar bleibt.
export interface PublishEventsCleanupClient {
  /** Zählt Zeilen mit created_at < cutoff (für dryRun). */
  countOlderThan(cutoff: string): Promise<number>;
  /** Löscht bis zu limit Zeilen mit created_at < cutoff und liefert die Anzahl gelöschter Zeilen. */
  deleteBatchOlderThan(cutoff: string, limit: number): Promise<number>;
}

export interface CleanupPublishEventsResult {
  deleted: number;
  dryRun: boolean;
}

export async function cleanupPublishEvents(
  client: PublishEventsCleanupClient,
  opts: { retentionDays: number; dryRun: boolean; now?: () => number },
): Promise<CleanupPublishEventsResult> {
  const now = opts.now?.() ?? Date.now();
  const cutoff = new Date(now - opts.retentionDays * 24 * 3600 * 1000).toISOString();

  if (opts.dryRun) {
    const deleted = await client.countOlderThan(cutoff);
    return { deleted, dryRun: true };
  }

  let deleted = 0;
  for (;;) {
    const n = await client.deleteBatchOlderThan(cutoff, BATCH_SIZE);
    deleted += n;
    // Weniger als ein voller Batch heißt: der Bestand ist abgearbeitet.
    if (n < BATCH_SIZE) break;
  }
  return { deleted, dryRun: false };
}

// Adapter: erfüllt den PublishEventsCleanupClient-Seam mit echten supabase-js-Calls.
// supabase-js kann kein LIMIT auf DELETE, daher pro Batch erst eine Seite von Ids
// selektieren und dann per in(...) löschen. Dünn gehalten und über das Live-E2E
// verifiziert, nicht per Unit-Test.
export function supabasePublishEventsCleanupClient(sb: SupabaseClient): PublishEventsCleanupClient {
  const TABLE = "pin_publish_events";
  return {
    async countOlderThan(cutoff) {
      const { count, error } = await sb
        .from(TABLE)
        .select("*", { count: "exact", head: true })
        .lt("created_at", cutoff);
      if (error) throw new Error(`${TABLE} count fehlgeschlagen: ${error.message}`);
      return count ?? 0;
    },
    async deleteBatchOlderThan(cutoff, limit) {
      const { data: rows, error: selErr } = await sb
        .from(TABLE)
        .select("id")
        .lt("created_at", cutoff)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (selErr) throw new Error(`${TABLE} select fehlgeschlagen: ${selErr.message}`);
      const ids = (rows ?? []).map((r) => (r as { id: string }).id);
      if (ids.length === 0) return 0;
      const { error: delErr } = await sb.from(TABLE).delete().in("id", ids);
      if (delErr) throw new Error(`${TABLE} delete fehlgeschlagen: ${delErr.message}`);
      return ids.length;
    },
  };
}

const payloadSchema = z.object({
  supabaseCredential: z.string().min(1),
  retentionDays: z.number().int().positive().default(DEFAULT_RETENTION_DAYS),
  dryRun: z.boolean().default(false),
});

registerJobType({
  name: "pinfinity.cleanup-publish-events",
  queue: "integrations",
  payloadSchema,
  process: async (payload, ctx) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    return cleanupPublishEvents(supabasePublishEventsCleanupClient(sb), {
      retentionDays: payload.retentionDays,
      dryRun: payload.dryRun,
    });
  },
});
