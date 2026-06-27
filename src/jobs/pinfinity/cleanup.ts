// Pinfinity-Cleanup (Tracer der Pinfinity-Migration): löst die Edge Function
// cleanup-published-images ab. Loescht Bild-Dateien laengst veroeffentlichter Pins
// aus Pinfinitys Supabase Storage und nullt deren image_path.
// Die Orchestrierung hier ist rein und gegen den CleanupClient-Seam testbar;
// der Adapter auf das echte supabase-js folgt in derselben Datei (Task 3).

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
