// Pinfinity-Cleanup (Tracer der Pinfinity-Migration): löst die Edge Function
// cleanup-published-images ab. Löscht Bild-Dateien längst veröffentlichter Pins
// aus Pinfinitys Supabase Storage und nullt deren image_path.
// Die Orchestrierung hier ist rein und gegen den CleanupClient-Seam testbar;
// der Adapter auf das echte supabase-js folgt in derselben Datei (Task 3).

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { registerJobType } from "../registry.js";
import { createSupabaseClient } from "../../integrations/supabase.js";

const OLDER_THAN_DAYS = 7;
const LIMIT = 100;
const BUCKET = "pin-images";

export interface CleanablePin {
  id: string;
  image_path: string;
}

// Schmaler Seam auf Pinfinitys Supabase: drei High-Level-Operationen statt der
// fluent supabase-js-API, damit die Orchestrierung mit einem trivialen Fake testbar bleibt.
export interface CleanupClient {
  listCleanablePins(olderThanDays: number, limit: number): Promise<CleanablePin[]>;
  removeImages(bucket: string, paths: string[]): Promise<{ error: string | null }>;
  nullImagePaths(ids: string[]): Promise<{ error: string | null }>;
}

export interface CleanupResult {
  total: number;
  cleaned: number;
  failed: number;
  dryRun: boolean;
}

export async function cleanupPublishedImages(
  client: CleanupClient,
  opts: { dryRun: boolean },
): Promise<CleanupResult> {
  const pins = await client.listCleanablePins(OLDER_THAN_DAYS, LIMIT);
  const total = pins.length;
  if (total === 0) return { total: 0, cleaned: 0, failed: 0, dryRun: opts.dryRun };
  if (opts.dryRun) return { total, cleaned: 0, failed: 0, dryRun: true };

  const removed = await client.removeImages(
    BUCKET,
    pins.map((p) => p.image_path),
  );
  if (removed.error) return { total, cleaned: 0, failed: total, dryRun: false };

  const updated = await client.nullImagePaths(pins.map((p) => p.id));
  if (updated.error) return { total, cleaned: 0, failed: total, dryRun: false };

  return { total, cleaned: total, failed: 0, dryRun: false };
}

// Adapter: erfüllt den CleanupClient-Seam mit den echten supabase-js-Calls.
// Dünn gehalten und über das Live-E2E (Task 4) verifiziert, nicht per Unit-Test.
export function supabaseCleanupClient(sb: SupabaseClient): CleanupClient {
  return {
    async listCleanablePins(olderThanDays, limit) {
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 3600 * 1000).toISOString();
      const { data, error } = await sb
        .from("pins")
        .select("id, image_path")
        .not("pinterest_pin_id", "is", null)
        .not("image_path", "is", null)
        .lt("published_at", cutoff)
        .limit(limit);
      if (error) throw new Error(`Supabase-Query fehlgeschlagen: ${error.message}`);
      return (data ?? []) as CleanablePin[];
    },
    async removeImages(bucket, paths) {
      const { error } = await sb.storage.from(bucket).remove(paths);
      return { error: error ? error.message : null };
    },
    async nullImagePaths(ids) {
      const { error } = await sb.from("pins").update({ image_path: null }).in("id", ids);
      return { error: error ? error.message : null };
    },
  };
}

const payloadSchema = z.object({
  supabaseCredential: z.string().min(1),
  dryRun: z.boolean().default(false),
});

registerJobType({
  name: "pinfinity.cleanup-published-images",
  queue: "integrations",
  payloadSchema,
  process: async (payload, ctx) => {
    const creds = await ctx.getCredential(payload.supabaseCredential);
    const sb = createSupabaseClient(creds);
    return cleanupPublishedImages(supabaseCleanupClient(sb), { dryRun: payload.dryRun });
  },
});
